import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { JavaInfo, Settings } from '../shared/types.js';
import { chooseJava, javaComponentFor } from './logic.js';
import { getSettings } from './store.js';
import { download, emit, json, root, runPool, type SendProgress } from './util.js';

const execFileAsync = promisify(execFile);
const JAVA_RUNTIME_INDEX = 'https://piston-meta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';
const exe = process.platform === 'win32' ? 'java.exe' : 'java';
const runtimesDir = () => join(root(), 'runtimes');
const runtimeJavaPath = (destination: string) => process.platform === 'darwin'
  ? [join(destination, 'bin', exe), join(destination, 'jre.bundle', 'Contents', 'Home', 'bin', exe), join(destination, 'Contents', 'Home', 'bin', exe)].find(existsSync) ?? join(destination, 'bin', exe)
  : join(destination, 'bin', exe);

/** Mojang publishes separate macOS runtimes for Intel and Apple Silicon. */
export function javaRuntimePlatform(): string {
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-os-arm64' : 'mac-os';
  if (process.platform === 'win32') return process.arch === 'arm64' ? 'windows-arm64' : 'windows-x64';
  if (process.platform === 'linux') return process.arch === 'arm64' ? 'linux-aarch64' : 'linux';
  return `${process.platform}-${process.arch}`;
}

export async function probeJava(path: string): Promise<JavaInfo | undefined> {
  try {
    const value = await execFileAsync(path, ['-version'], { timeout: 10000 });
    const match = `${value.stderr}\n${value.stdout}`.match(/version "([0-9]+)(?:\.([0-9]+))?/);
    if (!match) return undefined;
    return { path, version: match[1], major: Number(match[1]) === 1 ? Number(match[2]) : Number(match[1]) };
  } catch { return undefined; }
}

async function candidatePaths(): Promise<string[]> {
  const candidates = new Set<string>();
  if (process.env.JAVA_HOME) candidates.add(join(process.env.JAVA_HOME, 'bin', exe));
  candidates.add(exe);
  for (const name of await readdir(runtimesDir()).catch(() => [] as string[])) {
    candidates.add(join(runtimesDir(), name, 'bin', exe));
    if (process.platform === 'darwin') {
      candidates.add(join(runtimesDir(), name, 'jre.bundle', 'Contents', 'Home', 'bin', exe));
      candidates.add(join(runtimesDir(), name, 'Contents', 'Home', 'bin', exe));
    }
  }
  if (process.platform === 'win32') {
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean) as string[]) {
      for (const vendor of ['Java', 'Eclipse Adoptium', 'Microsoft', 'Zulu', 'BellSoft', 'Amazon Corretto', 'Semeru']) {
        for (const entry of await readdir(join(base, vendor)).catch(() => [] as string[])) candidates.add(join(base, vendor, entry, 'bin', exe));
      }
    }
  }
  return [...candidates];
}

export async function detectJava(): Promise<JavaInfo[]> {
  const found = await Promise.all((await candidatePaths()).map(path => (path === exe || existsSync(path) ? probeJava(path) : undefined)));
  const seen = new Set<string>();
  return found.filter((java): java is JavaInfo => !!java && !seen.has(`${java.major}:${java.path}`) && !!seen.add(`${java.major}:${java.path}`));
}

export async function installJavaRuntime(major: number, send?: SendProgress): Promise<JavaInfo> {
  const { component, major: actual } = javaComponentFor(major);
  const destination = join(runtimesDir(), `java-${actual}`);
  const marker = join(destination, '.xavi-complete');
  const existingJavaPath = runtimeJavaPath(destination);
  if (existsSync(marker) && existsSync(existingJavaPath)) return { path: existingJavaPath, version: String(actual), major: actual };

  const index = await json<Record<string, Record<string, { manifest: { url: string; sha1: string } }[]>>>(JAVA_RUNTIME_INDEX);
  const release = index[javaRuntimePlatform()]?.[component]?.[0];
  if (!release) throw new Error(`Mojang does not publish a Java ${actual} runtime for this platform.`);
  const manifest = await json<{ files: Record<string, { type: string; downloads?: { raw?: { url: string; sha1: string } }; executable?: boolean }> }>(release.manifest.url);
  const entries = Object.entries(manifest.files).filter(([, file]) => file.type === 'file' && file.downloads?.raw);
  let done = 0;
  await runPool(entries.map(([relative, file]) => async () => {
    const raw = file.downloads!.raw!;
    const target = join(destination, relative);
    await download(raw.url, target, { sha1: raw.sha1 });
    if (file.executable) await chmod(target, 0o755).catch(() => undefined);
    done++;
    if (done % 20 === 0 || done === entries.length) emit(send, `Installing Java ${actual} (${done}/${entries.length})`, done / entries.length);
  }));
  const javaPath = runtimeJavaPath(destination);
  if (!existsSync(javaPath)) throw new Error('The Java runtime download completed without a java executable.');
  await writeFile(marker, new Date().toISOString());
  return { path: javaPath, version: String(actual), major: actual };
}

/**
 * Picks a Java that fits the game version. A custom path from Settings is honoured only when it
 * satisfies the requirement. If nothing fits, the right Mojang runtime is downloaded.
 */
export async function ensureJava(required: number, send?: SendProgress, settings?: Settings): Promise<JavaInfo> {
  const config = settings ?? (await getSettings());
  const installed = await detectJava();
  if (config.javaPath && existsSync(config.javaPath)) {
    const custom = installed.find(java => java.path === config.javaPath) ?? (await probeJava(config.javaPath));
    if (custom && chooseJava([custom], required)) return custom;
    emit(send, `Your custom Java does not fit this version (needs Java ${required}); using a matching runtime instead.`, 0);
  }
  return chooseJava(installed, required) ?? installJavaRuntime(required, send);
}

/** The official launcher (and TLauncher) start the game with javaw.exe, the windowed Java. Some graphics-driver profiles are keyed on that name. */
export function windowedJava(path: string): string {
  if (process.platform !== 'win32') return path;
  const windowed = path.replace(/java\.exe$/i, 'javaw.exe');
  return windowed !== path && existsSync(windowed) ? windowed : path;
}

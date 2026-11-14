import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import AdmZip from 'adm-zip';
import type { Profile, Version } from '../shared/types.js';
import { compareVersions, coordinatePath, evaluateRules, fallbackJavaMajor, nativeClassifier, pickForgeVersion, pickNeoForgeVersion, type Rule } from './logic.js';
import { ensureJava } from './java.js';
import { ensureFabricApi } from './mods.js';
import { getSettings, profileGamePath, profilePath, saveProfile } from './store.js';
import { addWarning, download, emit, fetchTimeout, json, readJson, root, runPool, sendProgress, text, withProfileLock, writeJsonAtomic, type SendProgress } from './util.js';

const execFileAsync = promisify(execFile);
const MOJANG_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

type Artifact = { url: string; sha1?: string; size?: number; path?: string };
export type Library = { name: string; url?: string; sha1?: string; downloads?: { artifact?: Artifact; classifiers?: Record<string, Artifact> }; rules?: Rule[]; natives?: Record<string, string>; extract?: { exclude?: string[] } };
type Argument = string | { rules?: Rule[]; value: string | string[] };
export type MojangVersion = Version & {
  downloads: { client: { url: string; sha1: string; size: number } };
  assetIndex?: { id: string; url: string; sha1: string };
  assets: string; libraries: Library[]; mainClass: string;
  arguments?: { game?: Argument[]; jvm?: Argument[] };
  minecraftArguments?: string;
  logging?: { client?: { argument: string; file: { id: string; url: string; sha1: string; size: number } } };
};

/* -------------------------------- versions -------------------------------- */

export async function getVersions(): Promise<Version[]> {
  const cache = join(root(), 'version_manifest.json');
  try {
    const data = await json<{ versions: Version[] }>(MOJANG_MANIFEST);
    await writeJsonAtomic(cache, data).catch(() => undefined);
    return data.versions;
  } catch (error) {
    const cached = await readJson<{ versions: Version[] } | undefined>(cache, undefined);
    if (cached?.versions?.length) return cached.versions; // offline: use the last known list
    throw error;
  }
}

export const nativesDirectory = (profile: Profile) => join(profileGamePath(profile), 'natives', profile.version);

/* --------------------------------- vanilla -------------------------------- */

async function installVanilla(profile: Profile, manifest: MojangVersion, send: SendProgress) {
  const game = profileGamePath(profile);
  const versionDir = join(game, 'versions', profile.version);
  await mkdir(versionDir, { recursive: true });
  await writeJsonAtomic(join(versionDir, `${profile.version}.json`), manifest);

  const libraries = manifest.libraries.filter(library => evaluateRules(library.rules));
  const assetIndexPath = manifest.assetIndex ? join(game, 'assets', 'indexes', `${manifest.assetIndex.id}.json`) : undefined;
  const range = (value: number) => 0.05 + value * 0.7; // vanilla owns 5%..75% of the bar
  let step = 0;

  await download(manifest.downloads.client.url, join(versionDir, `${profile.version}.jar`), { sha1: manifest.downloads.client.sha1, onBytes: (received, total) => emit(send, 'Downloading Minecraft client', range((total ? received / total : 0) * 0.1)) });
  step = 0.1;

  if (manifest.assetIndex && assetIndexPath) {
    await download(manifest.assetIndex.url, assetIndexPath, { sha1: manifest.assetIndex.sha1 });
    const index = await readJson<{ objects: Record<string, { hash: string; size: number }>; map_to_resources?: boolean; virtual?: boolean }>(assetIndexPath, { objects: {} });
    const assets = Object.entries(index.objects);
    let completed = 0;
    await runPool(assets.map(([, asset]) => async () => {
      await download(`https://resources.download.minecraft.net/${asset.hash.slice(0, 2)}/${asset.hash}`, join(game, 'assets', 'objects', asset.hash.slice(0, 2), asset.hash), { sha1: asset.hash });
      completed++;
      if (completed % 25 === 0 || completed === assets.length) emit(send, `Downloading assets (${completed}/${assets.length})`, range(step + (completed / Math.max(1, assets.length)) * 0.6));
    }));
    step = 0.7;
  }

  // Libraries (artifacts) and, for old versions, native classifier jars that get extracted below.
  const natives: { artifact: Artifact; library: Library }[] = [];
  const tasks: (() => Promise<void>)[] = [];
  let finished = 0;
  const total = Math.max(1, libraries.length);
  const tick = () => { finished++; if (finished % 10 === 0 || finished === total) emit(send, 'Downloading libraries', range(step + (finished / total) * 0.3)); };
  for (const library of libraries) {
    const artifact = library.downloads?.artifact;
    const classifier = nativeClassifier(library.natives);
    const nativeArtifact = classifier ? library.downloads?.classifiers?.[classifier] : undefined;
    if (nativeArtifact) natives.push({ artifact: nativeArtifact, library });
    if (artifact) tasks.push(async () => { await download(artifact.url, join(game, 'libraries', artifact.path ?? coordinatePath(library.name)), { sha1: artifact.sha1 }); tick(); });
    else tasks.push(async () => { tick(); });
  }
  await runPool(tasks);

  if (natives.length) {
    const target = nativesDirectory(profile);
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    for (const { artifact, library } of natives) {
      const jar = join(game, 'libraries', artifact.path ?? coordinatePath(library.name));
      await download(artifact.url, jar, { sha1: artifact.sha1 });
      const exclude = library.extract?.exclude ?? ['META-INF/'];
      for (const entry of new AdmZip(jar).getEntries()) {
        if (entry.isDirectory || exclude.some(prefix => entry.entryName.startsWith(prefix))) continue;
        await writeFile(join(target, entry.entryName.split('/').pop()!), entry.getData());
      }
    }
  }

  const logging = manifest.logging?.client?.file;
  if (logging) await download(logging.url, join(game, 'assets', 'log_configs', logging.id), { sha1: logging.sha1 }).catch(() => undefined);
}

/* ---------------------------------- Fabric -------------------------------- */

function mergeArguments(base: MojangVersion['arguments'] | undefined, extra: MojangVersion['arguments'] | undefined) {
  const baseArguments = base || {};
  return {
    ...baseArguments, ...extra,
    ...(baseArguments.game || extra?.game ? { game: [...(baseArguments.game || []), ...(extra?.game || [])] } : {}),
    ...(baseArguments.jvm || extra?.jvm ? { jvm: [...(baseArguments.jvm || []), ...(extra?.jvm || [])] } : {})
  };
}

async function installFabric(profile: Profile, manifest: MojangVersion, send: SendProgress) {
  const versions = await json<{ loader: { version: string; stable: boolean } }[]>(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(profile.version)}`);
  const loader = profile.loaderVersion || versions.find(v => v.loader.stable)?.loader.version || versions[0]?.loader.version;
  if (!loader) throw new Error(`No Fabric loader is compatible with Minecraft ${profile.version}.`);
  profile.loaderVersion = loader;
  const profileJson = await json<Record<string, unknown>>(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(profile.version)}/${encodeURIComponent(loader)}/profile/json`);
  const versionId = `${profile.version}-fabric-${loader}`;
  const fabricLibraries = Array.isArray(profileJson.libraries) ? profileJson.libraries as Library[] : [];
  const game = profileGamePath(profile);
  await mkdir(join(game, 'versions', versionId), { recursive: true });
  await writeJsonAtomic(join(game, 'versions', versionId, `${versionId}.json`), {
    ...manifest, ...profileJson, id: versionId, inheritsFrom: profile.version,
    mainClass: profileJson.mainClass || manifest.mainClass,
    libraries: [...manifest.libraries, ...fabricLibraries],
    arguments: mergeArguments(manifest.arguments, profileJson.arguments as MojangVersion['arguments'])
  });
  // Pre-download Fabric's own libraries so the profile also launches offline. Failures are not fatal:
  // minecraft-launcher-core retries at launch time.
  await runPool(fabricLibraries.filter(library => library.url && !library.downloads).map(library => async () => {
    const path = coordinatePath(library.name);
    await download(`${library.url!.replace(/\/?$/, '/')}${path}`, join(game, 'libraries', path), { sha1: library.sha1 }).catch(() => undefined);
  }), 6);
  emit(send, `Installed Fabric ${loader}`, 0.9);
}

/* ------------------------------ Forge / NeoForge --------------------------- */

async function installerMetadata(profile: Profile): Promise<{ version?: string; url?: string }> {
  if (profile.loader === 'Forge') {
    const data = await json<Record<string, string[]>>('https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json');
    const wanted = profile.loaderVersion && !profile.loaderVersion.startsWith(`${profile.version}-`) ? `${profile.version}-${profile.loaderVersion}` : profile.loaderVersion;
    const version = wanted || pickForgeVersion(data[profile.version] || []);
    if (!version) {
      const supported = Object.keys(data).filter(key => /^1\.\d+(\.\d+)?$/.test(key)).sort((a, b) => compareVersions(a, b)).slice(-3).reverse();
      throw new Error(`Forge has no build for Minecraft ${profile.version} yet. Newest versions with Forge: ${supported.join(', ')}. Pick one of those or use Fabric.`);
    }
    return { version, url: version ? `https://maven.minecraftforge.net/net/minecraftforge/forge/${version}/forge-${version}-installer.jar` : undefined };
  }
  const xml = await text('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml');
  const all = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map(match => match[1]);
  const version = profile.loaderVersion || pickNeoForgeVersion(all, profile.version);
  return { version, url: version ? `https://maven.neoforged.net/releases/net/neoforged/neoforge/${version}/neoforge-${version}-installer.jar` : undefined };
}

async function installForgeLike(profile: Profile, manifest: MojangVersion, send: SendProgress, javaMajor: number) {
  const info = await installerMetadata(profile);
  if (!info.url || !info.version) throw new Error(`No compatible ${profile.loader} installer was found for Minecraft ${profile.version}.`);
  profile.loaderVersion = info.version;

  // The Maven repositories publish a .sha1 next to every artifact; refuse to run an unverified installer.
  const sha1 = (await text(`${info.url}.sha1`)).trim().split(/\s+/)[0];
  if (!/^[0-9a-f]{40}$/i.test(sha1)) throw new Error(`Could not read the checksum for the ${profile.loader} installer.`);
  const installer = join(profilePath(profile), `${profile.loader.toLowerCase()}-${info.version}-installer.jar`);
  await download(info.url, installer, { sha1, onBytes: (received, total) => emit(send, `Downloading ${profile.loader} installer`, 0.78 + (total ? received / total : 0) * 0.05) });

  const java = await ensureJava(javaMajor, send);
  const game = profileGamePath(profile);
  const launcherProfiles = join(game, 'launcher_profiles.json');
  if (!existsSync(launcherProfiles)) await writeJsonAtomic(launcherProfiles, { profiles: {}, settings: {}, version: 3 });
  emit(send, `Running the ${profile.loader} installer (this can take a few minutes)`, 0.84);
  try {
    await execFileAsync(java.path, ['-jar', installer, profile.loader === 'NeoForge' ? '--install-client' : '--installClient', game], { timeout: 600000, maxBuffer: 32 * 1024 * 1024 });
  } catch (error) {
    const detail = error as { stderr?: string; stdout?: string; message?: string };
    throw new Error(`${profile.loader} installer failed: ${detail.stderr?.trim() || detail.stdout?.trim() || detail.message || String(error)}`);
  }

  const loaderVersionId = info.version.startsWith(`${profile.version}-`) ? info.version.slice(profile.version.length + 1) : info.version;
  const dirs = await readdir(join(game, 'versions'), { withFileTypes: true });
  const generated = dirs.find(entry => entry.isDirectory() && entry.name.toLowerCase().includes(profile.loader.toLowerCase()) && entry.name.includes(loaderVersionId));
  if (!generated) throw new Error(`${profile.loader} installed but did not create a version profile for ${info.version}.`);
  const generatedPath = join(game, 'versions', generated.name, `${generated.name}.json`);
  const generatedJson = await readJson<Record<string, unknown> | undefined>(generatedPath, undefined);
  if (!generatedJson) throw new Error(`${profile.loader} installed but did not create ${generated.name}.json.`);
  const generatedLibraries = Array.isArray(generatedJson.libraries) ? generatedJson.libraries as Library[] : [];
  await writeJsonAtomic(generatedPath, {
    ...manifest, ...generatedJson, id: generated.name, inheritsFrom: profile.version,
    libraries: [...manifest.libraries, ...generatedLibraries],
    arguments: mergeArguments(manifest.arguments, generatedJson.arguments as MojangVersion['arguments'])
  });
  emit(send, `Installed ${profile.loader} ${info.version}`, 0.92);
}

/* --------------------------------- profile -------------------------------- */

export function installProfile(profile: Profile, send: SendProgress = sendProgress): Promise<void> {
  return withProfileLock(profile.id, async () => {
    await mkdir(join(root(), 'profiles'), { recursive: true });
    if (!profile.directory) profile.directory = join((await getSettings()).gameDirectory, profile.id);
    profile.installed = false;
    await saveProfile(profile);
    try {
      const versions = await getVersions();
      const selected = versions.find(version => version.id === profile.version);
      if (!selected) throw new Error(`Minecraft ${profile.version} is not in Mojang's official manifest.`);
      const manifest = await json<MojangVersion>(selected.url);
      emit(send, 'Reading official version metadata', 0.03);
      profile.javaMajor = manifest.javaVersion?.majorVersion ?? fallbackJavaMajor(profile.version);
      await installVanilla(profile, manifest, send);
      if (profile.loader === 'Fabric') await installFabric(profile, manifest, send);
      if (profile.loader === 'Forge' || profile.loader === 'NeoForge') await installForgeLike(profile, manifest, send, profile.javaMajor);
      if (profile.loader === 'Fabric') {
        emit(send, 'Installing Fabric API', 0.94);
        await ensureFabricApi(profile).catch(error => addWarning(`Fabric API was not installed automatically (${error instanceof Error ? error.message : error}). Install it from the Mods screen.`));
      }
      // Make sure the right Java exists now, so the first Play does not wait for a download.
      emit(send, 'Checking Java', 0.95);
      await ensureJava(profile.javaMajor, send);
      profile.installed = true;
      await saveProfile(profile);
      emit(send, 'Installation complete', 1);
    } catch (error) {
      profile.installed = false;
      await saveProfile(profile);
      throw error;
    }
  });
}

export { fetchTimeout };

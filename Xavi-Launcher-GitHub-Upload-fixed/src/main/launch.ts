import { BrowserWindow } from 'electron';
import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Account, Diagnostics, Profile, ProbeResult, TroubleshootOutcome } from '../shared/types.js';
import { compatibilityVariants, type LaunchVariant, type Rule } from './logic.js';
import { freshAccount } from './auth.js';
import { evaluateRules, fallbackJavaMajor, isPlayerName, isPrivateServerHost, offlineUuid, serverArguments, classifyCrash, classifyExit, describeJvmCrash, describeModule, parseFaultEvent, parseJvmArgs, parseServerAddress } from './logic.js';
import { createRequire } from 'node:module';
import { ensureJava, windowedJava } from './java.js';
import { syncSkins } from './skins.js';
import { nativesDirectory, type MojangVersion } from './install.js';
import { getLocalProfile, getSettings, profileGamePath, profilePath, recommendedRam, saveProfile } from './store.js';
import { readJson, sendProgress, sendToWindow, withProfileLock, writeJsonAtomic } from './util.js';

type VersionArguments = MojangVersion['arguments'];
const execFileAsync = promisify(execFile);

/** Asks the Windows Application event log which module crashed java/javaw in the last two minutes. */
async function windowsFault(): Promise<string | undefined> {
  if (process.platform !== 'win32') return undefined;
  try {
    const query = "*[System[Provider[@Name='Application Error'] and TimeCreated[timediff(@SystemTime) <= 120000]]]";
    const { stdout } = await execFileAsync('wevtutil', ['qe', 'Application', `/q:${query}`, '/c:5', '/rd:true', '/f:text'], { timeout: 8000, windowsHide: true });
    const fault = parseFaultEvent(stdout);
    return fault ? `${describeModule(fault.module)} (Windows: ${fault.application}, exception ${fault.code ?? '?'}, offset ${fault.offset ?? '?'})` : undefined;
  } catch { return undefined; }
}

/**
 * minecraft-launcher-core verifies Java by parsing the output of `java -version`, which javaw.exe never
 * prints. Xavi has already probed this exact Java, so the check is skipped for javaw.exe only.
 */
let javawAllowed = false;
export function allowWindowedJava() {
  if (javawAllowed) return;
  javawAllowed = true;
  const Handler = createRequire(import.meta.url)('minecraft-launcher-core/components/handler.js') as { prototype: { checkJava: (java: string) => Promise<{ run: boolean; message?: unknown }> } };
  const original = Handler.prototype.checkJava;
  Handler.prototype.checkJava = function (java: string) { return /javaw\.exe"?$/i.test(java) ? Promise.resolve({ run: true }) : original.call(this, java); };
}

/**
 * minecraft-launcher-core ignores the CPU architecture in library rules, so on 64-bit Windows it put
 * the arm64 native jars on the classpath next to the x64 ones. Remove every library that does not
 * apply to this machine before MCLC reads the version file.
 */
export async function pruneLibraries(file: string): Promise<void> {
  const data = await readJson<{ libraries?: { rules?: Rule[] }[] } | undefined>(file, undefined);
  if (!data?.libraries) return;
  const kept = data.libraries.filter(library => evaluateRules(library.rules));
  if (kept.length !== data.libraries.length) await writeJsonAtomic(file, { ...data, libraries: kept });
}

export async function getDiagnostics(profile: Profile): Promise<Diagnostics> {
  const latestLog = await readFile(join(profilePath(profile), 'latest.log'), 'utf8').catch(() => '');
  const crashDir = join(profileGamePath(profile), 'crash-reports');
  const files = await readdir(crashDir, { withFileTypes: true }).catch(() => []);
  const crashReports = await Promise.all(files.filter(file => file.isFile() && file.name.endsWith('.txt')).sort((a, b) => a.name.localeCompare(b.name)).slice(-5)
    .map(async file => ({ name: file.name, content: (await readFile(join(crashDir, file.name), 'utf8').catch(() => '')).slice(-20000) })));
  const gameFiles = await readdir(profileGamePath(profile)).catch(() => [] as string[]);
  const nativeLogs = await Promise.all(gameFiles.filter(name => /^hs_err_pid\d+\.log$/.test(name)).sort().slice(-2)
    .map(async name => ({ name, content: (await readFile(join(profileGamePath(profile), name), 'utf8').catch(() => '')).slice(0, 12000) })));
  return { latestLog: latestLog.slice(-30000), crashReports: [...crashReports, ...nativeLogs] };
}

export async function crashHint(profile: Profile, since: number, code: number): Promise<string | undefined> {
  const recentFiles = async (dir: string, pattern: RegExp) => {
    try {
      return (await Promise.all((await readdir(dir)).filter(name => pattern.test(name)).map(async name => ({ name, time: (await stat(join(dir, name))).mtimeMs }))))
        .filter(file => file.time >= since - 5000).sort((a, b) => b.time - a.time);
    } catch { return []; }
  };
  const nativeLog = (await recentFiles(profileGamePath(profile), /^hs_err_pid\d+\.log$/))[0];
  if (nativeLog) {
    const text = await readFile(join(profileGamePath(profile), nativeLog.name), 'utf8').catch(() => '');
    const hint = describeJvmCrash(text) ?? classifyCrash(text);
    if (hint) return hint;
  }
  const report = (await recentFiles(join(profileGamePath(profile), 'crash-reports'), /\.txt$/))[0];
  if (report) { const hint = classifyCrash(await readFile(join(profileGamePath(profile), 'crash-reports', report.name), 'utf8').catch(() => '')); if (hint) return hint; }
  const classified = classifyCrash((await readFile(join(profilePath(profile), 'latest.log'), 'utf8').catch(() => '')).slice(-30000));
  if (classified) return classified;
  return (await windowsFault()) ?? classifyExit(code);
}

async function mergeMissingArguments(dir: string, profile: Profile, versionJson: string) {
  const base = await readJson<Record<string, unknown>>(join(dir, 'versions', profile.version, `${profile.version}.json`), {});
  const custom = await readJson<Record<string, unknown>>(versionJson, {});
  const baseArguments = base.arguments as VersionArguments | undefined;
  const customArguments = custom.arguments as VersionArguments | undefined;
  if (baseArguments && (!customArguments?.game?.length || !customArguments?.jvm?.length)) {
    const merged = {
      ...baseArguments, ...customArguments,
      ...(baseArguments.game || customArguments?.game ? { game: [...(baseArguments.game || []), ...(customArguments?.game || [])] } : {}),
      ...(baseArguments.jvm || customArguments?.jvm ? { jvm: [...(baseArguments.jvm || []), ...(customArguments?.jvm || [])] } : {})
    };
    await writeJsonAtomic(versionJson, { ...custom, arguments: merged });
  }
}

export function launch(profile: Profile, account: Account, server?: string, onChild?: (child: ChildProcess) => void, override?: LaunchVariant, options?: { instance?: string }): Promise<void> {
  const instance = options?.instance;
  return withProfileLock(instance ? `${profile.id}:${instance}` : profile.id, async () => {
    if (!account?.name) throw new Error('Choose a player name before launching.');
    if (!profile.installed) throw new Error('Install this profile before launching it.');
    const destination = server ? parseServerAddress(server) : undefined;
    // Offline names may join servers on this PC or home network. Public servers need a Microsoft account that owns the game.
    if (account.accessToken === 'offline' && destination && !isPrivateServerHost(destination.host)) throw new Error('Public servers require a Microsoft account that owns Minecraft. Offline names can only join servers on this PC or your home network.');
    const dir = profileGamePath(profile);
    const gameDir = instance ? join(dir, 'instances', instance) : dir;
    if (instance) await prepareInstanceDirectory(dir, gameDir);
    const jar = join(dir, 'versions', profile.version, `${profile.version}.jar`);
    if (!existsSync(jar)) throw new Error('The Minecraft client is incomplete. Reinstall this profile.');

    const settings = await getSettings();
    const hardware = recommendedRam();
    const autoMax = settings.performanceMode === 'low' ? Math.min(1536, hardware.maxRam) : settings.performanceMode === 'high' ? Math.min(6144, Math.max(2048, hardware.available - 1536)) : hardware.maxRam;
    const configuredMax = override?.maxRam ?? (settings.performanceMode === 'balanced' ? settings.maxRam : autoMax);
    const maxRam = instance ? Math.min(configuredMax, 2048) : configuredMax;
    const minRam = Math.min(settings.minRam, Math.max(512, maxRam - 512));

    // Custom loader versions
    const loaderVersionId = profile.loaderVersion?.startsWith(`${profile.version}-`) ? profile.loaderVersion.slice(profile.version.length + 1) : profile.loaderVersion;
    const custom = profile.loader === 'Vanilla' ? undefined : profile.loader === 'NeoForge' ? `neoforge-${loaderVersionId || ''}` : `${profile.version}-${profile.loader.toLowerCase()}-${loaderVersionId || ''}`;
    const versionDirectory = join(dir, 'versions', custom ?? profile.version);
    const versionJson = custom ? join(versionDirectory, `${custom}.json`) : undefined;
    if (custom && versionJson && existsSync(versionJson)) await mergeMissingArguments(dir, profile, versionJson);
    await pruneLibraries(join(dir, 'versions', profile.version, `${profile.version}.json`));
    if (versionJson) await pruneLibraries(versionJson);
    const manifestPath = versionJson || join(dir, 'versions', profile.version, `${profile.version}.json`);
    const manifest = await readJson<MojangVersion>(manifestPath, {} as MojangVersion);

    // The right Java comes from the version manifest, never from "whatever is first on PATH".
    const required = manifest.javaVersion?.majorVersion ?? profile.javaMajor ?? fallbackJavaMajor(profile.version);
    const java = await ensureJava(required, sendProgress, settings);

    // User JVM arguments are validated. A troubleshooting probe replaces them for one launch.
    const userArgs = settings.jvmArgs.trim() ? parseJvmArgs(settings.jvmArgs) : [];
    const customArgs = override ? override.jvmArgs : userArgs.length ? userArgs : undefined;

    await syncSkins(profile, account.name, settings).catch(() => undefined); // skins are optional; never block a launch

    // Always keep the JVM's own crash report inside the game folder, where Xavi can find and explain it.
    const crashFile = `-XX:ErrorFile=${join(dir, 'hs_err_pid%p.log')}`;
    const jvmArguments = [...(customArgs ?? []), crashFile];
    allowWindowedJava();
    const executable = windowedJava(java.path);

    const startedAt = Date.now();
    const logFile = join(profilePath(profile), instance ? `latest-${instance}.log` : 'latest.log');
    await writeFile(logFile, ''); // truncate: "latest" really means this launch
    let queue: Promise<void> = Promise.resolve();
    const log = (line: string) => {
      queue = queue.then(() => appendFile(logFile, line)).catch(() => undefined);
      sendToWindow('game-log', { profileId: profile.id, line });
    };

    const { Client } = await import('minecraft-launcher-core');
    const launcher = new Client();
    launcher.on('debug', (line: string) => log(`[launcher] ${line}\n`));
    launcher.on('close', async (code: number) => {
      log(`[launcher] Minecraft exited with code ${code}.\n`);
      if (override || instance) return; // probes and extra players report on their own
      const window = BrowserWindow.getAllWindows()[0];
      if (window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.show(); }
      const hint = code === 0 ? undefined : await crashHint(profile, startedAt, code);
      if (hint) log(`[launcher] Crash analysis: ${hint}\n`);
      sendToWindow('game-exit', { profileId: profile.id, code, hint });
    });
    log(`[launcher] Player: ${account.name}, version: ${profile.version}, loader: ${profile.loader}, java ${java.major}: ${executable}\n`);
    log(`[launcher] Hardware: ${hardware.available} MB RAM, ${hardware.cores} CPU cores; memory: ${minRam}-${maxRam} MB (${settings.performanceMode}).\n`);

    const child = await launcher.launch({
      authorization: { access_token: account.accessToken, client_token: account.uuid, uuid: account.uuid, name: account.name, user_properties: {}, meta: { type: account.accessToken === 'offline' ? 'mojang' : 'msa' } },
      root: dir,
      version: { number: profile.version, type: 'release', ...(custom ? { custom } : {}) },
      memory: { max: `${maxRam}M`, min: `${minRam}M` },
      javaPath: executable,
      customArgs: jvmArguments,
      customLaunchArgs: destination ? serverArguments(destination, profile.version) : undefined,
      overrides: { gameDirectory: gameDir, directory: versionDirectory, versionJson, minecraftJar: jar, assetIndex: manifest.assetIndex?.id || profile.version, natives: nativesDirectory(profile), detached: true }
    });
    if (!child) throw new Error(`Minecraft could not start. See ${logFile} for details.`);
    onChild?.(child);
    child.on('error', error => log(`[launcher] Process error: ${error.message}\n`));
    child.stdout?.on('data', chunk => log(String(chunk)));
    child.stderr?.on('data', chunk => log(String(chunk)));
    // Minimise instead of closing: closing would quit Xavi and lose the log and exit events.
    if (settings.closeOnLaunch && !override && !instance) BrowserWindow.getAllWindows()[0]?.minimize();
    if (!instance) {
      profile.lastPlayed = new Date().toISOString();
      await saveProfile(profile);
    }
  });
}

/** Used by the IPC layer: the renderer only says "offline or Microsoft"; tokens never leave the main process. */
export async function launchForRenderer(profile: Profile, requested: Pick<Account, 'accessToken'> | undefined, server?: string) {
  let account: Account;
  if (requested?.accessToken === 'offline') {
    const local = await getLocalProfile();
    account = { name: local.name, uuid: local.uuid, accessToken: 'offline', expiresAt: Number.MAX_SAFE_INTEGER };
  } else account = await freshAccount();
  await launch(profile, account, server);
}


/**
 * Tries option sets one by one (each for up to 30 s) and returns as soon as one keeps the game alive.
 * The game window opens during the test. Once an option set survives the probe,
 * that working game process is kept open so the user can play immediately.
 */
export async function troubleshootLaunch(profile: Profile, onWorking?: (variant: LaunchVariant) => Promise<void>): Promise<TroubleshootOutcome> {
  const local = await getLocalProfile();
  const account: Account = { name: local.name, uuid: local.uuid, accessToken: 'offline', expiresAt: Number.MAX_SAFE_INTEGER };
  const settings = await getSettings();
  const java = await ensureJava(profile.javaMajor ?? fallbackJavaMajor(profile.version), sendProgress, settings);
  const variants = compatibilityVariants(java.major);
  const results: ProbeResult[] = [];
  for (const [index, variant] of variants.entries()) {
    sendProgress({ label: `Testing ${index + 1}/${variants.length}: ${variant.label}`, percent: index / variants.length });
    const startedAt = Date.now();
    let child: ChildProcess | undefined;
    try { await launch(profile, account, undefined, started => { child = started; }, variant); } catch (error) {
      results.push({ label: variant.label, ok: false, seconds: 0, hint: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const outcome = await new Promise<'alive' | number>(resolve => {
      const timer = setTimeout(() => resolve('alive'), 30000);
      child?.once('exit', code => { clearTimeout(timer); resolve(code ?? -1); });
      if (!child) { clearTimeout(timer); resolve(-1); }
    });
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    if (outcome === 'alive') {
      results.push({ label: variant.label, ok: true, seconds });
      await onWorking?.(variant);
      return { results, applied: variant.label };
    }
    results.push({ label: variant.label, ok: false, seconds, hint: await crashHint(profile, startedAt, outcome) });
  }
  return { results };
}


/** Separate game folder for an extra player; mods and config are shared with the main profile through junctions. */
export async function prepareInstanceDirectory(baseDir: string, instanceDir: string): Promise<void> {
  await mkdir(instanceDir, { recursive: true });
  for (const shared of ['mods', 'config']) {
    const source = join(baseDir, shared);
    const link = join(instanceDir, shared);
    if (!existsSync(source) || existsSync(link)) continue;
    await symlink(source, link, 'junction').catch(() => undefined); // best effort: the extra player still starts without shared mods
  }
}

/**
 * Starts a second copy of the profile with another local name that joins a server on this PC or home
 * network (for example your own test server). It sends a name only; it never contacts Mojang for a session.
 */
export async function launchSecondPlayer(profile: Profile, name: string, server: string): Promise<void> {
  if (!isPlayerName(name)) throw new Error('Player names use 3-16 letters, digits or underscores.');
  const main = await getLocalProfile();
  if (name.toLowerCase() === main.name.toLowerCase()) throw new Error('Pick a different name from your main player.');
  const destination = parseServerAddress(server);
  if (!isPrivateServerHost(destination.host)) throw new Error('Extra offline players can only join servers on this PC or your home network.');
  await launch(profile, { name, uuid: offlineUuid(name), accessToken: 'offline', expiresAt: Number.MAX_SAFE_INTEGER }, server, undefined, undefined, { instance: name });
}

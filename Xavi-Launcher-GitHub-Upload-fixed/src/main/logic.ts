import { createHash } from 'node:crypto';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

/* ------------------------------------------------------------------ */
/* Mojang library rules                                                */
/* ------------------------------------------------------------------ */

export type Rule = { action: 'allow' | 'disallow'; os?: { name?: string; arch?: string; version?: string }; features?: Record<string, boolean> };
export type RuleEnv = { os: 'windows' | 'linux' | 'osx'; arch: 'x86' | 'x64' | 'arm64' };

export function currentEnv(): RuleEnv {
  const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
  const arch = process.arch === 'ia32' ? 'x86' : process.arch === 'arm64' ? 'arm64' : 'x64';
  return { os, arch };
}

/**
 * Mojang semantics: with no rules a library is allowed. Otherwise the default is
 * "disallow" and rules are applied in order, the LAST matching rule wins.
 * Rules that depend on launcher features never match for libraries.
 */
export function evaluateRules(rules: Rule[] | undefined, env: RuleEnv = currentEnv()): boolean {
  if (!rules?.length) return true;
  let allowed = false;
  for (const rule of rules) {
    if (rule.features && Object.keys(rule.features).length) continue;
    const osMatches = !rule.os || ((!rule.os.name || rule.os.name === env.os) && (!rule.os.arch || rule.os.arch === env.arch));
    if (osMatches) allowed = rule.action === 'allow';
  }
  return allowed;
}

/** Returns the classifier key (e.g. natives-windows) for a legacy native library. */
export function nativeClassifier(natives: Record<string, string> | undefined, env: RuleEnv = currentEnv()): string | undefined {
  const value = natives?.[env.os];
  return value?.replace('${arch}', env.arch === 'x86' ? '32' : '64');
}

export function coordinatePath(name: string): string {
  const [group, artifact, version, classifier] = name.split(':');
  return [...group.split('.'), artifact, version, `${artifact}-${version}${classifier ? `-${classifier}` : ''}.jar`].join('/');
}

/* ------------------------------------------------------------------ */
/* Version comparison and loader selection                             */
/* ------------------------------------------------------------------ */

export function compareVersions(a: string, b: string): number {
  const left = a.split(/[.+-]/);
  const right = b.split(/[.+-]/);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i];
    const y = right[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      if (Number(x) !== Number(y)) return Number(x) - Number(y);
    } else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

const isPrerelease = (version: string) => /-(alpha|beta|rc|snapshot|pre)/i.test(version);

/** NeoForge builds are named <minor>.<patch>.<build> for Minecraft 1.<minor>.<patch>. */
export function neoForgePrefix(minecraft: string): string | undefined {
  const legacy = /^1\.(\d+)(?:\.(\d+))?$/.exec(minecraft);
  if (legacy) return `${legacy[1]}.${legacy[2] ?? '0'}.`;
  if (/^\d+\.\d+(\.\d+)?$/.test(minecraft)) return `${minecraft}.`;
  return undefined;
}

export function pickNeoForgeVersion(all: string[], minecraft: string): string | undefined {
  const prefix = neoForgePrefix(minecraft);
  if (!prefix) return undefined;
  const candidates = all.filter(version => version.startsWith(prefix));
  const stable = candidates.filter(version => !isPrerelease(version));
  const pool = stable.length ? stable : candidates;
  return [...pool].sort(compareVersions).at(-1);
}

/** Forge metadata entries look like 1.21.1-52.1.21. Pick the highest build. */
export function pickForgeVersion(entries: string[]): string | undefined {
  const build = (entry: string) => entry.slice(entry.indexOf('-') + 1);
  return [...entries].sort((a, b) => compareVersions(build(a), build(b))).at(-1);
}

/* ------------------------------------------------------------------ */
/* Java                                                                */
/* ------------------------------------------------------------------ */

/** Used only when the version manifest has no javaVersion (very old releases). */
export function fallbackJavaMajor(version: string): number {
  if (/^2\d\./.test(version) && Number(version.split('.')[0]) >= 26) return 25;
  const [major, minor, patch] = version.split('.').map(Number);
  if (major === 1 && (minor > 20 || (minor === 20 && (patch || 0) >= 5))) return 21;
  if (major === 1 && minor >= 17) return 17;
  return 8;
}

export function javaComponentFor(major: number): { component: string; major: number } {
  if (major <= 8) return { component: 'jre-legacy', major: 8 };
  if (major <= 17) return { component: 'java-runtime-gamma', major: 17 };
  if (major <= 21) return { component: 'java-runtime-delta', major: 21 };
  return { component: 'java-runtime-epsilon', major: 25 };
}

/**
 * Old Minecraft (Java 8) and old loaders break on newer JVMs, so a requirement of 8 only
 * accepts Java 8. For 16 and above any newer JVM is fine; the smallest sufficient one wins.
 */
export function chooseJava<T extends { major: number }>(installed: T[], required: number): T | undefined {
  const exact = installed.find(java => java.major === required);
  if (exact) return exact;
  if (required < 16) return undefined;
  return installed.filter(java => java.major >= required).sort((a, b) => a.major - b.major)[0];
}

/* ------------------------------------------------------------------ */
/* Paths and file names                                                */
/* ------------------------------------------------------------------ */

export const safeFileName = (value: string) => basename(value.replace(/\\/g, '/')).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
export const isPlainFileName = (value: string) => typeof value === 'string' && value.length > 0 && value.length < 256 && value === basename(value) && !/[<>:"/\\|?*\u0000-\u001f]/.test(value) && value !== '.' && value !== '..';

/** True when candidate is strictly inside base. */
export function inside(base: string, candidate: string): boolean {
  const rel = relative(resolve(base), resolve(candidate));
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

export const safeRelative = (value: string) => value.replace(/\\/g, '/').split('/').filter(part => part && part !== '.' && part !== '..').join(sep);

export function joinInside(base: string, relativePath: string): string {
  const target = join(base, safeRelative(relativePath));
  if (!safeRelative(relativePath) || !inside(base, target)) throw new Error(`Unsafe path: ${relativePath}`);
  return target;
}

/* ------------------------------------------------------------------ */
/* Identity, servers                                                   */
/* ------------------------------------------------------------------ */

export const normalizeLocalName = (value: string) => value.replace(/[^A-Za-z0-9_]/g, '').slice(0, 16) || 'OfflinePlayer';

export function offlineUuid(name: string): string {
  const bytes = createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x30;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytes.toString('hex');
}

export function parseServerAddress(value: string): { host: string; port: number } {
  const address = value.trim();
  if (!address) throw new Error('Enter a server address.');
  let host = address;
  let port = 25565;
  if (address.startsWith('[')) {
    const closing = address.indexOf(']');
    if (closing < 0) throw new Error('Invalid IPv6 server address.');
    host = address.slice(1, closing);
    if (address[closing + 1] === ':') port = Number(address.slice(closing + 2));
  } else {
    const separator = address.lastIndexOf(':');
    if (separator > -1 && address.indexOf(':') === separator) {
      host = address.slice(0, separator);
      port = Number(address.slice(separator + 1));
    }
  }
  if (!host || /[\s/\\]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Server address must use host[:port], with a port from 1 to 65535.');
  return { host, port };
}

/* ------------------------------------------------------------------ */
/* Downloads                                                           */
/* ------------------------------------------------------------------ */

const MODPACK_HOSTS = new Set(['cdn.modrinth.com', 'github.com', 'raw.githubusercontent.com', 'gitlab.com']);

export function isAllowedModpackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && MODPACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export const isModrinthCdn = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'cdn.modrinth.com';
  } catch {
    return false;
  }
};

export type Hashes = { sha1?: string; sha512?: string };

/** Returns undefined when no hash is available to compare against. */
export function hashesMatch(bytes: Uint8Array, hashes: Hashes | undefined): boolean | undefined {
  if (hashes?.sha512) return createHash('sha512').update(bytes).digest('hex') === hashes.sha512.toLowerCase();
  if (hashes?.sha1) return createHash('sha1').update(bytes).digest('hex') === hashes.sha1.toLowerCase();
  return undefined;
}

/* ------------------------------------------------------------------ */
/* JVM arguments                                                       */
/* ------------------------------------------------------------------ */

const FORBIDDEN_JVM = /^(-javaagent|-agentlib|-agentpath|-Xbootclasspath|-cp$|-classpath$|--class-path|--module-path|-p$|--add-modules|--patch-module|-XX:OnError|-XX:OnOutOfMemoryError|-XX:Flight|-XX:\+?UnlockDiagnosticVMOptions)/i;

/** Parses user JVM args, rejecting options that can load arbitrary code. */
export function parseJvmArgs(value: string): string[] {
  const tokens = value.split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    if (!token.startsWith('-')) throw new Error(`JVM argument must start with "-": ${token}`);
    if (FORBIDDEN_JVM.test(token)) throw new Error(`JVM argument is not allowed: ${token}`);
  }
  return tokens;
}

/* ------------------------------------------------------------------ */
/* Crash classification                                                */
/* ------------------------------------------------------------------ */

const CRASH_PATTERNS: { test: RegExp; hint: string }[] = [
  { test: /UnsupportedClassVersionError|compiled by a more recent version of the Java Runtime/i, hint: 'Wrong Java version: this game or mod needs a newer Java. Xavi picks Java automatically; remove a custom Java path in Settings.' },
  { test: /OutOfMemoryError|Java heap space|GC overhead limit/i, hint: 'Out of memory: raise Maximum RAM in Settings (and set the memory mode to Balanced).' },
  { test: /Mixin apply failed|MixinApplyError|InvalidMixinException|MixinTransformerError|Mixin transformation of/i, hint: 'A mod failed to apply a Mixin. Usually a mod is built for another Minecraft version or conflicts with another mod. Disable recently added mods.' },
  { test: /Mod resolution failed|Missing or unsupported mandatory dependencies|Incompatible mods found|ModResolutionException|Could not find required mod|requires any version of|depends on mod|DuplicateModsFoundException/i, hint: 'A mod is missing a dependency, duplicated, or incompatible with this version/loader. Check the mod list in Mods.' },
  { test: /EXCEPTION_ACCESS_VIOLATION|0xc0000005|hs_err_pid|Failed to initialize GLFW|GLFW error/i, hint: 'The game or graphics driver crashed. Update your graphics driver and try again without shader or rendering mods.' }
];

export function classifyCrash(text: string): string | undefined {
  return CRASH_PATTERNS.find(pattern => pattern.test.test(text))?.hint;
}

/* ------------------------------------------------------------------ */
/* Skins                                                               */
/* ------------------------------------------------------------------ */

/** A skin URL pattern such as https://host/skins/{USERNAME}.png (https only, no spaces or quotes). */
export function isValidSkinSource(value: string): boolean {
  if (!value.includes('{USERNAME}') || /[\s"'<>\\]/.test(value)) return false;
  try { return new URL(value.replace('{USERNAME}', 'Steve')).protocol === 'https:'; } catch { return false; }
}

/** Reads the PNG header. Minecraft skins are 64x64 (or legacy 64x32). */
export function readSkinPng(bytes: Uint8Array): { width: number; height: number } {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 33 || signature.some((value, index) => bytes[index] !== value)) throw new Error('Skins must be PNG files.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width !== 64 || (height !== 64 && height !== 32)) throw new Error(`Skin must be 64x64 (or 64x32) pixels; this image is ${width}x${height}.`);
  return { width, height };
}

/** CustomSkinLoader configuration. Local skin first, optional shared friends source, then Mojang. */
export function skinLoaderConfig(friendsSource?: string) {
  return {
    _xavi: true,
    enable: true,
    loadlist: [
      { name: 'LocalSkin', type: 'Legacy', checkPNGHash: false, skin: 'LocalSkin/skins/{USERNAME}.png', model: 'auto', cape: 'LocalSkin/capes/{USERNAME}.png', elytra: 'LocalSkin/capes/{USERNAME}.png' },
      ...(friendsSource ? [{ name: 'XaviFriends', type: 'Legacy', checkPNGHash: false, skin: friendsSource, model: 'auto' }] : []),
      { name: 'Mojang', type: 'MojangAPI' }
    ]
  };
}

/** Modpack dependency keys -> loader. */
export function loaderFromDependencies(dependencies: Record<string, string> | undefined): { loader: 'Fabric' | 'Forge' | 'NeoForge'; loaderVersion: string } | undefined {
  if (!dependencies) return undefined;
  if (dependencies['fabric-loader']) return { loader: 'Fabric', loaderVersion: dependencies['fabric-loader'] };
  if (dependencies['neoforge']) return { loader: 'NeoForge', loaderVersion: dependencies['neoforge'] };
  if (dependencies['forge']) return { loader: 'Forge', loaderVersion: dependencies['forge'] };
  return undefined;
}

const NATIVE_OWNERS: [RegExp, string][] = [
  [/atio6axx|atig6pxx|atiumd|amdxx|aticfx|amdvlk|amdgpu/i, 'the AMD graphics driver'],
  [/nvoglv|nvwgf|nvd3dum|nvlddmkm/i, 'the NVIDIA graphics driver'],
  [/ig\w*icd|igd\w*umd|igxelpicd|igc\d*/i, 'the Intel graphics driver'],
  [/jvm\.dll/i, 'the Java runtime itself'],
  [/lwjgl|glfw|SDL3?\.dll|OpenAL/i, 'a native Minecraft library (LWJGL, SDL or OpenAL)']
];

export function describeModule(module: string): string {
  const owner = NATIVE_OWNERS.find(([pattern]) => pattern.test(module))?.[1];
  return owner
    ? `The game crashed inside ${owner} (${module}). Update or clean-install that driver, then try again; if it keeps happening, try another Minecraft version.`
    : `The game crashed inside ${module}. See the hs_err_pid log in Settings → diagnostics.`;
}

/** Reads a JVM hs_err_pid log and names the module that crashed. */
export function describeJvmCrash(text: string): string | undefined {
  const module = /Problematic frame:\s*\n#\s*[CVjJ]\s+\[([^\]+]+)/i.exec(text)?.[1] ?? /^#\s*C\s+\[([^\]+]+)/m.exec(text)?.[1];
  return module ? describeModule(module) : undefined;
}

/** Parses `wevtutil qe Application /f:text` output for a crash of java.exe/javaw.exe. */
export function parseFaultEvent(text: string): { application: string; module: string; code?: string; offset?: string } | undefined {
  for (const block of text.split(/^Event\[\d+\]:/m)) {
    const application = /Faulting application name:\s*([^,\r\n]+)/i.exec(block)?.[1]?.trim();
    const module = /Faulting module name:\s*([^,\r\n]+)/i.exec(block)?.[1]?.trim();
    if (!application || !module || !/^javaw?\.exe$/i.test(application)) continue;
    return { application, module, code: /Exception code:\s*(\S+)/i.exec(block)?.[1], offset: /Fault offset:\s*(\S+)/i.exec(block)?.[1] };
  }
  return undefined;
}

/** Windows exit codes that mean a native crash rather than a Java exception. */
export function classifyExit(code: number): string | undefined {
  if (code === 3221225477 || code === -1073741819) return 'Windows reported a memory access violation (0xC0000005). This is almost always a graphics-driver or native-library crash, not a mod: update your GPU driver and test a different Minecraft version. To see the exact file that crashed, open Event Viewer → Windows Logs → Application and read the newest "Application Error" for java.exe/javaw.exe ("Faulting module name").';
  if (code === 3221226505 || code === -1073740791) return 'Windows reported a stack buffer overrun (0xC0000409), usually a graphics-driver or native-library crash. Update your GPU driver and test a different Minecraft version.';
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Startup-crash troubleshooting                                       */
/* ------------------------------------------------------------------ */

export type LaunchVariant = { label: string; jvmArgs: string[]; maxRam?: number };

/**
 * Option sets Xavi tries, least invasive first, when the game dies at startup with a native crash.
 * The first one that keeps the game alive is saved to Settings.
 */
export function compatibilityVariants(javaMajor: number): LaunchVariant[] {
  const variants: LaunchVariant[] = [
    { label: 'Default Java options', jvmArgs: [] },
    { label: 'Class-data sharing off', jvmArgs: ['-Xshare:off'] }
  ];
  if (javaMajor >= 24) variants.push({ label: 'Allow native/legacy memory access (Java 24+)', jvmArgs: ['--enable-native-access=ALL-UNNAMED', '--sun-misc-unsafe-memory-access=allow'] });
  variants.push(
    { label: 'Smaller heap (2 GB)', jvmArgs: [], maxRam: 2048 },
    { label: 'Class-data sharing off + smaller heap', jvmArgs: ['-Xshare:off'], maxRam: 2048 },
    { label: 'C1 compiler only', jvmArgs: ['-XX:TieredStopAtLevel=1'] },
    { label: 'Interpreter only (slow, last resort)', jvmArgs: ['-Xint'] }
  );
  return variants;
}

/* ------------------------------------------------------------------ */
/* Second player / server arguments                                    */
/* ------------------------------------------------------------------ */

/** Servers on this PC or home network. Offline names may join these; public servers need a Microsoft account. */
export function isPrivateServerHost(host: string): boolean {
  const value = host.toLowerCase();
  if (value === 'localhost' || value === '::1' || value.endsWith('.local')) return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (!match) return false;
  const [a, b, c, d] = match.slice(1).map(Number);
  if ([a, b, c, d].some(part => part > 255)) return false;
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

export const isPlayerName = (value: string) => /^[A-Za-z0-9_]{3,16}$/.test(value);

/** Minecraft 1.20+ (and the 26.x numbering) join with --quickPlayMultiplayer; older versions use --server/--port. */
export function serverArguments(destination: { host: string; port: number }, version: string): string[] {
  const match = /^(\d+)\.(\d+)/.exec(version);
  const quickPlay = !!match && (Number(match[1]) >= 26 || (Number(match[1]) === 1 && Number(match[2]) >= 20));
  const address = destination.host.includes(':') ? `[${destination.host}]:${destination.port}` : `${destination.host}:${destination.port}`;
  return quickPlay ? ['--quickPlayMultiplayer', address] : ['--server', destination.host, '--port', String(destination.port)];
}

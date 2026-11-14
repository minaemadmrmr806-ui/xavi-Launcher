import { safeStorage } from 'electron';
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import type { Account, LocalProfile, Profile, ProfileRef, Server, Settings } from '../shared/types.js';
import { inside, normalizeLocalName, offlineUuid, parseServerAddress } from './logic.js';
import { backupRoot, profileRoot, readJson, root, withProfileLock, writeJsonAtomic } from './util.js';

const settingsFile = () => join(root(), 'settings.json');
const accountFile = () => join(root(), 'account.json');
const localProfileFile = () => join(root(), 'local-profile.json');
const serversFile = () => join(root(), 'servers.json');

/* -------------------------------- settings -------------------------------- */

export function recommendedRam() {
  const available = Math.floor(totalmem() / 1024 / 1024);
  const maxRam = available <= 6144 ? 1536 : available <= 12288 ? 3072 : available <= 24576 ? 4096 : 6144;
  return { minRam: available <= 6144 ? 768 : 1024, maxRam: Math.min(maxRam, Math.max(1024, available - 2048)), cores: cpus().length, available };
}

export const defaultSettings = (): Settings => {
  const ram = recommendedRam();
  return { minRam: ram.minRam, maxRam: ram.maxRam, javaPath: '', gameDirectory: join(root(), 'game'), closeOnLaunch: false, microsoftClientId: '', performanceMode: 'auto', jvmArgs: '', skinSource: '' };
};

export async function getSettings(): Promise<Settings> {
  return { ...defaultSettings(), ...(await readJson<Partial<Settings>>(settingsFile(), {})) };
}

/** Directories the user picked through a native dialog. Only these may become the game directory. */
const approvedDirectories = new Set<string>();
export const approveDirectory = (directory: string) => { approvedDirectories.add(resolve(directory)); };

export async function saveSettings(value: Settings): Promise<Settings> {
  const current = await getSettings();
  const settings: Settings = { ...defaultSettings(), ...value };
  if (resolve(settings.gameDirectory) !== resolve(current.gameDirectory) && !approvedDirectories.has(resolve(settings.gameDirectory))) {
    throw new Error('Choose the game directory with the Browse button.');
  }
  await mkdir(settings.gameDirectory, { recursive: true });
  await writeJsonAtomic(settingsFile(), settings);
  return settings;
}

export async function getPaths() {
  const settings = await getSettings();
  return { root: profileRoot(), gameDirectory: settings.gameDirectory };
}

/* ---------------------------------- account ------------------------------- */

type StoredAccount = Omit<Account, 'accessToken' | 'refreshToken'> & { accessToken: string; refreshToken?: string; encrypted?: true };

function seal(value: string): string {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is unavailable on this system, so Xavi will not save Microsoft tokens.');
  return safeStorage.encryptString(value).toString('base64');
}
const unseal = (value: string) => safeStorage.decryptString(Buffer.from(value, 'base64'));

export async function saveAccount(account: Account): Promise<Account> {
  const stored: StoredAccount = account.accessToken === 'offline'
    ? account
    : { ...account, accessToken: seal(account.accessToken), refreshToken: account.refreshToken ? seal(account.refreshToken) : undefined, encrypted: true };
  await writeJsonAtomic(accountFile(), stored);
  return account;
}

/** The real account including tokens. Only the main process may use this. */
export async function getAccountSecret(): Promise<Account | undefined> {
  const stored = await readJson<StoredAccount | undefined>(accountFile(), undefined);
  if (!stored) return undefined;
  if (stored.accessToken === 'offline') return stored;
  if (!stored.encrypted) { // legacy plaintext file: migrate to encrypted storage
    const legacy = stored as Account;
    await saveAccount(legacy).catch(() => undefined);
    return legacy;
  }
  try { return { ...stored, accessToken: unseal(stored.accessToken), refreshToken: stored.refreshToken ? unseal(stored.refreshToken) : undefined }; } catch { return undefined; }
}

/** What the renderer is allowed to see: no tokens. */
export const redactAccount = (account: Account): Account => ({ ...account, accessToken: account.accessToken === 'offline' ? 'offline' : 'msa', refreshToken: undefined });
export async function getAccount(): Promise<Account | undefined> {
  const account = await getAccountSecret();
  return account && redactAccount(account);
}

/* ------------------------------ local profile ----------------------------- */

export async function saveLocalProfile(value: LocalProfile): Promise<LocalProfile> {
  const name = normalizeLocalName(value.name);
  const profile = { name, uuid: /^[0-9a-f]{32}$/i.test(value.uuid) ? value.uuid.toLowerCase() : offlineUuid(name) };
  await writeJsonAtomic(localProfileFile(), profile);
  return profile;
}

export async function getLocalProfile(): Promise<LocalProfile> {
  const saved = await readJson<LocalProfile | undefined>(localProfileFile(), undefined);
  if (saved?.name && saved?.uuid) {
    const name = normalizeLocalName(saved.name);
    // Early Xavi builds derived the UUID from the characters of "OfflinePlayer:<name>" instead of the
    // standard MD5 UUID. Switch to the standard one so saves and offline servers match other launchers.
    if (/^4f66666c696e65506c617965723a/i.test(saved.uuid)) return saveLocalProfile({ name, uuid: offlineUuid(name) });
    return { name, uuid: saved.uuid };
  }
  const legacy = await getAccountSecret();
  const name = normalizeLocalName(legacy?.accessToken === 'offline' ? legacy.name : 'OfflinePlayer');
  return saveLocalProfile({ name, uuid: legacy?.accessToken === 'offline' && legacy.uuid ? legacy.uuid : offlineUuid(name) });
}

/* --------------------------------- servers -------------------------------- */

export const getServers = () => readJson<Server[]>(serversFile(), []);

export async function saveServer(server: Server): Promise<Server[]> {
  const parsed = parseServerAddress(server.address);
  const normalized = { ...server, address: parsed.port === 25565 ? parsed.host : `${parsed.host}:${parsed.port}` };
  const list = (await getServers()).filter(item => item.id !== normalized.id && item.address.toLowerCase() !== normalized.address.toLowerCase());
  list.unshift(normalized);
  await writeJsonAtomic(serversFile(), list);
  return list;
}

export async function removeServer(id: string): Promise<Server[]> {
  const list = (await getServers()).filter(item => item.id !== id);
  await writeJsonAtomic(serversFile(), list);
  return list;
}

/* --------------------------------- profiles ------------------------------- */

export const profilePath = (profile: Pick<Profile, 'id'>) => join(profileRoot(), profile.id);
const legacyGamePath = (profile: Profile) => join(profilePath(profile), 'game');
export function profileGamePath(profile: Profile) {
  const legacy = legacyGamePath(profile);
  if (!profile.directory) return legacy;
  return existsSync(legacy) && !existsSync(profile.directory) ? legacy : profile.directory;
}
export const profileDirectory = profileGamePath;

export const saveProfile = (profile: Profile) => writeJsonAtomic(join(profilePath(profile), 'profile.json'), profile);

export async function listProfiles(): Promise<Profile[]> {
  await mkdir(profileRoot(), { recursive: true });
  const entries = await readdir(profileRoot(), { withFileTypes: true });
  const result: Profile[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const value = await readJson<Profile | undefined>(join(profileRoot(), entry.name, 'profile.json'), undefined);
    if (value) result.push(value);
  }
  return result;
}

/**
 * The renderer only names a profile; everything that matters (directory, install state, loader
 * version) comes from the copy stored on disk. A brand-new profile always gets directory ''.
 */
export async function resolveProfile(ref: ProfileRef): Promise<Profile> {
  const stored = await readJson<Profile | undefined>(join(profileRoot(), ref.id, 'profile.json'), undefined);
  return stored ?? { id: ref.id, name: ref.name, version: ref.version, loader: ref.loader, loaderVersion: ref.loaderVersion, directory: '' };
}

/** Deletes the profile. Worlds are copied to a backup folder first, never destroyed. */
export function removeProfile(profile: Profile): Promise<Profile[]> {
  return withProfileLock(profile.id, async () => {
    const settings = await getSettings();
    const metaDir = profilePath(profile);
    if (!inside(profileRoot(), metaDir)) throw new Error('Invalid profile path.');
    const gameDir = profileGamePath(profile);
    const gameDirIsSafe = inside(profileRoot(), gameDir) || inside(settings.gameDirectory, gameDir) || inside(join(root(), 'game'), gameDir);
    if (existsSync(gameDir)) {
      if (!gameDirIsSafe) throw new Error('Refusing to delete a game directory outside Xavi\'s folders.');
      const saves = join(gameDir, 'saves');
      if (existsSync(saves) && (await readdir(saves)).length) {
        const target = join(backupRoot(), `${profile.id}-${Date.now()}`, 'saves');
        await mkdir(join(target, '..'), { recursive: true });
        await cp(saves, target, { recursive: true });
      }
      await rm(gameDir, { recursive: true, force: true });
    }
    await rm(metaDir, { recursive: true, force: true });
    return listProfiles();
  });
}

import { existsSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import type { LocalProfile, Loader, Mod, ProfileRef, Server, Settings } from '../shared/types.js';
import { isPlainFileName, isValidSkinSource, parseJvmArgs } from './logic.js';

const LOADERS: Loader[] = ['Vanilla', 'Fabric', 'Forge', 'NeoForge'];
const MODES = ['auto', 'low', 'balanced', 'high'] as const;

function object(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`Invalid ${what}.`);
  return value as Record<string, unknown>;
}
function string(value: unknown, what: string, max = 256): string {
  if (typeof value !== 'string' || value.length > max) throw new Error(`Invalid ${what}.`);
  return value;
}
function number(value: unknown, what: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid ${what}.`);
  return Math.round(value);
}

export function profileRef(value: unknown): ProfileRef {
  const input = object(value, 'profile');
  const id = string(input.id, 'profile id', 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(id)) throw new Error('Invalid profile id.');
  const version = string(input.version, 'Minecraft version', 40);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(version)) throw new Error('Invalid Minecraft version.');
  if (!LOADERS.includes(input.loader as Loader)) throw new Error('Invalid loader.');
  let loaderVersion: string | undefined;
  if (input.loaderVersion !== undefined) {
    loaderVersion = string(input.loaderVersion, 'loader version', 64);
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(loaderVersion)) throw new Error('Invalid loader version.');
  }
  return { id, name: string(input.name ?? `${input.loader} ${version}`, 'profile name', 80), version, loader: input.loader as Loader, loaderVersion };
}

export const fileName = (value: unknown): string => {
  const name = string(value, 'file name');
  if (!isPlainFileName(name)) throw new Error('Invalid file name.');
  return name;
};
export const boolean = (value: unknown, what: string): boolean => { if (typeof value !== 'boolean') throw new Error(`Invalid ${what}.`); return value; };
export const bytes = (value: unknown, what: string, max: number): Uint8Array => {
  if (!(value instanceof Uint8Array) || value.length > max) throw new Error(`Invalid ${what}.`);
  return value;
};

export function mod(value: unknown): Mod {
  const input = object(value, 'mod');
  return { id: fileName(input.file), name: '', file: fileName(input.file), enabled: boolean(input.enabled, 'mod state'), size: 0 };
}

export function server(value: unknown): Server {
  const input = object(value, 'server');
  const id = string(input.id, 'server id', 64);
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) throw new Error('Invalid server id.');
  let profileId: string | undefined;
  if (typeof input.profileId === 'string' && input.profileId) {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(input.profileId)) throw new Error('Invalid profile id.');
    profileId = input.profileId;
  }
  return { id, name: string(input.name, 'server name', 64).trim() || 'Server', address: string(input.address, 'server address', 255), profileId };
}

export function localProfile(value: unknown): LocalProfile {
  const input = object(value, 'local profile');
  return { name: string(input.name, 'player name', 64), uuid: typeof input.uuid === 'string' ? input.uuid : '' };
}

export function modrinthId(value: unknown, what: string): string {
  const id = string(value, what, 16);
  if (!/^[A-Za-z0-9]{4,16}$/.test(id)) throw new Error(`Invalid ${what}.`);
  return id;
}

export function modrinthVersionRef(value: unknown): string {
  return modrinthId(object(value, 'Modrinth version').id, 'Modrinth version id');
}

export const versionString = (value: unknown) => {
  const version = string(value, 'Minecraft version', 40);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(version)) throw new Error('Invalid Minecraft version.');
  return version;
};
export const loaderString = (value: unknown): Loader => { if (!LOADERS.includes(value as Loader)) throw new Error('Invalid loader.'); return value as Loader; };

export function settings(value: unknown): Settings {
  const input = object(value, 'settings');
  const minRam = number(input.minRam, 'minimum RAM', 256, 65536);
  const maxRam = number(input.maxRam, 'maximum RAM', 512, 65536);
  if (minRam > maxRam) throw new Error('Minimum RAM cannot be larger than maximum RAM.');
  const javaPath = string(input.javaPath, 'Java path', 1024);
  if (javaPath) {
    if (!isAbsolute(javaPath) || !existsSync(javaPath) || !/^javaw?(\.exe)?$/i.test(basename(javaPath))) throw new Error('Java path must point to an existing java or java.exe file.');
  }
  const gameDirectory = string(input.gameDirectory, 'game directory', 1024);
  if (!isAbsolute(gameDirectory)) throw new Error('Game directory must be an absolute path.');
  const microsoftClientId = string(input.microsoftClientId, 'Microsoft client ID', 64).trim();
  if (microsoftClientId && !/^[0-9a-f-]{36}$/i.test(microsoftClientId)) throw new Error('Microsoft client ID must be a GUID.');
  const jvmArgs = string(input.jvmArgs ?? '', 'JVM arguments', 500);
  parseJvmArgs(jvmArgs); // throws on anything that could load arbitrary code
  const skinSource = string(input.skinSource ?? '', 'skin source', 300).trim();
  if (skinSource && !isValidSkinSource(skinSource)) throw new Error('Skin source must be an https:// address containing {USERNAME}, for example https://raw.githubusercontent.com/you/skins/main/{USERNAME}.png');
  if (!MODES.includes(input.performanceMode as typeof MODES[number])) throw new Error('Invalid memory mode.');
  return { minRam, maxRam, javaPath, gameDirectory, closeOnLaunch: boolean(input.closeOnLaunch, 'close-on-launch'), microsoftClientId, performanceMode: input.performanceMode as Settings['performanceMode'], jvmArgs, skinSource };
}

export const clientId = (value: unknown) => string(value, 'client id', 64).trim();

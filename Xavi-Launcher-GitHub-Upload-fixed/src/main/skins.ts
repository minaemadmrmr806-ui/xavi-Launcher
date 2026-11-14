import { existsSync } from 'node:fs';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Mod, Profile, Settings } from '../shared/types.js';
import { readSkinPng, skinLoaderConfig } from './logic.js';
import { installModrinthMod, modVersions } from './mods.js';
import { profileGamePath } from './store.js';
import { readJson, root, writeFileAtomic, writeJsonAtomic } from './util.js';

/*
 * Offline skins without any Xavi server: the CustomSkinLoader mod reads skins from a local folder
 * and, optionally, from a shared https address that the friend group agrees on. Only players who run
 * the same mod see those skins. Players on plain Minecraft see Mojang skins (or a server plugin's).
 */
const MOD_SLUG = 'customskinloader';
const centralSkin = () => join(root(), 'skins', 'local.png');
const configPath = (profile: Profile) => join(profileGamePath(profile), 'CustomSkinLoader', 'CustomSkinLoader.json');

export async function saveLocalSkin(bytes: Uint8Array) {
  if (bytes.length > 1024 * 1024) throw new Error('Skin file is too large (max 1 MB).');
  readSkinPng(bytes);
  await writeFileAtomic(centralSkin(), bytes);
}
export async function clearLocalSkin() { await rm(centralSkin(), { force: true }); }
export async function getLocalSkin(): Promise<string | undefined> {
  const data = await readFile(centralSkin()).catch(() => undefined);
  return data ? `data:image/png;base64,${data.toString('base64')}` : undefined;
}

export async function hasSkinMod(profile: Profile): Promise<boolean> {
  const files = await readdir(join(profileGamePath(profile), 'mods')).catch(() => [] as string[]);
  return files.some(file => /customskinloader/i.test(file) && !file.endsWith('.disabled'));
}

export async function installSkinMod(profile: Profile): Promise<Mod[]> {
  if (profile.loader === 'Vanilla') throw new Error('Skin mods need Fabric, Forge or NeoForge. Create one of those profiles first.');
  const found = (await modVersions(MOD_SLUG, profile.version, profile.loader))[0];
  if (!found) throw new Error(`CustomSkinLoader has no build for Minecraft ${profile.version} with ${profile.loader}. Try another version.`);
  return installModrinthMod(profile, found.id);
}

/**
 * Called before every launch of a profile that has the skin mod: copies the user's skin into the mod's
 * LocalSkin folder under the player's name and writes the mod config. A config the user edited by hand
 * (no _xavi marker) is never overwritten.
 */
export async function syncSkins(profile: Profile, playerName: string, settings: Pick<Settings, 'skinSource'>): Promise<void> {
  if (!(await hasSkinMod(profile))) return;
  const game = profileGamePath(profile);
  const skin = await readFile(centralSkin()).catch(() => undefined);
  if (skin) await writeFileAtomic(join(game, 'CustomSkinLoader', 'LocalSkin', 'skins', `${playerName}.png`), skin);
  const existing = existsSync(configPath(profile)) ? await readJson<{ _xavi?: boolean }>(configPath(profile), {}) : undefined;
  if (!existing || existing._xavi) await writeJsonAtomic(configPath(profile), skinLoaderConfig(settings.skinSource || undefined));
}

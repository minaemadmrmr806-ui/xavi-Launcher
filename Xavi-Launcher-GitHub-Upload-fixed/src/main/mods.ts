import AdmZip from 'adm-zip';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { ModpackInfo, Mod, ModrinthProject, ModrinthVersion, Profile } from '../shared/types.js';
import { inside, isAllowedModpackUrl, isModrinthCdn, isPlainFileName, joinInside, loaderFromDependencies, safeFileName } from './logic.js';
import { profileGamePath } from './store.js';
import { downloadBytes, json, readJson, runPool, writeFileAtomic, writeJsonAtomic } from './util.js';

const MODRINTH_API = 'https://api.modrinth.com/v2';
const MAX_MOD_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 1024 * 1024 * 1024;
const MAX_ENTRIES = 20000;

type ModRecord = { projectId: string; versionId: string };
const modsDir = (profile: Profile) => join(profileGamePath(profile), 'mods');
const recordsPath = (profile: Profile) => join(modsDir(profile), '.xavi-mods.json');
const readRecords = (profile: Profile) => readJson<Record<string, ModRecord>>(recordsPath(profile), {});
const writeRecords = (profile: Profile, records: Record<string, ModRecord>) => writeJsonAtomic(recordsPath(profile), records);
const baseName = (file: string) => file.replace(/\.disabled$/, '');

function modPath(profile: Profile, file: string): string {
  if (!isPlainFileName(file)) throw new Error('Invalid mod file name.');
  const path = join(modsDir(profile), file);
  if (!inside(modsDir(profile), path)) throw new Error('Invalid mod path.');
  return path;
}

/* --------------------------------- local ---------------------------------- */

export async function listMods(profile: Profile): Promise<Mod[]> {
  const dir = modsDir(profile);
  await mkdir(dir, { recursive: true });
  const records = await readRecords(profile);
  const files = (await readdir(dir)).filter(file => file.endsWith('.jar') || file.endsWith('.jar.disabled'));
  return Promise.all(files.map(async file => {
    const info = await stat(join(dir, file));
    const record = records[baseName(file)];
    return { id: file, name: baseName(file).replace(/\.jar$/, ''), file, enabled: !file.endsWith('.disabled'), size: info.size, projectId: record?.projectId, versionId: record?.versionId };
  }));
}

export async function setMod(profile: Profile, file: string, enabled: boolean) {
  const source = modPath(profile, file);
  const target = modPath(profile, enabled ? baseName(file) : `${baseName(file)}.disabled`);
  if (source !== target) await rename(source, target);
  return listMods(profile);
}

export async function removeMod(profile: Profile, file: string) {
  await rm(modPath(profile, file), { force: true });
  const records = await readRecords(profile);
  delete records[baseName(file)];
  await writeRecords(profile, records);
  return listMods(profile);
}

/** Writes a jar and returns the name it was stored under. */
async function writeModFile(profile: Profile, fileName: string, data: Uint8Array, disabled = false): Promise<string> {
  const name = safeFileName(fileName);
  if (!name.toLowerCase().endsWith('.jar')) throw new Error('Only .jar files can be installed as mods.');
  const stored = disabled ? `${name}.disabled` : name;
  await writeFileAtomic(modPath(profile, stored), data);
  return name;
}

/** Extracts entries with a size/entry budget so a hostile archive cannot fill the disk. */
function checkedEntries(zip: AdmZip) {
  const entries = zip.getEntries();
  if (entries.length > MAX_ENTRIES) throw new Error('Archive has too many files.');
  let total = 0;
  for (const entry of entries) {
    total += entry.header.size;
    if (total > MAX_EXTRACTED_BYTES) throw new Error('Archive expands to more than 1 GB.');
  }
  return entries;
}

export async function importMod(profile: Profile, fileName: string, data: Uint8Array) {
  if (data.length > MAX_ARCHIVE_BYTES) throw new Error('File is too large.');
  const name = safeFileName(fileName).toLowerCase();
  if (name.endsWith('.jar')) await writeModFile(profile, fileName, data);
  else if (name.endsWith('.zip')) {
    for (const entry of checkedEntries(new AdmZip(Buffer.from(data)))) {
      if (!entry.isDirectory && entry.entryName.toLowerCase().endsWith('.jar')) await writeModFile(profile, entry.entryName, entry.getData());
    }
  } else throw new Error('Only .jar files or ZIP/MRPACK modpacks are supported.');
  return listMods(profile);
}

/* -------------------------------- Modrinth -------------------------------- */

export async function searchMods(query: string, version: string, loader: string): Promise<ModrinthProject[]> {
  if (loader === 'Vanilla') throw new Error('Vanilla profiles cannot use mods. Create a Fabric, Forge or NeoForge profile first.');
  const facets = JSON.stringify([['project_type:mod'], [`versions:${version}`], [`categories:${loader.toLowerCase()}`]]);
  return (await json<{ hits: ModrinthProject[] }>(`${MODRINTH_API}/search?limit=30&query=${encodeURIComponent(query)}&facets=${encodeURIComponent(facets)}`)).hits;
}

export const modVersions = (project: string, version: string, loader: string) =>
  json<ModrinthVersion[]>(`${MODRINTH_API}/project/${encodeURIComponent(project)}/version?game_versions=${encodeURIComponent(JSON.stringify([version]))}&loaders=${encodeURIComponent(JSON.stringify([loader.toLowerCase()]))}`);

const fetchVersion = (id: string) => json<ModrinthVersion>(`${MODRINTH_API}/version/${encodeURIComponent(id)}`);

async function downloadVersionFile(version: ModrinthVersion) {
  const file = version.files.find(item => item.primary) || version.files[0];
  if (!file) throw new Error('This Modrinth version has no downloadable file.');
  if (!isModrinthCdn(file.url)) throw new Error('Refusing to download a mod from outside Modrinth.');
  const bytes = await downloadBytes(file.url, { hashes: file.hashes, requireHash: true, maxBytes: MAX_MOD_BYTES });
  return { file, bytes };
}

/** The renderer only names a version id; the file URL and hashes always come from Modrinth itself. */
export async function installModrinthMod(profile: Profile, versionId: string, depth = 0): Promise<Mod[]> {
  const version = await fetchVersion(versionId);
  const { file, bytes } = await downloadVersionFile(version);
  const name = await writeModFile(profile, file.filename, bytes);
  const records = await readRecords(profile);
  records[name] = { projectId: version.project_id, versionId: version.id };
  await writeRecords(profile, records);

  const missing: string[] = [];
  if (depth < 4) {
    for (const dependency of version.dependencies) {
      if (dependency.dependency_type !== 'required') continue;
      try {
        const current = await readRecords(profile);
        if (dependency.project_id && Object.values(current).some(record => record.projectId === dependency.project_id)) continue;
        const id = dependency.version_id ?? (dependency.project_id ? (await modVersions(dependency.project_id, profile.version, profile.loader))[0]?.id : undefined);
        if (!id) throw new Error('no compatible version');
        await installModrinthMod(profile, id, depth + 1);
      } catch { missing.push(dependency.project_id ?? dependency.version_id ?? 'unknown'); }
    }
  }
  if (missing.length) throw new Error(`${name} was installed, but required dependencies could not be installed (${missing.join(', ')}). Install them manually.`);
  return listMods(profile);
}

export async function updateModrinthMod(profile: Profile, mod: Mod) {
  const records = await readRecords(profile);
  const key = baseName(mod.file);
  const record = records[key];
  if (!record) throw new Error('This mod was imported manually and has no Modrinth update source.');
  modPath(profile, mod.file); // validates the name
  const latest = (await modVersions(record.projectId, profile.version, profile.loader))[0];
  if (!latest) throw new Error('No compatible Modrinth version was found.');
  if (latest.id === record.versionId) return listMods(profile);

  // Download and verify first; the old file is removed only once the new one is safely on disk.
  const { file, bytes } = await downloadVersionFile(latest);
  const disabled = mod.file.endsWith('.disabled');
  const name = await writeModFile(profile, file.filename, bytes, disabled);
  if (name !== key) await rm(modPath(profile, mod.file), { force: true });
  delete records[key];
  records[name] = { projectId: latest.project_id, versionId: latest.id };
  await writeRecords(profile, records);
  return listMods(profile);
}

/* --------------------------------- .mrpack -------------------------------- */

type MrpackFile = { path: string; downloads?: string[]; hashes?: { sha1?: string; sha512?: string }; env?: { client?: string }; fileSize?: number };

export async function importModpack(profile: Profile, fileName: string, data: Uint8Array) {
  if (!fileName.toLowerCase().endsWith('.mrpack')) return importMod(profile, fileName, data);
  if (data.length > MAX_ARCHIVE_BYTES) throw new Error('Modpack is too large.');
  const game = profileGamePath(profile);
  const zip = new AdmZip(Buffer.from(data));
  const entries = checkedEntries(zip);
  const manifestEntry = zip.getEntry('modrinth.index.json');
  if (!manifestEntry) throw new Error('This is not a valid Modrinth .mrpack file.');
  const manifest = JSON.parse(manifestEntry.getData().toString('utf8')) as { files?: MrpackFile[]; dependencies?: Record<string, string> };
  const wanted = manifest.dependencies?.minecraft;
  if (wanted && wanted !== profile.version) throw new Error(`This pack is for Minecraft ${wanted}, but the selected profile is ${profile.version}. Create a ${wanted} profile first.`);

  const files = (manifest.files ?? []).filter(item => item.env?.client !== 'unsupported');
  let budget = MAX_EXTRACTED_BYTES;
  for (const item of files) { budget -= item.fileSize ?? 0; if (budget < 0) throw new Error('Modpack downloads exceed 1 GB.'); }
  await runPool(files.map(item => async () => {
    const target = joinInside(game, item.path);
    const url = item.downloads?.[0];
    if (!url || !isAllowedModpackUrl(url)) throw new Error(`Modpack file has no download from an allowed host: ${item.path}`);
    const bytes = await downloadBytes(url, { hashes: item.hashes, requireHash: true, maxBytes: MAX_MOD_BYTES });
    await mkdir(dirname(target), { recursive: true });
    await writeFileAtomic(target, bytes);
  }), 4);

  // A pack that ships its own Fabric API must not end up with a second, auto-installed copy.
  if (files.some(item => /^mods\/fabric-api/i.test(item.path.replace(/\\/g, '/')))) {
    const packNames = new Set(files.map(item => basename(item.path.replace(/\\/g, '/'))));
    const records = await readRecords(profile);
    for (const [name, record] of Object.entries(records)) {
      if (record.projectId === 'P7dR8mSH' && !packNames.has(name)) { await rm(modPath(profile, name), { force: true }); await rm(modPath(profile, `${name}.disabled`), { force: true }); delete records[name]; }
    }
    await writeRecords(profile, records);
  }

  for (const prefix of ['overrides/', 'client-overrides/']) {
    for (const entry of entries) {
      if (entry.isDirectory || !entry.entryName.startsWith(prefix)) continue;
      const target = joinInside(game, entry.entryName.slice(prefix.length));
      await mkdir(dirname(target), { recursive: true });
      await writeFileAtomic(target, entry.getData());
    }
  }
  return listMods(profile);
}

/** Installs Fabric API (Modrinth project P7dR8mSH) if the profile does not have it yet. */
export async function ensureFabricApi(profile: Profile): Promise<void> {
  if (profile.loader !== 'Fabric') return;
  if ((await listMods(profile)).some(mod => /^fabric-api/i.test(mod.file))) return;
  const found = (await modVersions('P7dR8mSH', profile.version, 'Fabric'))[0];
  if (!found) throw new Error(`Fabric API has no build for Minecraft ${profile.version} yet.`);
  await installModrinthMod(profile, found.id);
}

/** Reads a .mrpack so a matching profile (version + loader) can be created before importing it. */
export function inspectModpack(data: Uint8Array): ModpackInfo {
  if (data.length > MAX_ARCHIVE_BYTES) throw new Error('Modpack is too large.');
  const zip = new AdmZip(Buffer.from(data));
  const entry = zip.getEntry('modrinth.index.json');
  if (!entry) throw new Error('This is not a valid Modrinth .mrpack file.');
  const manifest = JSON.parse(entry.getData().toString('utf8')) as { name?: string; dependencies?: Record<string, string> };
  const version = manifest.dependencies?.minecraft;
  if (!version) throw new Error('The modpack does not say which Minecraft version it needs.');
  if (manifest.dependencies?.['quilt-loader']) throw new Error('Quilt modpacks are not supported yet. Use a Fabric, Forge or NeoForge pack.');
  const loader = loaderFromDependencies(manifest.dependencies);
  return { name: (manifest.name ?? 'Modpack').slice(0, 60), version, loader: loader?.loader ?? 'Vanilla', loaderVersion: loader?.loaderVersion };
}

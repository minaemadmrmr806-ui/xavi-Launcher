import AdmZip from 'adm-zip';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let appData = '';
vi.mock('electron', () => ({
  app: { getPath: () => appData },
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (v: string) => Buffer.from(`enc:${v}`), decryptString: (b: Buffer) => b.toString().replace(/^enc:/, '') },
  clipboard: {}, shell: {}
}));

const load = async () => ({ store: await import('../src/main/store'), mods: await import('../src/main/mods'), util: await import('../src/main/util'), v: await import('../src/main/validate') });
const jar = (name: string) => new TextEncoder().encode(`jar:${name}`);

beforeEach(async () => { appData = await mkdtemp(join(tmpdir(), 'xavi-test-')); });

async function makeProfile() {
  const { store } = await load();
  const profile = { id: 'p1', name: 'Test', version: '1.21.1', loader: 'Fabric' as const, directory: join(appData, 'XaviLauncher', 'game', 'p1'), installed: true };
  await store.saveProfile(profile);
  return profile;
}

describe('mods', () => {
  it('imports, disables, enables and removes mods whose names contain spaces and brackets', async () => {
    const { mods } = await load(); const profile = await makeProfile();
    const name = 'Sodium (Fabric) 0.5+mc1.21.jar';
    let list = await mods.importMod(profile, name, jar(name));
    expect(list.map(m => m.file)).toEqual([name]);
    list = await mods.setMod(profile, name, false);
    expect(list[0]).toMatchObject({ file: `${name}.disabled`, enabled: false });
    list = await mods.setMod(profile, `${name}.disabled`, true);
    expect(list[0]).toMatchObject({ file: name, enabled: true });
    list = await mods.removeMod(profile, name);
    expect(list).toEqual([]);
  });
  it('rejects path traversal in mod names', async () => {
    const { mods } = await load(); const profile = await makeProfile();
    await expect(mods.setMod(profile, '../../evil.jar', false)).rejects.toThrow();
    await expect(mods.removeMod(profile, '..\\x.jar')).rejects.toThrow();
  });
  it('extracts only jars from a zip and flattens paths', async () => {
    const { mods } = await load(); const profile = await makeProfile();
    const zip = new AdmZip(); zip.addFile('nested/dir/a.jar', Buffer.from('a')); zip.addFile('../../escape.jar', Buffer.from('x')); zip.addFile('readme.txt', Buffer.from('t'));
    const list = await mods.importMod(profile, 'pack.zip', new Uint8Array(zip.toBuffer()));
    expect(list.map(m => m.file).sort()).toEqual(['a.jar', 'escape.jar']);
    expect(existsSync(join(appData, 'escape.jar'))).toBe(false);
  });
  it('rejects non-jar uploads', async () => {
    const { mods } = await load(); const profile = await makeProfile();
    await expect(mods.importMod(profile, 'x.exe', jar('x'))).rejects.toThrow();
  });
  it('refuses a modpack for another Minecraft version', async () => {
    const { mods } = await load(); const profile = await makeProfile();
    const zip = new AdmZip(); zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify({ dependencies: { minecraft: '1.20.1' }, files: [] })));
    await expect(mods.importModpack(profile, 'p.mrpack', new Uint8Array(zip.toBuffer()))).rejects.toThrow(/1\.20\.1/);
  });
  it('rejects modpack files from disallowed hosts and unverifiable files', async () => {
    const { mods } = await load(); const profile = await makeProfile();
    const make = (file: object) => { const zip = new AdmZip(); zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify({ dependencies: { minecraft: '1.21.1' }, files: [file] }))); return new Uint8Array(zip.toBuffer()); };
    await expect(mods.importModpack(profile, 'p.mrpack', make({ path: 'mods/a.jar', downloads: ['https://evil.example/a.jar'], hashes: { sha1: 'aa' } }))).rejects.toThrow(/allowed host/);
    await expect(mods.importModpack(profile, 'p.mrpack', make({ path: '../../x.jar', downloads: ['https://cdn.modrinth.com/a.jar'], hashes: { sha1: 'aa' } }))).rejects.toThrow();
  });
  it('writes overrides and client-overrides inside the game folder only', async () => {
    const { mods } = await load(); const profile = await makeProfile();
    const zip = new AdmZip(); zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify({ dependencies: { minecraft: '1.21.1' }, files: [] })));
    zip.addFile('overrides/config/a.toml', Buffer.from('a=1')); zip.addFile('client-overrides/config/b.toml', Buffer.from('b=2')); zip.addFile('overrides/../../hack.txt', Buffer.from('x'));
    await mods.importModpack(profile, 'p.mrpack', new Uint8Array(zip.toBuffer()));
    expect(await readFile(join(profile.directory, 'config', 'a.toml'), 'utf8')).toBe('a=1');
    expect(await readFile(join(profile.directory, 'config', 'b.toml'), 'utf8')).toBe('b=2');
    expect(existsSync(join(appData, 'hack.txt'))).toBe(false);
  });
});

describe('storage', () => {
  it('moves a corrupt JSON file aside instead of silently overwriting it, and reports it', async () => {
    const { store, util } = await load();
    await mkdir(join(appData, 'XaviLauncher'), { recursive: true });
    await writeFile(join(appData, 'XaviLauncher', 'servers.json'), '{not json');
    expect(await store.getServers()).toEqual([]);
    expect((await readdir(join(appData, 'XaviLauncher'))).some(f => f.startsWith('servers.json.corrupt-'))).toBe(true);
    expect(util.takeWarnings().join()).toMatch(/servers\.json/);
  });
  it('encrypts Microsoft tokens at rest and never returns them to the renderer', async () => {
    const { store } = await load();
    await store.saveAccount({ name: 'Steve', uuid: 'abc', accessToken: 'SECRET-TOKEN', refreshToken: 'SECRET-REFRESH', expiresAt: 1 });
    const raw = await readFile(join(appData, 'XaviLauncher', 'account.json'), 'utf8');
    expect(raw).not.toContain('SECRET');
    expect((await store.getAccountSecret())?.accessToken).toBe('SECRET-TOKEN');
    const publicView = await store.getAccount();
    expect(JSON.stringify(publicView)).not.toContain('SECRET');
    expect(publicView?.accessToken).toBe('msa');
  });
  it('keeps the local UUID stable when the name changes', async () => {
    const { store } = await load();
    const first = await store.getLocalProfile();
    const renamed = await store.saveLocalProfile({ name: 'NewName', uuid: first.uuid });
    expect(renamed.uuid).toBe(first.uuid);
    expect((await store.getLocalProfile()).name).toBe('NewName');
  });
  it('backs up worlds before deleting a profile', async () => {
    const { store } = await load(); const profile = await makeProfile();
    await mkdir(join(profile.directory, 'saves', 'World1'), { recursive: true });
    await writeFile(join(profile.directory, 'saves', 'World1', 'level.dat'), 'data');
    expect(await store.removeProfile(profile)).toEqual([]);
    expect(existsSync(profile.directory)).toBe(false);
    const backups = await readdir(join(appData, 'XaviLauncher', 'backups'));
    expect(backups).toHaveLength(1);
    expect(await readFile(join(appData, 'XaviLauncher', 'backups', backups[0], 'saves', 'World1', 'level.dat'), 'utf8')).toBe('data');
  });
  it('refuses to delete a game directory outside Xavi folders', async () => {
    const { store } = await load();
    const outside = await mkdtemp(join(tmpdir(), 'outside-'));
    const profile = { id: 'evil', name: 'x', version: '1.21.1', loader: 'Vanilla' as const, directory: outside };
    await store.saveProfile(profile);
    await expect(store.removeProfile(profile)).rejects.toThrow(/outside/);
    expect(existsSync(outside)).toBe(true);
  });
  it('only accepts a game directory chosen through the dialog', async () => {
    const { store } = await load();
    const settings = await store.getSettings();
    const elsewhere = join(appData, 'elsewhere');
    await expect(store.saveSettings({ ...settings, gameDirectory: elsewhere })).rejects.toThrow(/Browse/);
    store.approveDirectory(elsewhere);
    expect((await store.saveSettings({ ...settings, gameDirectory: elsewhere })).gameDirectory).toBe(elsewhere);
  });
  it('resolves profiles from disk and ignores renderer-supplied directories', async () => {
    const { store } = await load(); const profile = await makeProfile();
    const resolved = await store.resolveProfile({ id: 'p1', name: 'hacked', version: '9.9', loader: 'Vanilla' });
    expect(resolved.directory).toBe(profile.directory);
    expect(resolved.version).toBe('1.21.1');
  });
});

describe('IPC validation', () => {
  it('validates profile references', async () => {
    const { v } = await load();
    expect(v.profileRef({ id: 'abc-123', version: '1.21.1', loader: 'Forge' }).loader).toBe('Forge');
    for (const bad of [{ id: '../x', version: '1.21.1', loader: 'Forge' }, { id: 'a', version: '1.21.1;rm', loader: 'Forge' }, { id: 'a', version: '1.21.1', loader: 'Evil' }, null, 'x']) expect(() => v.profileRef(bad)).toThrow();
  });
  it('validates settings', async () => {
    const { v, store } = await load();
    const ok = await store.getSettings();
    expect(v.settings(ok)).toBeTruthy();
    expect(() => v.settings({ ...ok, jvmArgs: '-javaagent:/x.jar' })).toThrow();
    expect(() => v.settings({ ...ok, javaPath: '/etc/passwd' })).toThrow();
    expect(() => v.settings({ ...ok, minRam: 9000, maxRam: 1024 })).toThrow();
    expect(() => v.settings({ ...ok, gameDirectory: 'relative/path' })).toThrow();
  });
});

describe('module loading', () => {
  it('loads every main-process module and the launcher library', async () => {
    for (const name of ['install', 'java', 'launch', 'auth', 'services']) expect(await import(`../src/main/${name}`)).toBeTruthy();
    const mclc = await import('minecraft-launcher-core');
    expect(typeof (mclc.Client ?? (mclc as { default?: { Client?: unknown } }).default?.Client)).toBe('function');
  });
  it('detects the system Java without throwing', async () => {
    const { detectJava } = await import('../src/main/java');
    expect(Array.isArray(await detectJava())).toBe(true);
  });
});

import { fakePng } from './helpers';

describe('skins (CustomSkinLoader)', () => {
  const settings = { skinSource: 'https://x.io/skins/{USERNAME}.png' };
  it('copies the skin and writes config only for profiles that have the skin mod', async () => {
    const { store } = await load(); const profile = await makeProfile();
    const skins = await import('../src/main/skins');
    await skins.saveLocalSkin(fakePng(64, 64));
    await skins.syncSkins(profile, 'Alex', settings);
    expect(existsSync(join(profile.directory, 'CustomSkinLoader'))).toBe(false); // no mod, nothing written
    await mkdir(join(profile.directory, 'mods'), { recursive: true });
    await writeFile(join(profile.directory, 'mods', 'CustomSkinLoader_Fabric-14.jar'), 'x');
    await skins.syncSkins(profile, 'Alex', settings);
    expect(existsSync(join(profile.directory, 'CustomSkinLoader', 'LocalSkin', 'skins', 'Alex.png'))).toBe(true);
    const config = JSON.parse(await readFile(join(profile.directory, 'CustomSkinLoader', 'CustomSkinLoader.json'), 'utf8'));
    expect(config.loadlist.map((item: { name: string }) => item.name)).toEqual(['LocalSkin', 'XaviFriends', 'Mojang']);
    expect(store).toBeTruthy();
  });
  it('never overwrites a config the user edited by hand', async () => {
    const profile = await makeProfile();
    const skins = await import('../src/main/skins');
    await mkdir(join(profile.directory, 'mods'), { recursive: true });
    await writeFile(join(profile.directory, 'mods', 'customskinloader.jar'), 'x');
    await mkdir(join(profile.directory, 'CustomSkinLoader'), { recursive: true });
    await writeFile(join(profile.directory, 'CustomSkinLoader', 'CustomSkinLoader.json'), JSON.stringify({ enable: true, loadlist: [] }));
    await skins.syncSkins(profile, 'Alex', settings);
    expect(JSON.parse(await readFile(join(profile.directory, 'CustomSkinLoader', 'CustomSkinLoader.json'), 'utf8')).loadlist).toEqual([]);
  });
  it('rejects non-skin images', async () => {
    const skins = await import('../src/main/skins');
    await expect(skins.saveLocalSkin(fakePng(100, 100))).rejects.toThrow();
    await expect(skins.saveLocalSkin(new TextEncoder().encode('not a png'))).rejects.toThrow();
  });
  it('shows a data URL preview for the saved skin', async () => {
    const skins = await import('../src/main/skins');
    expect(await skins.getLocalSkin()).toBeUndefined();
    await skins.saveLocalSkin(fakePng(64, 64));
    expect(await skins.getLocalSkin()).toMatch(/^data:image\/png;base64,/);
    await skins.clearLocalSkin();
    expect(await skins.getLocalSkin()).toBeUndefined();
  });
});

describe('modpack profiles and server pairing', () => {
  it('reads version and loader from an mrpack', async () => {
    const { mods } = await load();
    const zip = new AdmZip(); zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify({ name: 'Cool Pack', dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.5' }, files: [] })));
    expect(mods.inspectModpack(new Uint8Array(zip.toBuffer()))).toEqual({ name: 'Cool Pack', version: '1.21.1', loader: 'Fabric', loaderVersion: '0.16.5' });
    const quilt = new AdmZip(); quilt.addFile('modrinth.index.json', Buffer.from(JSON.stringify({ dependencies: { minecraft: '1.21.1', 'quilt-loader': '0.26' } })));
    expect(() => mods.inspectModpack(new Uint8Array(quilt.toBuffer()))).toThrow(/Quilt/);
  });
  it('keeps the auto-installed Fabric API when the pack has none, and replaces it when the pack ships its own', async () => {
    const { mods } = await load(); const profile = await makeProfile();
    await mkdir(join(profile.directory, 'mods'), { recursive: true });
    await writeFile(join(profile.directory, 'mods', 'fabric-api-0.100.jar'), 'old');
    await writeFile(join(profile.directory, 'mods', '.xavi-mods.json'), JSON.stringify({ 'fabric-api-0.100.jar': { projectId: 'P7dR8mSH', versionId: 'v1' } }));
    const build = (files: object[]) => { const zip = new AdmZip(); zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify({ dependencies: { minecraft: '1.21.1' }, files }))); return new Uint8Array(zip.toBuffer()); };
    await mods.importModpack(profile, 'a.mrpack', build([]));
    expect(existsSync(join(profile.directory, 'mods', 'fabric-api-0.100.jar'))).toBe(true);
    vi.stubGlobal('fetch', async () => new Response('newjar'));
    const sha1 = (await import('node:crypto')).createHash('sha1').update('newjar').digest('hex');
    await mods.importModpack(profile, 'b.mrpack', build([{ path: 'mods/fabric-api-0.101.jar', downloads: ['https://cdn.modrinth.com/x.jar'], hashes: { sha1 }, fileSize: 6 }]));
    vi.unstubAllGlobals();
    expect(existsSync(join(profile.directory, 'mods', 'fabric-api-0.100.jar'))).toBe(false);
    expect(existsSync(join(profile.directory, 'mods', 'fabric-api-0.101.jar'))).toBe(true);
  });
  it('validates server profile pairing and skin source', async () => {
    const { v, store } = await load();
    expect(v.server({ id: 's1', name: 'N', address: 'a.b', profileId: 'abc-1' }).profileId).toBe('abc-1');
    expect(() => v.server({ id: 's1', name: 'N', address: 'a.b', profileId: '../x' })).toThrow();
    const ok = await store.getSettings();
    expect(v.settings({ ...ok, skinSource: 'https://x.io/{USERNAME}.png' }).skinSource).toContain('{USERNAME}');
    expect(() => v.settings({ ...ok, skinSource: 'http://x.io/{USERNAME}.png' })).toThrow(/skin source/i);
  });
  it('lets a new profile carry a loader version from a modpack', async () => {
    const { v, store } = await load();
    const ref = v.profileRef({ id: 'pack-1', name: 'Pack', version: '1.21.1', loader: 'Fabric', loaderVersion: '0.16.5' });
    expect((await store.resolveProfile(ref)).loaderVersion).toBe('0.16.5');
    expect(() => v.profileRef({ id: 'pack-1', version: '1.21.1', loader: 'Fabric', loaderVersion: '1;rm -rf' })).toThrow();
  });
});

describe('launch fixes', () => {
  it('removes arm64 and other-OS libraries but keeps the x64 natives', async () => {
    const { pruneLibraries } = await import('../src/main/launch');
    const file = join(appData, 'version.json');
    const lib = (name: string, rules?: object[]) => ({ name, rules });
    await writeFile(file, JSON.stringify({ id: 'x', libraries: [
      lib('a:plain:1'),
      lib('org.lwjgl:lwjgl:3:natives-windows', [{ action: 'allow', os: { name: 'windows' } }]),
      lib('org.lwjgl:lwjgl:3:natives-windows-arm64', [{ action: 'allow', os: { name: 'windows', arch: 'arm64' } }]),
      lib('org.lwjgl:lwjgl:3:natives-macos', [{ action: 'allow', os: { name: 'osx' } }])
    ] }));
    await pruneLibraries(file);
    const names = JSON.parse(await readFile(file, 'utf8')).libraries.map((l: { name: string }) => l.name);
    expect(names).toContain('a:plain:1');
    expect(names.some((n: string) => n.endsWith('arm64'))).toBe(false);
    if (process.platform !== 'darwin') expect(names.some((n: string) => n.endsWith('natives-macos'))).toBe(false);
    if (process.platform === 'win32') expect(names).toContain('org.lwjgl:lwjgl:3:natives-windows');
  });
  it('migrates the old non-standard offline UUID to the standard one', async () => {
    const { store } = await load();
    await mkdir(join(appData, 'XaviLauncher'), { recursive: true });
    await writeFile(join(appData, 'XaviLauncher', 'local-profile.json'), JSON.stringify({ name: 'hello', uuid: '4f66666c696e65506c617965723a7861' }));
    const migrated = await store.getLocalProfile();
    expect(migrated.uuid).not.toMatch(/^4f66666c/);
    expect(migrated.uuid).toMatch(/^[0-9a-f]{32}$/);
    expect((await store.getLocalProfile()).uuid).toBe(migrated.uuid); // stays stable afterwards
  });
});

describe('javaw support', () => {
  it('lets minecraft-launcher-core accept javaw.exe while still checking normal Java', async () => {
    const { allowWindowedJava } = await import('../src/main/launch');
    allowWindowedJava();
    const { createRequire } = await import('node:module');
    const Handler = createRequire(import.meta.url)('minecraft-launcher-core/components/handler.js');
    const handler = Object.create(Handler.prototype); handler.client = { emit() {} };
    expect(await handler.checkJava('C:\\java\\bin\\javaw.exe')).toEqual({ run: true });
    expect((await handler.checkJava('definitely-not-java-xyz')).run).toBe(false); // original check still runs
  });
});

describe('second player instance', () => {
  it('creates a separate folder that shares mods and config', async () => {
    const { prepareInstanceDirectory } = await import('../src/main/launch');
    const base = join(appData, 'game'); await mkdir(join(base, 'mods'), { recursive: true }); await mkdir(join(base, 'config'), { recursive: true });
    await writeFile(join(base, 'mods', 'a.jar'), 'x');
    const instance = join(base, 'instances', 'Player2');
    await prepareInstanceDirectory(base, instance);
    expect(existsSync(join(instance, 'mods', 'a.jar'))).toBe(true);
    await prepareInstanceDirectory(base, instance); // idempotent
  });
  it('refuses public servers, bad names and the main name', async () => {
    const { store } = await load(); const profile = await makeProfile();
    const { launchSecondPlayer } = await import('../src/main/launch');
    const main = await store.getLocalProfile();
    await expect(launchSecondPlayer(profile, 'ab', '127.0.0.1')).rejects.toThrow(/3-16/);
    await expect(launchSecondPlayer(profile, main.name, '127.0.0.1')).rejects.toThrow(/different/);
    await expect(launchSecondPlayer(profile, 'Player2', 'play.example.com')).rejects.toThrow(/home network/);
  });
  it('lets an offline name join a local server but not a public one', async () => {
    const { launch } = await import('../src/main/launch'); const profile = await makeProfile();
    const offline = { name: 'hello', uuid: 'a'.repeat(32), accessToken: 'offline', expiresAt: Number.MAX_SAFE_INTEGER };
    await expect(launch(profile, offline, 'play.example.com')).rejects.toThrow(/Microsoft account/);
    await expect(launch(profile, offline, '192.168.1.5:25565')).rejects.toThrow(/incomplete/); // passes the server check, then stops at the missing client jar
  });
});

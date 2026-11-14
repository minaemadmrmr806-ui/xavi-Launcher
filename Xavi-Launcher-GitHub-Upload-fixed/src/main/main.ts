import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { URL } from 'node:url';
import type { Profile } from '../shared/types.js';
import { launchSecondPlayer, troubleshootLaunch, approveDirectory, clearLocalSkin, getLocalSkin, hasSkinMod, inspectModpack, installSkinMod, saveLocalSkin, getAccount, getJava, getLocalProfile, getPaths, getServers, getSettings, getVersions, getDiagnostics, importMod, importModpack, installJavaRuntime, installModrinthMod, installProfile, launchForRenderer, listMods, listProfiles, microsoftDeviceLogin, modVersions, removeMod, removeProfile, removeServer, resolveProfile, saveLocalProfile, saveServer, saveSettings, searchMods, setMod, takeWarnings, updateModrinthMod, uploadSkin } from './services.js';
import { sendProgress, sendToWindow } from './util.js';
import * as V from './validate.js';

// Packaged builds ignore VITE_DEV_SERVER_URL so an environment variable cannot redirect the app.
const devServer = app.isPackaged ? undefined : process.env.VITE_DEV_SERVER_URL;
const hasAppLock = app.requestSingleInstanceLock();
let win: BrowserWindow | undefined;
if (!hasAppLock) app.quit();
else app.on('second-instance', () => { if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });

async function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 1000, minHeight: 680, backgroundColor: '#081019', show: true,
    icon: join(app.getAppPath(), 'build', process.platform === 'win32' ? 'xavi-icon.ico' : 'xavi-icon.png'),
    webPreferences: { preload: join(app.getAppPath(), 'dist-electron', 'main', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    const parsed = new URL(url);
    const allowed = devServer ? parsed.origin === new URL(devServer).origin : parsed.protocol === 'file:';
    if (!allowed) event.preventDefault();
  });
  win.webContents.on('did-fail-load', (_, code, description, url) => { if (code !== -3) dialog.showErrorBox('Xavi failed to load', `${description} (${code})\n${url}`); });
  if (devServer) await win.loadURL(devServer);
  else await win.loadFile(join(app.getAppPath(), 'dist', 'index.html'));
}

/** Only our own window may call the IPC API. */
function trusted(event: IpcMainInvokeEvent) {
  const url = event.senderFrame?.url ?? '';
  if (devServer) return url.startsWith(new URL(devServer).origin);
  return url.startsWith('file://');
}
function handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!trusted(event)) throw new Error('Blocked IPC call from an untrusted page.');
    return listener(event, ...args);
  });
}

/** The renderer names a profile; the stored copy on disk is authoritative. */
async function existing(raw: unknown): Promise<Profile> {
  const ref = V.profileRef(raw);
  const profile = (await listProfiles()).find(item => item.id === ref.id);
  if (!profile) throw new Error('Unknown profile.');
  return profile;
}

function registerIpc() {
  handle('versions', () => getVersions());
  handle('profiles', () => listProfiles());
  handle('paths', () => getPaths());
  handle('settings', () => getSettings());
  handle('warnings', () => takeWarnings());
  handle('java', () => getJava());
  handle('account', () => getAccount());
  handle('local-profile', () => getLocalProfile());
  handle('servers', () => getServers());

  handle('profile:remove', async (_, p) => removeProfile(await existing(p)));
  handle('settings:save', (_, value) => saveSettings(V.settings(value)));
  handle('dialog:directory', async () => {
    const result = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'], title: 'Choose the game directory' });
    if (result.canceled || !result.filePaths[0]) return undefined;
    approveDirectory(result.filePaths[0]);
    return result.filePaths[0];
  });
  handle('dialog:java', async () => {
    const result = await dialog.showOpenDialog(win!, { properties: ['openFile'], title: 'Choose the Java executable' });
    return result.canceled ? undefined : result.filePaths[0];
  });
  handle('java:install', (_, major) => installJavaRuntime(typeof major === 'number' && major >= 8 && major <= 30 ? major : 21, sendProgress));

  handle('mods', async (_, p) => listMods(await existing(p)));
  handle('diagnostics', async (_, p) => getDiagnostics(await existing(p)));
  handle('install', async (_, p) => installProfile(await resolveProfile(V.profileRef(p))));
  handle('mod:set', async (_, p, file, enabled) => setMod(await existing(p), V.fileName(file), V.boolean(enabled, 'mod state')));
  handle('mod:remove', async (_, p, file) => removeMod(await existing(p), V.fileName(file)));
  handle('mod:import', async (_, p, file, data) => importMod(await existing(p), V.fileName(file), V.bytes(data, 'file data', 512 * 1024 * 1024)));
  handle('modpack:import', async (_, p, file, data) => importModpack(await existing(p), V.fileName(file), V.bytes(data, 'file data', 512 * 1024 * 1024)));
  handle('modrinth:search', (_, query, version, loader) => searchMods(String(query ?? '').slice(0, 200), V.versionString(version), V.loaderString(loader)));
  handle('modrinth:versions', (_, project, version, loader) => modVersions(V.modrinthId(project, 'project id'), V.versionString(version), V.loaderString(loader)));
  handle('modrinth:install', async (_, p, version) => installModrinthMod(await existing(p), V.modrinthVersionRef(version)));
  handle('modrinth:update', async (_, p, value) => updateModrinthMod(await existing(p), V.mod(value)));

  // The renderer says "offline" or "Microsoft"; the real token never leaves this process.
  handle('launch', async (_, p, a) => {
    const request = a as { account?: { accessToken?: string }; server?: unknown } | undefined;
    await launchForRenderer(await existing(p), { accessToken: request?.account?.accessToken === 'offline' ? 'offline' : 'msa' }, typeof request?.server === 'string' ? request.server : undefined);
  });
  handle('launch:troubleshoot', async (_, p) => troubleshootLaunch(await existing(p), async variant => {
    // Keep the working options: they become the user's Java arguments (and memory, if the variant needs it).
    const current = await getSettings();
    await saveSettings({ ...current, jvmArgs: variant.jvmArgs.join(' '), ...(variant.maxRam ? { performanceMode: 'balanced' as const, maxRam: variant.maxRam, minRam: Math.min(current.minRam, variant.maxRam - 512) } : {}) });
  }));
  handle('launch:second', async (_, p, name, server) => launchSecondPlayer(await existing(p), String(name ?? ''), String(server ?? '')));
  handle('local-profile:save', (_, profile) => saveLocalProfile(V.localProfile(profile)));
  handle('server:save', (_, server) => saveServer(V.server(server)));
  handle('server:remove', (_, id) => removeServer(V.server({ id, name: 'x', address: 'x' }).id));
  handle('login', (_, clientId) => microsoftDeviceLogin(V.clientId(clientId), message => sendToWindow('login-message', message)));
  handle('modpack:inspect', (_, data) => inspectModpack(V.bytes(data, 'modpack', 512 * 1024 * 1024)));
  handle('skin:local-get', () => getLocalSkin());
  handle('skin:local-set', (_, data) => saveLocalSkin(V.bytes(data, 'skin', 1024 * 1024)));
  handle('skin:local-clear', () => clearLocalSkin());
  handle('skin:mod-status', async (_, p) => hasSkinMod(await existing(p)));
  handle('skin:install-mod', async (_, p) => installSkinMod(await existing(p)));
  handle('skin:upload', (_, data, variant) => uploadSkin(V.bytes(data, 'skin', 1024 * 1024), variant === 'slim' ? 'slim' : 'classic'));
}

if (hasAppLock) {
  app.whenReady().then(async () => {
    registerIpc();
    if (!app.isPackaged && process.env.XAVI_SMOKE === '1') {
      const { runSmoke } = await import('./smoke.js');
      await runSmoke();
      return;
    }
    await createWindow();
  }).catch(error => dialog.showErrorBox('Xavi startup error', error instanceof Error ? error.stack ?? error.message : String(error)));
}
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

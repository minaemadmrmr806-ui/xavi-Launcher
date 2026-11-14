import { contextBridge, ipcRenderer } from 'electron';

const call = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args);
// Every subscription returns an unsubscribe function so React effects can clean up.
const subscribe = <T>(channel: string, callback: (value: T) => void) => {
  const listener = (_: unknown, value: T) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => { ipcRenderer.removeListener(channel, listener); };
};

contextBridge.exposeInMainWorld('launcher', {
  versions: () => call('versions'), profiles: () => call('profiles'), removeProfile: (profile: unknown) => call('profile:remove', profile),
  paths: () => call('paths'), settings: () => call('settings'), saveSettings: (value: unknown) => call('settings:save', value),
  warnings: () => call('warnings'), chooseDirectory: () => call('dialog:directory'), chooseJava: () => call('dialog:java'),
  java: () => call('java'), installJava: (major: number) => call('java:install', major),
  mods: (profile: unknown) => call('mods', profile), diagnostics: (profile: unknown) => call('diagnostics', profile), install: (profile: unknown) => call('install', profile),
  setMod: (profile: unknown, file: string, enabled: boolean) => call('mod:set', profile, file, enabled), removeMod: (profile: unknown, file: string) => call('mod:remove', profile, file),
  importMod: (profile: unknown, file: string, data: Uint8Array) => call('mod:import', profile, file, data), importModpack: (profile: unknown, file: string, data: Uint8Array) => call('modpack:import', profile, file, data),
  searchMods: (query: string, version: string, loader: string) => call('modrinth:search', query, version, loader), modVersions: (project: string, version: string, loader: string) => call('modrinth:versions', project, version, loader),
  installModrinthMod: (profile: unknown, value: unknown) => call('modrinth:install', profile, value), updateModrinthMod: (profile: unknown, mod: unknown) => call('modrinth:update', profile, mod),
  launch: (profile: unknown, account: unknown, server?: string) => call('launch', profile, { account, server }), login: (id: string) => call('login', id),
  uploadSkin: (data: Uint8Array, variant: 'classic' | 'slim') => call('skin:upload', data, variant), account: () => call('account'),
  inspectModpack: (data: Uint8Array) => call('modpack:inspect', data), localSkin: () => call('skin:local-get'), setLocalSkin: (data: Uint8Array) => call('skin:local-set', data), clearLocalSkin: () => call('skin:local-clear'),
  skinModStatus: (profile: unknown) => call('skin:mod-status', profile), installSkinMod: (profile: unknown) => call('skin:install-mod', profile),
  launchSecondPlayer: (profile: unknown, name: string, server: string) => call('launch:second', profile, name, server),
  troubleshoot: (profile: unknown) => call('launch:troubleshoot', profile),
  localProfile: () => call('local-profile'), saveLocalProfile: (profile: unknown) => call('local-profile:save', profile),
  servers: () => call('servers'), saveServer: (server: unknown) => call('server:save', server), removeServer: (id: string) => call('server:remove', id),
  onProgress: (callback: (value: unknown) => void) => subscribe('progress', callback), onLoginMessage: (callback: (value: string) => void) => subscribe('login-message', callback),
  onGameLog: (callback: (value: unknown) => void) => subscribe('game-log', callback), onGameExit: (callback: (value: unknown) => void) => subscribe('game-exit', callback)
});

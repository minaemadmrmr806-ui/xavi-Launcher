import type { TroubleshootOutcome, ModpackInfo, ProfileRef, Account, Diagnostics, GameExit, JavaInfo, LocalProfile, Mod, ModrinthProject, ModrinthVersion, Profile, Server, Settings, Version } from '../shared/types';

type Unsubscribe = () => void;
declare global {
  interface Window {
    launcher: {
      versions: () => Promise<Version[]>;
      profiles: () => Promise<Profile[]>;
      removeProfile: (p: Profile) => Promise<Profile[]>;
      paths: () => Promise<{ root: string; gameDirectory: string }>;
      settings: () => Promise<Settings>;
      saveSettings: (value: Settings) => Promise<Settings>;
      warnings: () => Promise<string[]>;
      chooseDirectory: () => Promise<string | undefined>;
      chooseJava: () => Promise<string | undefined>;
      java: () => Promise<JavaInfo[]>;
      installJava: (major: number) => Promise<JavaInfo>;
      mods: (p: Profile) => Promise<Mod[]>;
      diagnostics: (p: Profile) => Promise<Diagnostics>;
      install: (p: ProfileRef) => Promise<void>;
      setMod: (p: Profile, f: string, e: boolean) => Promise<Mod[]>;
      removeMod: (p: Profile, f: string) => Promise<Mod[]>;
      importMod: (p: Profile, f: string, d: Uint8Array) => Promise<Mod[]>;
      searchMods: (query: string, version: string, loader: string) => Promise<ModrinthProject[]>;
      modVersions: (project: string, version: string, loader: string) => Promise<ModrinthVersion[]>;
      installModrinthMod: (p: Profile, version: ModrinthVersion) => Promise<Mod[]>;
      updateModrinthMod: (p: Profile, mod: Mod) => Promise<Mod[]>;
      importModpack: (p: Profile, fileName: string, d: Uint8Array) => Promise<Mod[]>;
      launch: (p: Profile, a: Account, server?: string) => Promise<void>;
      login: (id: string) => Promise<Account>;
      uploadSkin: (data: Uint8Array, variant: 'classic' | 'slim') => Promise<Account>;
      inspectModpack: (data: Uint8Array) => Promise<ModpackInfo>;
      localSkin: () => Promise<string | undefined>;
      setLocalSkin: (data: Uint8Array) => Promise<void>;
      clearLocalSkin: () => Promise<void>;
      skinModStatus: (p: Profile) => Promise<boolean>;
      installSkinMod: (p: Profile) => Promise<Mod[]>;
      launchSecondPlayer: (p: Profile, name: string, server: string) => Promise<void>;
      troubleshoot: (p: Profile) => Promise<TroubleshootOutcome>;
      account: () => Promise<Account | undefined>;
      localProfile: () => Promise<LocalProfile>;
      saveLocalProfile: (profile: LocalProfile) => Promise<LocalProfile>;
      servers: () => Promise<Server[]>;
      saveServer: (server: Server) => Promise<Server[]>;
      removeServer: (id: string) => Promise<Server[]>;
      onProgress: (cb: (v: { label: string; percent: number }) => void) => Unsubscribe;
      onLoginMessage: (cb: (v: string) => void) => Unsubscribe;
      onGameLog: (cb: (v: { profileId: string; line: string }) => void) => Unsubscribe;
      onGameExit: (cb: (v: GameExit) => void) => Unsubscribe;
    };
  }
}
export {};

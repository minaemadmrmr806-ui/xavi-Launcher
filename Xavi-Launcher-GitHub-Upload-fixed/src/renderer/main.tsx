import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import type { TroubleshootOutcome, Account, Diagnostics, JavaInfo, Loader, LocalProfile, Mod, ModrinthProject, Profile, Server, Settings, Version } from '../shared/types';

const loaders: Loader[] = ['Vanilla', 'Fabric', 'Forge', 'NeoForge'];
type View = 'play' | 'mods' | 'servers' | 'skins' | 'settings';
const normalizeUsername = (value: string) => value.replace(/[^A-Za-z0-9_]/g, '').slice(0, 16) || 'OfflinePlayer';
const messageOf = (value: unknown) => (value instanceof Error ? value.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(value));
const isOffline = (account?: Account) => !account || account.accessToken === 'offline';

function SkinFace({ src }: { src?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const context = ref.current?.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, 64, 64);
    context.imageSmoothingEnabled = false;
    if (!src) return;
    const image = new Image();
    image.onload = () => { context.drawImage(image, 8, 8, 8, 8, 0, 0, 64, 64); context.drawImage(image, 40, 8, 8, 8, 0, 0, 64, 64); };
    image.src = src;
  }, [src]);
  return <canvas ref={ref} width={64} height={64} className="skin-face" />;
}

function App() {
  const [versions, setVersions] = useState<Version[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [mods, setMods] = useState<Mod[]>([]);
  const [diagnostics, setDiagnostics] = useState<Diagnostics>();
  const [view, setView] = useState<View>('play');
  const [progress, setProgress] = useState<{ label: string; percent: number }>();
  const [message, setMessage] = useState('');
  const [logs, setLogs] = useState<string[]>([]);
  const [version, setVersion] = useState('1.21.1');
  const [loader, setLoader] = useState<Loader>('Fabric');
  const [showOld, setShowOld] = useState(false);
  const [versionFilter, setVersionFilter] = useState('');
  const [localProfile, setLocalProfile] = useState<LocalProfile>({ name: 'OfflinePlayer', uuid: '' });
  const [nameDraft, setNameDraft] = useState('OfflinePlayer');
  const [account, setAccount] = useState<Account>();
  const [skinVariant, setSkinVariant] = useState<'classic' | 'slim'>('classic');
  const [servers, setServers] = useState<Server[]>([]);
  const [serverName, setServerName] = useState('');
  const [serverAddress, setServerAddress] = useState('');
  const [settings, setSettings] = useState<Settings>();
  const [java, setJava] = useState<JavaInfo[]>([]);
  const [modQuery, setModQuery] = useState('');
  const [modResults, setModResults] = useState<ModrinthProject[]>([]);
  const [searchingMods, setSearchingMods] = useState(false);
  const [serverProfile, setServerProfile] = useState('');
  const [skinPreview, setSkinPreview] = useState<string>();
  const [skinModInstalled, setSkinModInstalled] = useState(false);
  const [crash, setCrash] = useState<{ profileId: string; code: number; hint?: string }>();
  const [probe, setProbe] = useState<TroubleshootOutcome>();
  const [troubleshooting, setTroubleshooting] = useState(false);
  const [secondName, setSecondName] = useState('Player2');
  const versionChosen = useRef(false);

  const selected = profiles.find(profile => profile.id === selectedId);
  const microsoft = !isOffline(account);
  const shownName = microsoft ? account!.name : localProfile.name;

  const compatible = useMemo(() => {
    const needle = versionFilter.trim().toLowerCase();
    return versions.filter(item => (showOld || item.type === 'release') && (!needle || item.id.toLowerCase().includes(needle)));
  }, [versions, showOld, versionFilter]);

  /* -------------------------------- startup -------------------------------- */
  useEffect(() => {
    if (!window.launcher) { setMessage('Electron bridge unavailable. Run the Xavi desktop app, not the Vite preview.'); return; }
    const offs = [
      window.launcher.onProgress(setProgress),
      window.launcher.onLoginMessage(setMessage),
      window.launcher.onGameLog(value => setLogs(current => [...current.slice(-99), value.line])),
      window.launcher.onGameExit(value => { if (value.code === 0) setCrash(undefined); else setCrash(value); })
    ];
    void (async () => {
      const [available, installed, savedAccount, savedServers, savedSettings, local, javas, warnings] = await Promise.allSettled([
        window.launcher.versions(), window.launcher.profiles(), window.launcher.account(), window.launcher.servers(), window.launcher.settings(), window.launcher.localProfile(), window.launcher.java(), window.launcher.warnings()
      ]);
      // A failed network call (for example the version list while offline) must not hide everything else.
      if (available.status === 'fulfilled') setVersions(available.value); else setMessage(`Could not load the Minecraft version list (${messageOf(available.reason)}). Installed profiles still work.`);
      if (installed.status === 'fulfilled') { setProfiles(installed.value); setSelectedId(installed.value[0]?.id); }
      if (savedAccount.status === 'fulfilled') setAccount(savedAccount.value);
      if (savedServers.status === 'fulfilled') setServers(savedServers.value);
      if (savedSettings.status === 'fulfilled') setSettings(savedSettings.value);
      if (local.status === 'fulfilled') { setLocalProfile(local.value); setNameDraft(local.value.name); }
      if (javas.status === 'fulfilled') setJava(javas.value);
      if (warnings.status === 'fulfilled' && warnings.value.length) setMessage(warnings.value.join(' '));
      window.launcher.localSkin().then(setSkinPreview).catch(() => undefined);
    })();
    return () => offs.forEach(off => off());
  }, []);

  useEffect(() => {
    if (versionChosen.current || !versions.length) return;
    versionChosen.current = true;
    const tested = versions.find(item => item.id === '1.21.1' && item.type === 'release');
    setVersion(tested?.id ?? versions.find(item => item.type === 'release')?.id ?? versions[0].id);
  }, [versions]);

  const refreshMods = useCallback(async (profile?: Profile) => {
    if (!profile) { setMods([]); return; }
    try { setMods(await window.launcher.mods(profile)); } catch (error) { setMessage(messageOf(error)); }
  }, []);
  useEffect(() => { void refreshMods(selected); }, [selectedId, refreshMods]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (view !== 'skins' || !selected || selected.loader === 'Vanilla') { setSkinModInstalled(false); return; }
    window.launcher.skinModStatus(selected).then(setSkinModInstalled).catch(() => setSkinModInstalled(false));
  }, [view, selectedId, mods]); // eslint-disable-line react-hooks/exhaustive-deps

  /* -------------------------------- actions -------------------------------- */
  const run = async (work: () => Promise<void>) => { try { await work(); } catch (error) { setMessage(messageOf(error)); } };

  const createProfile = () => run(async () => {
    const ref = profiles.find(item => item.version === version && item.loader === loader) ?? { id: crypto.randomUUID(), name: `${loader} ${version}`, version, loader };
    setMessage(`Installing ${ref.name}…`);
    try {
      await window.launcher.install({ id: ref.id, name: ref.name, version: ref.version, loader: ref.loader });
      const installed = await window.launcher.profiles();
      setProfiles(installed);
      setSelectedId(ref.id);
      setJava(await window.launcher.java());
      const notes = await window.launcher.warnings();
      setMessage(notes.length ? `${ref.name} is ready. ${notes.join(' ')}` : `${ref.name} is ready.`);
      setView('play');
    } finally { setProgress(undefined); }
  });

  const saveLocalProfile = () => run(async () => {
    const next = await window.launcher.saveLocalProfile({ name: normalizeUsername(nameDraft), uuid: localProfile.uuid });
    setLocalProfile(next); setNameDraft(next.name);
    setMessage(`Local profile saved as ${next.name}.`);
  });

  const launch = (server?: string, profile: Profile | undefined = selected) => run(async () => {
    if (!profile) { setMessage('Create and install a profile first.'); return; }
    if (!profile.installed) { setVersion(profile.version); setLoader(profile.loader); setView('settings'); setMessage(`${profile.name} is not installed. Reinstall it below.`); return; }
    setCrash(undefined);
    try {
      let player: Account;
      if (microsoft) player = account!;
      else {
        const saved = await window.launcher.saveLocalProfile({ name: normalizeUsername(nameDraft), uuid: localProfile.uuid });
        setLocalProfile(saved); setNameDraft(saved.name);
        player = { name: saved.name, uuid: saved.uuid, accessToken: 'offline', expiresAt: Number.MAX_SAFE_INTEGER };
      }
      await window.launcher.launch(profile, player, server);
      setMessage(server ? `Launching ${profile.name} and connecting to ${server}.` : `${profile.name} started.`);
    } finally { setProgress(undefined); }
  });

  /* ---- crash recovery ---- */
  const crashedProfile = crash ? profiles.find(item => item.id === crash.profileId) : undefined;
  const disableAllMods = () => run(async () => {
    if (!crashedProfile) return;
    let list = await window.launcher.mods(crashedProfile);
    for (const mod of list.filter(item => item.enabled)) list = await window.launcher.setMod(crashedProfile, mod.file, false);
    setMods(list); setCrash(undefined);
    setMessage('All mods are disabled. Press Play to test, then re-enable them one by one in Mods.');
  });
  const installVanillaFallback = () => run(async () => {
    if (!crashedProfile) return;
    const ref = { id: crypto.randomUUID(), name: `Vanilla ${crashedProfile.version} (fallback)`, version: crashedProfile.version, loader: 'Vanilla' as Loader };
    setMessage(`Installing ${ref.name}…`);
    try {
      await window.launcher.install(ref);
      const list = await window.launcher.profiles();
      setProfiles(list); setSelectedId(ref.id); setCrash(undefined);
      setMessage(`${ref.name} is ready. Press Play to start without mods.`);
    } finally { setProgress(undefined); }
  });
  const runTroubleshoot = (profile: Profile | undefined = selected) => run(async () => {
    if (!profile) { setMessage('Select a profile first.'); return; }
    if (!profile.installed) { setMessage('Install the profile first.'); return; }
    setTroubleshooting(true); setProbe(undefined); setCrash(undefined);
     setMessage('Testing safe startup options. Failed options will close; the first working option stays open. This can take a few minutes.');
    try {
      const outcome = await window.launcher.troubleshoot(profile);
      setProbe(outcome);
      setSettings(await window.launcher.settings());
       setMessage(outcome.applied ? `Found a working setup: "${outcome.applied}". It was saved, and Minecraft is still running.` : 'None of the safe options kept the game running. Open Settings and send the results to get further help.');
      setView('settings');
    } finally { setTroubleshooting(false); setProgress(undefined); }
  });
  const showCrashLog = () => run(async () => { if (crashedProfile) { setDiagnostics(await window.launcher.diagnostics(crashedProfile)); setView('settings'); } });

  /* ---- one-click modpack: reads the pack, creates a matching profile, installs, imports ---- */
  const importPackAsProfile = (file: File) => run(async () => {
    const data = new Uint8Array(await file.arrayBuffer());
    const info = await window.launcher.inspectModpack(data);
    const ref = { id: crypto.randomUUID(), name: info.name, version: info.version, loader: info.loader, loaderVersion: info.loaderVersion };
    setMessage(`Installing ${info.name} (Minecraft ${info.version}, ${info.loader})…`);
    try {
      await window.launcher.install(ref);
      const list = await window.launcher.profiles();
      setProfiles(list); setSelectedId(ref.id);
      const created = list.find(item => item.id === ref.id);
      if (created) setMods(await window.launcher.importModpack(created, file.name, data));
      setMessage(`${info.name} is ready.`);
    } finally { setProgress(undefined); }
  });

  /* ---- skins ---- */
  const chooseSkin = (file: File) => run(async () => {
    await window.launcher.setLocalSkin(new Uint8Array(await file.arrayBuffer()));
    setSkinPreview(await window.launcher.localSkin());
    setMessage('Skin saved. It is applied to every profile that has the skin mod, each time you launch.');
  });
  const installSkinMod = () => run(async () => {
    if (!selected) return;
    setMods(await window.launcher.installSkinMod(selected));
    setMessage('Skin mod installed for this profile.');
  });

  const microsoftLogin = () => run(async () => {
    const loggedIn = await window.launcher.login(settings?.microsoftClientId || import.meta.env.VITE_MICROSOFT_CLIENT_ID || '');
    setAccount(loggedIn);
    setMessage(`Signed in as ${loggedIn.name}.`);
  });

  const searchMods = () => run(async () => {
    if (!selected || !modQuery.trim()) return;
    setSearchingMods(true);
    try { setModResults(await window.launcher.searchMods(modQuery, selected.version, selected.loader)); } finally { setSearchingMods(false); }
  });
  const installSearchResult = (project: ModrinthProject) => run(async () => {
    if (!selected) return;
    const found = await window.launcher.modVersions(project.project_id, selected.version, selected.loader);
    if (!found[0]) throw new Error('No compatible Modrinth file was found.');
    setMods(await window.launcher.installModrinthMod(selected, found[0]));
    setMessage(`${project.title} installed.`);
  });
  const updateMod = (mod: Mod) => run(async () => { if (selected) { setMods(await window.launcher.updateModrinthMod(selected, mod)); setMessage(`${mod.name} is up to date.`); } });
  const importFiles = (files: FileList | null) => run(async () => {
    if (!selected || !files) return;
    for (const file of Array.from(files)) {
      const data = new Uint8Array(await file.arrayBuffer());
      setMods(file.name.toLowerCase().endsWith('.mrpack') ? await window.launcher.importModpack(selected, file.name, data) : await window.launcher.importMod(selected, file.name, data));
    }
    setMessage('Import finished.');
  });

  const addSecondPlayer = (server: Server) => run(async () => {
    const target = profiles.find(item => item.id === server.profileId) ?? selected;
    if (!target) { setMessage('Create and install a profile first.'); return; }
    await window.launcher.launchSecondPlayer(target, secondName.trim(), server.address);
    setMessage(`${secondName.trim()} is starting on ${server.address}.`);
  });

  const saveServer = () => run(async () => {
    if (!serverAddress.trim()) return;
    setServers(await window.launcher.saveServer({ id: crypto.randomUUID(), name: serverName.trim() || serverAddress.trim(), address: serverAddress.trim(), profileId: serverProfile || undefined }));
    setServerName(''); setServerAddress(''); setServerProfile('');
  });

  const update = (patch: Partial<Settings>) => setSettings(current => (current ? { ...current, ...patch } : current));
  const saveLauncherSettings = () => run(async () => { if (settings) { setSettings(await window.launcher.saveSettings(settings)); setMessage('Settings saved.'); } });
  const browse = (kind: 'directory' | 'java') => run(async () => {
    const chosen = await (kind === 'directory' ? window.launcher.chooseDirectory() : window.launcher.chooseJava());
    if (chosen) update(kind === 'directory' ? { gameDirectory: chosen } : { javaPath: chosen });
  });

  const uploadSkin = (file: File) => run(async () => {
    setAccount(await window.launcher.uploadSkin(new Uint8Array(await file.arrayBuffer()), skinVariant));
    setMessage('Skin uploaded to your authenticated Minecraft profile.');
  });
  const loadDiagnostics = () => run(async () => { if (!selected) { setMessage('Select a profile first.'); return; } setDiagnostics(await window.launcher.diagnostics(selected)); });

  const deleteSelectedProfile = () => run(async () => {
    if (!selected) { setMessage('Select a profile first.'); return; }
    if (!window.confirm(`Delete ${selected.name} and its game files?\n\nYour worlds (saves) are copied to the "backups" folder in Xavi's data directory first.`)) return;
    const remaining = await window.launcher.removeProfile(selected);
    setProfiles(remaining); setSelectedId(remaining[0]?.id);
    setMessage('Profile deleted. Worlds were backed up in XaviLauncher/backups.');
  });

  /* ---------------------------------- view --------------------------------- */
  const nav = (item: View) => <button className={view === item ? 'active' : ''} onClick={() => setView(item)} key={item}><i>{item === 'play' ? '▣' : item === 'mods' ? '◈' : item === 'servers' ? '⌁' : item === 'skins' ? '☺' : '⚙'}</i>{item[0].toUpperCase() + item.slice(1)}</button>;

  return <div className="app"><aside>
    <div className="brand"><span className="cube">◆</span><div><b>XAVI</b><small>JAVA LAUNCHER</small></div></div>
    <nav>{(['play', 'mods', 'servers', 'skins', 'settings'] as const).map(nav)}</nav>
    <div className="account"><div className="avatar">{shownName[0]?.toUpperCase()}</div><div><strong>{shownName}</strong><small>{microsoft ? 'Microsoft account' : 'Local profile'}</small></div><button className="account-switch" onClick={() => setView('settings')} title="Open local profile settings">↗</button></div>
  </aside><main>
    <header><div><span className="eyebrow">{view === 'play' ? 'WELCOME BACK' : view.toUpperCase()}</span><h1>{view === 'play' ? 'Ready to build?' : view === 'mods' ? 'Mod library' : view === 'servers' ? 'Your servers' : view === 'skins' ? 'Skins' : 'Launcher settings'}</h1></div><span className="status"><em /> Services online</span></header>

    {view === 'play' && <>
      <section className="hero"><div>
        <span className="pill">{selected?.loader || 'No profile'} · {selected?.version || 'Choose an installation'}</span>
        <h2>Your next<br /><span>adventure</span> awaits.</h2>
        <p>Offline single-player is available locally; online servers require Microsoft ownership authentication.</p>
        <label className="username">{microsoft ? 'Microsoft account name' : 'Local player name'}<input value={microsoft ? account!.name : nameDraft} disabled={microsoft} maxLength={16} onChange={event => setNameDraft(event.target.value)} /></label>
        <button className="play" onClick={() => void launch()}>▶ <span>Play Minecraft</span></button>
      </div><div className="hero-art"><div className="sun" /><div className="mountain one" /><div className="mountain two" /><div className="tree">♣</div></div></section>
      {crash && <section className="crash"><div><strong>Minecraft closed unexpectedly (code {crash.code})</strong><p>{crash.hint ?? 'No known cause was found. Open the log for details.'}</p></div><div className="header-actions"><button className="outline" onClick={() => void disableAllMods()}>Disable all mods</button><button className="outline" disabled={troubleshooting} onClick={() => void runTroubleshoot(crashedProfile)}>Fix automatically</button><button className="outline" onClick={() => void installVanillaFallback()}>Install vanilla fallback</button><button className="outline" onClick={() => void showCrashLog()}>View log</button><button className="delete" onClick={() => setCrash(undefined)}>×</button></div></section>}
      <section className="section-head"><div><span className="eyebrow">INSTALLATIONS</span><h3>Your profiles</h3></div><div className="header-actions"><label className="outline upload">Import modpack<input type="file" accept=".mrpack" onChange={event => { const file = event.target.files?.[0]; if (file) void importPackAsProfile(file); event.target.value = ''; }} /></label><button className="outline" onClick={() => void deleteSelectedProfile()} disabled={!selected}>Delete selected</button><button className="outline" onClick={() => setView('settings')}>+ New installation</button></div></section>
      <div className="profiles">{profiles.map(profile => <button className={`profile ${selectedId === profile.id ? 'chosen' : ''}`} onClick={() => setSelectedId(profile.id)} key={profile.id}><span className="profile-icon">✦</span><span><strong>{profile.name}</strong><small>{profile.version} · {profile.loader} · {profile.installed ? 'Installed' : 'Not installed'}</small></span><span className="chev">›</span></button>)}{!profiles.length && <div className="empty">Create your first installation in Settings.</div>}</div>
    </>}

    {view === 'mods' && <section className="panel">
      <div className="panel-top"><div><span className="eyebrow">{selected?.name || 'NO PROFILE SELECTED'}</span><h3>Installed mods</h3></div><label className="outline upload">Import mod / pack<input type="file" multiple accept=".jar,.zip,.mrpack" onChange={event => { void importFiles(event.target.files); event.target.value = ''; }} /></label></div>
      <div className="server-add"><input value={modQuery} onChange={event => setModQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void searchMods(); }} placeholder="Search compatible Modrinth mods" /><button className="outline" onClick={() => void searchMods()}>{searchingMods ? 'Searching…' : 'Search'}</button></div>
      {modResults.map(project => <div className="mod" key={project.project_id}><span className="mod-icon">◈</span><span><strong>{project.title}</strong><small>{project.description}</small></span><button className="toggle on" onClick={() => void installSearchResult(project)}>Install</button></div>)}
      {selected && mods.map(mod => <div className="mod" key={mod.file}><span className="mod-icon">◈</span><span><strong>{mod.name}</strong><small>{(mod.size / 1024 / 1024).toFixed(1)} MB · {mod.enabled ? 'Enabled' : 'Disabled'}{mod.projectId ? ' · Modrinth' : ' · Imported'}</small></span>
        {mod.projectId && <button className="outline" onClick={() => void updateMod(mod)}>Update</button>}
        <button className="toggle on" onClick={() => void run(async () => setMods(await window.launcher.setMod(selected, mod.file, !mod.enabled)))}>{mod.enabled ? 'Disable' : 'Enable'}</button>
        <button className="delete" onClick={() => void run(async () => setMods(await window.launcher.removeMod(selected, mod.file)))}>×</button></div>)}
      {selected && !mods.length && <div className="empty">No mods installed yet.</div>}
    </section>}

    {view === 'servers' && <section className="panel">
      <div className="panel-top"><div><span className="eyebrow">MULTIPLAYER</span><h3>Saved servers</h3></div></div>
      <div className="server-add"><input value={serverName} onChange={event => setServerName(event.target.value)} placeholder="Server name" /><input value={serverAddress} onChange={event => setServerAddress(event.target.value)} placeholder="example.aternos.me:25565" /><select value={serverProfile} onChange={event => setServerProfile(event.target.value)}><option value="">Use selected profile</option>{profiles.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><button className="outline" onClick={() => void saveServer()}>Save</button></div>
      <label className="username">Second player name<input value={secondName} maxLength={16} onChange={event => setSecondName(event.target.value)} /></label>
      <p className="legal">“Add player” starts another copy of the game with that name and joins the same server. It works only for servers on this PC or your home network (for example your own test server); public servers need a Microsoft account that owns the game.</p>
      {servers.map(server => <div className="saved-server" key={server.id}><span className="online-dot" /><div><strong>{server.name}</strong><small>{server.address} · {profiles.find(item => item.id === server.profileId)?.name ?? 'selected profile'} · online authentication required</small></div><button className="outline small" onClick={() => void addSecondPlayer(server)}>＋ Add player</button><button className="play small" onClick={() => void launch(server.address, profiles.find(item => item.id === server.profileId) ?? selected)}>▶ Launch</button><button className="delete" onClick={() => void run(async () => setServers(await window.launcher.removeServer(server.id)))}>×</button></div>)}
      {!servers.length && <div className="empty">Save an Aternos or other Java server address above.</div>}
    </section>}

    {view === 'skins' && <section className="panel settings">
      <div><h3>Your skin</h3><p className="legal">Choose a 64×64 PNG once; Xavi applies it to every profile that has the skin mod. Offline players cannot get a Mojang-signed skin, so this works through the CustomSkinLoader mod.</p></div>
      <div className="skin-row"><SkinFace src={skinPreview} /><div><strong>{microsoft ? account!.name : localProfile.name}</strong><small className="legal">{skinPreview ? 'Skin saved' : 'Default skin'}</small></div></div>
      <label className="outline upload">Choose skin PNG<input type="file" accept="image/png" onChange={event => { const file = event.target.files?.[0]; if (file) void chooseSkin(file); event.target.value = ''; }} /></label>
      {skinPreview && <button className="outline" onClick={() => void run(async () => { await window.launcher.clearLocalSkin(); setSkinPreview(undefined); })}>Remove skin</button>}

      <div className="panel-top"><div><span className="eyebrow">{selected ? `${selected.name}` : 'NO PROFILE SELECTED'}</span><h3>Skin mod for this profile</h3></div></div>
      {!selected || selected.loader === 'Vanilla'
        ? <p className="legal">Select a Fabric, Forge or NeoForge profile first. Vanilla profiles cannot load skin mods.</p>
        : skinModInstalled ? <p className="legal">CustomSkinLoader is installed. Your skin is copied in at launch.</p>
        : <button className="play" onClick={() => void installSkinMod()}>＋ Install skin mod</button>}

      {settings && <>
        <label>Shared skin source for friends (optional)<input value={settings.skinSource} onChange={event => update({ skinSource: event.target.value })} placeholder="https://raw.githubusercontent.com/you/skins/main/{USERNAME}.png" /></label>
        <p className="legal">Everyone in your group puts a PNG named after their player name in the same public folder (for example a GitHub repo). Players who also have the skin mod and this address see each other's skins.</p>
        <button className="outline" onClick={() => void saveLauncherSettings()}>Save skin source</button>
      </>}

      {microsoft && <><div className="panel-top"><div><span className="eyebrow">MICROSOFT ACCOUNT</span><h3>Official skin (visible to everyone)</h3></div></div>
        <label>Skin PNG<input type="file" accept="image/png" onChange={event => { const file = event.target.files?.[0]; if (file) void uploadSkin(file); }} /></label>
        <label>Skin model<select value={skinVariant} onChange={event => setSkinVariant(event.target.value as 'classic' | 'slim')}><option value="classic">Classic / Steve</option><option value="slim">Slim / Alex</option></select></label></>}

      <p className="legal"><b>Who sees what:</b> an official Microsoft skin is visible to all players. A skin from the mod is visible only to players who run the same mod (and, for the shared source, use the same address). Players on plain Minecraft will not see it unless the server runs a skin plugin such as SkinsRestorer.</p>
    </section>}

    {view === 'settings' && <section className="panel settings">
      <div><h3>Local profile</h3><p className="legal">This name and UUID are used for offline single-player and local profiles. Microsoft sign-in is separate.</p></div>
      <label>Player name<input value={nameDraft} maxLength={16} onChange={event => setNameDraft(event.target.value)} /></label>
      <button className="outline" onClick={() => void saveLocalProfile()}>Save local profile</button>
      {!microsoft && <button className="outline" onClick={() => void microsoftLogin()}>Sign in with Microsoft (optional)</button>}

      <div className="panel-top"><div><span className="eyebrow">GAME CONFIGURATION</span><h3>New installation</h3></div></div>
      <label>Minecraft version<input value={versionFilter} onChange={event => setVersionFilter(event.target.value)} placeholder="Filter versions, e.g. 1.20" /></label>
      <select value={version} onChange={event => setVersion(event.target.value)}>{compatible.some(item => item.id === version) ? null : <option value={version}>{version}</option>}{compatible.map(item => <option key={item.id} value={item.id}>{item.id}{item.type === 'release' ? '' : ` (${item.type.replace('old_', 'old ')})`}</option>)}</select>
      <label><span><input type="checkbox" checked={showOld} onChange={event => setShowOld(event.target.checked)} /> Show snapshots and old versions</span></label>
      <label>Mod loader<select value={loader} onChange={event => setLoader(event.target.value as Loader)}>{loaders.map(item => <option key={item}>{item}</option>)}</select></label>
      <button className="play" onClick={() => void createProfile()}>＋ Install profile</button>

      {settings && <>
        <h3>Runtime settings</h3>
        <label>Memory mode<select value={settings.performanceMode} onChange={event => update({ performanceMode: event.target.value as Settings['performanceMode'] })}><option value="auto">Auto (recommended for this PC)</option><option value="low">Low</option><option value="high">High</option><option value="balanced">Custom (use the values below)</option></select></label>
        <label>Minimum RAM (MB)<input type="number" value={settings.minRam} onChange={event => update({ minRam: Number(event.target.value) })} /></label>
        <label>Maximum RAM (MB)<input type="number" value={settings.maxRam} onChange={event => update({ maxRam: Number(event.target.value) })} /></label>
        <label>Java executable (leave empty for automatic)<span className="server-add"><input value={settings.javaPath} readOnly placeholder={java[0]?.path || 'Automatic'} /><button className="outline" onClick={() => void browse('java')}>Browse</button><button className="outline" onClick={() => update({ javaPath: '' })}>Clear</button></span></label>
        <label>Game directory<span className="server-add"><input value={settings.gameDirectory} readOnly /><button className="outline" onClick={() => void browse('directory')}>Browse</button></span></label>
        <label>Extra JVM arguments<input value={settings.jvmArgs} onChange={event => update({ jvmArgs: event.target.value })} placeholder="-XX:+UseG1GC" /></label>
        <label><span><input type="checkbox" checked={settings.closeOnLaunch} onChange={event => update({ closeOnLaunch: event.target.checked })} /> Minimise the launcher after starting Minecraft</span></label>
        <label>Microsoft public client ID<input value={settings.microsoftClientId} onChange={event => update({ microsoftClientId: event.target.value })} placeholder="Optional Entra public-client ID" /></label>
        <button className="outline" onClick={() => void saveLauncherSettings()}>Save settings</button>
        <button className="outline" onClick={() => void loadDiagnostics()}>Load profile diagnostics</button>
        <div><h3>Game crashes on startup?</h3><p className="legal">Xavi can test a few safe Java option sets on the selected profile and save the first one that keeps the game running.</p></div>
        <button className="play" disabled={troubleshooting || !selected} onClick={() => void runTroubleshoot()}>{troubleshooting ? 'Testing…' : 'Find a working setup'}</button>
        {probe && <div className="legal">{probe.results.map(result => <p key={result.label}>{result.ok ? '✔' : '✘'} {result.label} — {result.ok ? `stayed running ${result.seconds}s` : `closed after ${result.seconds}s${result.hint ? `: ${result.hint}` : ''}`}</p>)}</div>}
        <small className="legal">Detected Java: {java.length ? java.map(item => `${item.version} (${item.path})`).join(', ') : 'none (Xavi downloads the right one automatically)'}</small>
        {diagnostics && <details open><summary>Saved logs and crash reports</summary><pre>{diagnostics.latestLog || 'No latest.log found.'}</pre>{diagnostics.crashReports.map(report => <details key={report.name}><summary>{report.name}</summary><pre>{report.content}</pre></details>)}</details>}
      </>}
      <p className="legal">Offline profiles are for local testing and single-player. Authenticated accounts can upload official skins; offline names and skins cannot be signed by Minecraft Services.</p>
    </section>}

    {progress && <div className="progress"><div><span>{progress.label}</span><b>{Math.round(progress.percent * 100)}%</b></div><div className="bar"><i style={{ width: `${progress.percent * 100}%` }} /></div></div>}
    {logs.length > 0 && <details className="logs"><summary>Latest game log</summary><pre>{logs.join('')}</pre></details>}
    {message && <div className="toast" onClick={() => setMessage('')}>{message}<span>×</span></div>}
  </main></div>;
}

createRoot(document.getElementById('root')!).render(<App />);

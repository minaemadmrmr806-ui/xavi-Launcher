// Developer-only smoke test (never runs in a packaged app). Usage: npm run smoke
// Env: XAVI_SMOKE_VERSION, XAVI_SMOKE_LOADER, XAVI_SMOKE_LAUNCH=1, XAVI_SMOKE_ROOT, XAVI_SMOKE_REUSE=1
import { app } from 'electron';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Profile } from '../shared/types.js';
import { installProfile, launch, profileDirectory } from './services.js';

export async function runSmoke() {
  const smokeRoot = process.env.XAVI_SMOKE_ROOT || await mkdtemp(join(tmpdir(), 'xavi-launcher-smoke-'));
  app.setPath('appData', smokeRoot);
  const loader = (process.env.XAVI_SMOKE_LOADER || 'Fabric') as Profile['loader'];
  const profile: Profile = { id: `${loader.toLowerCase()}-smoke`, name: `${loader} smoke test`, version: process.env.XAVI_SMOKE_VERSION || '1.21.1', loader, directory: '' };
  try {
    const stored = join(smokeRoot, 'XaviLauncher', 'profiles', profile.id, 'profile.json');
    if (process.env.XAVI_SMOKE_REUSE === '1') Object.assign(profile, JSON.parse(await readFile(stored, 'utf8')));
    else await installProfile(profile, p => console.log(`${Math.round(p.percent * 100)}% ${p.label}`));
    if (!profile.installed) throw new Error('Smoke install did not mark the profile installed.');
    const game = profileDirectory(profile);
    const files = await readdir(join(game, 'versions'), { recursive: true });
    if (loader !== 'Vanilla' && !files.some(file => file.endsWith('.json') && !file.endsWith(`${profile.version}.json`))) throw new Error(`No ${loader} version manifest was produced.`);
    if (process.env.XAVI_SMOKE_LAUNCH === '1') {
      let child: ChildProcess | undefined;
      await launch(profile, { name: 'XaviSmoke', uuid: '58617669000000000000000000000000', accessToken: 'offline', expiresAt: Number.MAX_SAFE_INTEGER }, undefined, c => { child = c; });
      await new Promise(resolve => setTimeout(resolve, 20000));
      const log = await readFile(join(smokeRoot, 'XaviLauncher', 'profiles', profile.id, 'latest.log'), 'utf8');
      child?.kill();
      if (!/Forge|ModLauncher|BootstrapLauncher|KnotClient|Fabric Loader|Minecraft Version|Setting user/i.test(log)) throw new Error(`The game did not initialise. Log tail:\n${log.slice(-4000)}`);
    }
    console.log(JSON.stringify({ ok: true, minecraft: profile.version, loader, loaderVersion: profile.loaderVersion, java: profile.javaMajor }));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.stack ?? error.message : String(error) }));
    process.exitCode = 1;
  } finally {
    if (!process.env.XAVI_SMOKE_ROOT) await rm(smokeRoot, { recursive: true, force: true });
    app.quit();
  }
}

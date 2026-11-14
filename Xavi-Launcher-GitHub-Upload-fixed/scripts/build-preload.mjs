// Bundles the preload into a single CommonJS file so it can run in a sandboxed renderer.
import { build } from 'esbuild';
await build({ entryPoints: ['src/main/preload.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], outfile: 'dist-electron/main/preload.cjs', logLevel: 'info' });

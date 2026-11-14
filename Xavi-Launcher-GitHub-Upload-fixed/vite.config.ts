import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// The CSP is injected only into production builds. In dev, Vite needs an inline React-refresh
// preamble and a websocket, which a strict CSP would block. All network access happens in the
// main process, so the renderer needs no remote connect-src.
const csp: Plugin = {
  name: 'xavi-csp',
  apply: 'build',
  transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://cdn.modrinth.com; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'" }, injectTo: 'head-prepend' }]
};

export default defineConfig({ base: './', plugins: [react(), csp], root: '.', build: { outDir: 'dist', emptyOutDir: true } });

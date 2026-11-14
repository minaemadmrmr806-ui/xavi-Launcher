import { app, BrowserWindow } from 'electron';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { hashesMatch, type Hashes } from './logic.js';

export const root = () => join(app.getPath('appData'), 'XaviLauncher');
export const profileRoot = () => join(root(), 'profiles');
export const backupRoot = () => join(root(), 'backups');

export type Progress = { label: string; percent: number };
export type SendProgress = (value: Progress) => void;
export const emit = (send: SendProgress | undefined, label: string, percent: number) => send?.({ label, percent: Math.max(0, Math.min(1, percent)) });

/* ---------------------------- window messaging ---------------------------- */

export function sendToWindow(channel: string, value: unknown) {
  for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send(channel, value);
}
export const sendProgress: SendProgress = value => sendToWindow('progress', value);

/* ------------------------------ warnings -------------------------------- */

const warnings: string[] = [];
export const addWarning = (message: string) => { warnings.push(message); console.warn(`[xavi] ${message}`); };
export const takeWarnings = () => warnings.splice(0, warnings.length);

/* ------------------------------- JSON files ------------------------------ */

async function renameWithRetry(from: string, to: string) {
  for (let attempt = 0; ; attempt++) {
    try { await rename(from, to); return; } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 4 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw error;
      await new Promise(resolve => setTimeout(resolve, 60 * (attempt + 1)));
    }
  }
}

export async function writeFileAtomic(file: string, data: string | Uint8Array) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try { await writeFile(temporary, data); await renameWithRetry(temporary, file); } catch (error) { await rm(temporary, { force: true }); throw error; }
}
export const writeJsonAtomic = (file: string, value: unknown) => writeFileAtomic(file, JSON.stringify(value, null, 2));

/** Missing file -> fallback. Corrupt file -> moved aside (never silently overwritten) and fallback. */
export async function readJson<T>(file: string, fallback: T): Promise<T> {
  let text: string;
  try { text = await readFile(file, 'utf8'); } catch { return fallback; }
  try { return JSON.parse(text) as T; } catch {
    const backup = `${file}.corrupt-${Date.now()}`;
    await rename(file, backup).catch(() => undefined);
    addWarning(`${file} was unreadable. It was kept as ${backup} and a fresh file will be used.`);
    return fallback;
  }
}

/* --------------------------------- network ------------------------------- */

export const fetchTimeout = (url: string, init: RequestInit = {}, ms = 30000) => fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(ms) });

export async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetchTimeout(url, init);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response.json() as Promise<T>;
}

export async function text(url: string): Promise<string> {
  const response = await fetchTimeout(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response.text();
}

export const sha1Hex = (bytes: Uint8Array) => createHash('sha1').update(bytes).digest('hex');

type DownloadOptions = Hashes & { onBytes?: (received: number, total: number) => void; onDone?: () => void };

/** Streaming download with checksum verification, idle timeout and 3 attempts. */
export async function download(url: string, destination: string, options: DownloadOptions = {}) {
  if (options.sha1 && existsSync(destination)) {
    try { if (sha1Hex(await readFile(destination)) === options.sha1.toLowerCase()) { options.onDone?.(); return; } } catch { /* re-download */ }
  }
  const partial = `${destination}.part`;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const controller = new AbortController();
    let timer = setTimeout(() => controller.abort(), 30000);
    const bump = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), 30000); };
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${url}`);
      await mkdir(dirname(destination), { recursive: true });
      const total = Number(response.headers.get('content-length')) || 0;
      const h1 = createHash('sha1');
      const h512 = createHash('sha512');
      let received = 0;
      const hasher = new Transform({ transform(chunk: Buffer, _encoding, callback) { bump(); h1.update(chunk); if (options.sha512) h512.update(chunk); received += chunk.length; options.onBytes?.(received, total); callback(null, chunk); } });
      await pipeline(Readable.fromWeb(response.body as unknown as WebReadableStream), hasher, createWriteStream(partial));
      if (options.sha1 && h1.digest('hex') !== options.sha1.toLowerCase()) throw new Error(`Checksum mismatch for ${url}`);
      if (options.sha512 && h512.digest('hex') !== options.sha512.toLowerCase()) throw new Error(`Checksum mismatch for ${url}`);
      await renameWithRetry(partial, destination);
      options.onDone?.();
      return;
    } catch (error) {
      lastError = error;
      await rm(partial, { force: true });
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 1000));
    } finally { clearTimeout(timer); }
  }
  throw lastError instanceof Error ? lastError : new Error(`Download failed: ${url}`);
}

/** Small downloads kept in memory. Hash verification is mandatory when requireHash is set. */
export async function downloadBytes(url: string, options: { hashes?: Hashes; requireHash?: boolean; maxBytes?: number } = {}): Promise<Uint8Array> {
  const response = await fetchTimeout(url, {}, 120000);
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (options.maxBytes && bytes.length > options.maxBytes) throw new Error(`Download is larger than the allowed ${Math.round(options.maxBytes / 1048576)} MB: ${url}`);
  const verdict = hashesMatch(bytes, options.hashes);
  if (verdict === false) throw new Error(`Checksum mismatch for ${url}`);
  if (verdict === undefined && options.requireHash) throw new Error(`No checksum is available to verify ${url}`);
  return bytes;
}

export async function runPool(tasks: (() => Promise<void>)[], concurrency = 8) {
  let next = 0;
  const worker = async () => { while (next < tasks.length) { const index = next++; await tasks[index](); } };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
}

/* ------------------------------ profile locks ----------------------------- */

const busy = new Set<string>();
export async function withProfileLock<T>(id: string, work: () => Promise<T>): Promise<T> {
  if (busy.has(id)) throw new Error('This profile is busy (installing or starting). Wait for it to finish.');
  busy.add(id);
  try { return await work(); } finally { busy.delete(id); }
}

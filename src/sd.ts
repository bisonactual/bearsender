// ═══════════════════════════════════════════════
// SD card — list the controller's files, run one, upload one
// ═══════════════════════════════════════════════

import { signal, effect } from '@preact/signals';
import { SD_EXTS } from './state';
import { lsGet } from './ui';
import { log } from './console';
import { sendCmd } from './connection';
import { processGcode } from './gcode';
import * as command from './command';
import * as connection from './stores/connection';

export interface SdFile { name: string; size: number | null; }

/** The G-code files on the card, null until listed. */
export const files = signal<SdFile[] | null>(null);
export const selected = signal<string | null>(null);
export const listing = signal(false);
/** What the last listing or upload said, when it isn't the list itself. */
export const note = signal<string | null>(null);
/** Upload progress: 'uploading', a percentage, or null. */
export const uploading = signal<string | null>(null);

// A new link lists the card again.
effect(() => { if (!connection.connected.value) files.value = null; });

/** The controller's web server, from the WebSocket address (Settings, Options). */
function httpBase(): string {
  const ws = connection.transport.value === 'websocket' && connection.address.value
    ? connection.address.value : (lsGet<{ wsUrl?: string }>('fs-opt-conn', {}).wsUrl ?? '');
  return ws.trim().replace(/^ws(s?):\/\//, 'http$1://').replace(/\/+$/, '');
}

const isGcode = (name: string) => SD_EXTS.has(name.toLowerCase().slice(name.lastIndexOf('.')));

/** $F over the link: [FILE:/path|SIZE:n] lines. Null if the controller refused it. */
async function listByCommand(): Promise<SdFile[] | null> {
  try {
    const reply = await command.send('$F', { quiet: true });
    if (reply.result !== 'ok') return null;
    const out: SdFile[] = [];
    for (const line of reply.lines) {
      const m = line.match(/^\[FILE:([^|\]]+)(?:\|SIZE:(\d+))?/);
      if (m) out.push({ name: m[1], size: m[2] ? parseInt(m[2]) : null });
    }
    return out;
  } catch (e) {
    if (e instanceof command.CommandFailed) return null;
    throw e;
  }
}

/** The controller's web server, as FlexiSender always listed it: the three addresses tried together. */
async function listByHttp(base: string): Promise<SdFile[] | null> {
  const tryPath = async (path: string): Promise<SdFile[]> => {
    const resp = await fetch(base + path, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) throw new Error(String(resp.status));
    const json = await resp.json();
    const list = Array.isArray(json.files) ? json.files : Array.isArray(json) ? json : null;
    if (!list) throw new Error('no list');
    return list.map((f: any) => ({ name: f.name || f.filename || '', size: f.size ?? null }));
  };
  try { return await Promise.any(['/sdfiles', '/sdcard', '/sd'].map(tryPath)); }
  catch (_) { return null; }
}

/** Lists the card: by $F over the link, else from the controller's web server. */
export async function refresh(): Promise<void> {
  if (listing.value) return;
  listing.value = true;
  note.value = null;
  try {
    const base = httpBase();
    const all = (connection.connected.value ? await listByCommand() : null) ?? (base ? await listByHttp(base) : null);
    if (!all) {
      files.value = null;
      note.value = connection.connected.value
        ? 'The controller refused $F, and its web server didn\'t answer. Is a card in?'
        : 'Not connected, and no web server at ' + (base || 'the controller\'s address') + '.';
      log('err', 'SD card: could not list the files ($F, or the web server at ' + base + ')');
      return;
    }
    const nc = all.filter(f => isGcode(f.name));
    files.value = nc;
    if (!nc.some(f => f.name === selected.value)) selected.value = nc[0]?.name ?? null;
    if (!nc.length) note.value = all.length + ' file(s) on the card, none of them G-code.';
    log('info', `SD card: ${nc.length} NC file(s) listed`);
  } finally {
    listing.value = false;
  }
}

/** Runs the selected file from the card ($F=). */
export function runSelected(): void {
  const file = selected.value;
  if (!file) return;
  if (!connection.connected.value) { log('err', 'Not connected — cannot run SD file'); return; }
  sendCmd('$F=/' + file.replace(/^\/+/, ''));
  log('info', `Running SD file: ${file}`);
}

/** Opens a file in BearSender, and uploads it to the card through the controller's web server. */
export function uploadAndOpen(file: File): void {
  const reader = new FileReader();
  reader.onload = e => processGcode(e.target!.result as string, file.name);
  reader.readAsText(file);

  const url = httpBase() + '/upload';
  uploading.value = 'uploading';
  log('info', `Uploading "${file.name}" (${(file.size / 1024).toFixed(1)} KB) to ${url}`);
  const xhr = new XMLHttpRequest();
  const done = (ok: boolean, why: string) => {
    uploading.value = null;
    note.value = ok ? `Uploaded ${file.name} to the card.` : why;
    log(ok ? 'info' : 'err', ok ? `✓ Upload complete: "${file.name}" saved to SD card` : why);
  };
  xhr.upload.addEventListener('progress', e => { if (e.lengthComputable) uploading.value = Math.round(e.loaded / e.total * 100) + '%'; });
  xhr.addEventListener('load', () => done(xhr.status >= 200 && xhr.status < 300,
    `Upload failed: HTTP ${xhr.status} ${xhr.statusText} — check controller is reachable and SD card is mounted`));
  xhr.addEventListener('error', () => done(false, `Upload failed: could not reach ${url} — is the controller connected and does it have a web server?`));
  xhr.addEventListener('timeout', () => done(false, 'Upload timed out — controller did not respond in time'));
  xhr.timeout = 30000;
  xhr.open('POST', url);
  const form = new FormData();
  form.append('file', file, file.name);
  xhr.send(form);
}

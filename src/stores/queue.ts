// ═══════════════════════════════════════════════
// Queue store — the jobs waiting after the loaded one
// ═══════════════════════════════════════════════
//
// Kept in this browser's IndexedDB with the loaded program, so both survive a reload. When a job
// completes and another is queued, the next one is loaded and waits for Start: nothing moves until
// the operator presses it (the owner: "Load next, wait for Start").

import { signal, effect, untracked } from '@preact/signals';
import { jobId } from '../flight-recorder-resume';
import { log } from '../console';
import * as idb from './idb';
import * as job from './job';
import * as messages from './messages';
import * as program from './program';

/** What the Jobs list shows of a queued file, read when it was added. */
export interface Summary {
  id: string;
  lines: number;
  estSeconds: number;
  rows: { tool: number | null; changeLine: number; estSeconds: number; desc: string }[];
  /** The interpreter stopped part way: the times and tools are of the part before. */
  stopped: string | null;
}

export interface Entry { key: string; name: string; text: string; addedAt: number; order: number; summary: Summary; }

/** In order, the next to run first. */
export const entries = signal<Entry[]>([]);

interface Current { name: string; text: string; }

/** The lines BearSender holds for a file: CR, LF or CRLF, trimmed, blank lines dropped (as processGcode). */
export function fileLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/).map(l => l.trim()).filter(l => l.length > 0);
}

function summarize(lines: string[]): Summary {
  const v = program.read(lines, program.context(false));
  return {
    id: jobId(lines), lines: lines.length, estSeconds: v.estSeconds,
    rows: v.rows.map(r => ({ tool: r.tool, changeLine: r.changeLine, estSeconds: r.estSeconds, desc: r.tool !== null ? v.described[r.tool] ?? '' : '' })),
    stopped: v.stopped ? `line ${v.stopped.line}: ${v.stopped.message}` : null,
  };
}

function save(list: Entry[]): void {
  list.forEach((e, k) => { if (e.order !== k) { e.order = k; idb.put('queue', e.key, e); } });
  entries.value = list;
}

function loadFile(text: string, name: string): void {
  import('../gcode').then(g => g.processGcode(text, name));
}

/** ADD TO QUEUE: each file joins the end. With nothing loaded, the first becomes the loaded job. */
export async function add(files: File[]): Promise<void> {
  let list = [...entries.value];
  let loading = !!job.file.value || job.running.value || list.length > 0;
  for (const file of files) {
    const text = fileLines(await file.text()).join('\n');
    if (!loading) { loading = true; loadFile(text, file.name); continue; }
    const e: Entry = {
      key: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: file.name, text,
      addedAt: Date.now(), order: list.length, summary: summarize(fileLines(text)),
    };
    list = [...list, e];
    entries.value = list;
    idb.put('queue', e.key, e);
    log('info', `Queued ${file.name} (${e.summary.lines.toLocaleString('en-GB')} lines), ${list.length} in the queue`);
  }
}

export function remove(key: string): void {
  save(entries.value.filter(e => e.key !== key));
  idb.remove('queue', key);
}

/** Up (−1) or down (+1) one place. */
export function move(key: string, by: number): void {
  const list = [...entries.value];
  const k = list.findIndex(e => e.key === key);
  const to = k + by;
  if (k < 0 || to < 0 || to >= list.length) return;
  [list[k], list[to]] = [list[to], list[k]];
  save(list);
}

/** The next job becomes the loaded one; it waits for Start. */
function loadNext(after: string): void {
  const [next, ...rest] = entries.value;
  if (!next) return;
  save(rest);
  idb.remove('queue', next.key);
  import('../gcode').then(g => {
    g.processGcode(next.text, next.name);
    job.fromQueueAfter.value = after;
    messages.push('job', `${after} completed. Next from the queue: ${next.name}, loaded. Press Start when ready.`);
  });
}

// A job that completed, with another queued: load the next.
effect(() => {
  if (job.result.value !== 'completed') return;
  untracked(() => { if (entries.value.length && job.file.value) loadNext(job.file.value); });
});

// The loaded program, kept so a reload brings it back.
let restored = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
effect(() => {
  const name = job.file.value, lines = job.lines.value;
  if (!restored || !name) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { idb.put('current', 'job', { name, text: lines.join('\n') } satisfies Current); }, 500);
});

// What this browser kept: the queue, and the program that was loaded.
Promise.all([idb.all<Entry>('queue'), idb.get<Current>('current', 'job')]).then(([list, current]) => {
  entries.value = [...list.sort((a, b) => a.order - b.order), ...entries.value];
  if (current && !job.file.value) {
    loadFile(current.text, current.name);
    log('info', `Reloaded ${current.name} and ${list.length} queued job${list.length === 1 ? '' : 's'} from this browser`);
  }
  restored = true;
});

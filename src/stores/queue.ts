// The jobs waiting after the loaded one.
//
// Kept in this browser's IndexedDB with the loaded program, so both survive a reload. When a job
// completes and another is queued, the next one is loaded and waits for Start: nothing moves until
// the operator presses it. That promotion is one transaction:
// a reload finds either the job before, with the next still queued, or the next loaded and out of the
// queue. Adds go one after another, in the order they were asked for. What was kept is checked when
// it is read back: an entry that can't be read is dropped and reported, and the rest kept.

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

function loadFile(text: string, name: string): Promise<void> {
  return import('../gcode').then(g => g.processGcode(text, name));
}

let adding: Promise<void> = Promise.resolve();

/** ADD TO QUEUE: each file joins the end. With nothing loaded, the first becomes the loaded job. A second
 *  Add while one is still reading its files waits for it. */
export function add(files: File[]): Promise<void> {
  const next = adding.then(() => addNow(files));
  adding = next.catch(() => {});
  return next;
}

async function addNow(files: File[]): Promise<void> {
  let loadedOne = false;
  for (const file of files) {
    const text = fileLines(await file.text()).join('\n');
    if (!loadedOne && !job.file.value && !job.running.value && !entries.value.length) {
      loadedOne = true;
      await loadFile(text, file.name);
      continue;
    }
    // The list as it is now: a Remove or a Move may have come while the file was read.
    const list = entries.value;
    const e: Entry = {
      key: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: file.name, text,
      addedAt: Date.now(), order: list.length, summary: summarize(fileLines(text)),
    };
    entries.value = [...list, e];
    idb.put('queue', e.key, e);
    log('info', `Queued ${file.name} (${e.summary.lines.toLocaleString('en-GB')} lines), ${list.length + 1} in the queue`);
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

/** The next job becomes the loaded one; it waits for Start. In this browser it becomes the kept program
 *  and leaves the queue in one transaction. */
function loadNext(after: string): void {
  const [next, ...rest] = entries.value;
  if (!next) return;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }   // a late save of the job before mustn't follow
  const reordered = rest.filter((e, k) => e.order !== k);
  rest.forEach((e, k) => { e.order = k; });
  entries.value = rest;
  idb.write([
    { store: 'current', key: 'job', value: { name: next.name, text: next.text } satisfies Current },
    { store: 'queue', key: next.key, delete: true },
    ...reordered.map(e => ({ store: 'queue' as const, key: e.key, value: e })),
  ]).then(ok => { if (!ok) log('err', `The queue in this browser may not have moved on to ${next.name}: after a reload check the loaded job and the queue.`); });
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

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function isEntry(v: unknown): v is Entry {
  if (!isObject(v) || typeof v.key !== 'string' || typeof v.name !== 'string' || typeof v.text !== 'string' || !isNum(v.addedAt) || !isNum(v.order)) return false;
  const s = v.summary;
  return isObject(s) && typeof s.id === 'string' && isNum(s.lines) && isNum(s.estSeconds) && (s.stopped === null || typeof s.stopped === 'string') &&
    Array.isArray(s.rows) && s.rows.every(r => isObject(r) && (r.tool === null || isNum(r.tool)) && isNum(r.changeLine) && isNum(r.estSeconds) && typeof r.desc === 'string');
}

function isCurrent(v: unknown): v is Current {
  return isObject(v) && typeof v.name === 'string' && typeof v.text === 'string';
}

// What this browser kept: the queue, and the program that was loaded.
Promise.all([idb.validEntries('queue', isEntry, 'queued jobs'), idb.get<unknown>('current', 'job')]).then(([list, current]) => {
  entries.value = [...list.sort((a, b) => a.order - b.order), ...entries.value];
  if (current !== undefined && !isCurrent(current)) {
    messages.push('error', 'The program kept in this browser couldn\'t be read and was dropped. The queue is kept.');
    idb.remove('current', 'job');
  } else if (current && !job.file.value) {
    loadFile(current.text, current.name);
    log('info', `Reloaded ${current.name} and ${list.length} queued job${list.length === 1 ? '' : 's'} from this browser`);
  }
  restored = true;
});

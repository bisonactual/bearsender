// ═══════════════════════════════════════════════
// Runtimes store — how long each file took when it really ran
// ═══════════════════════════════════════════════
//
// Kept per file contents (the job id, the CRC the flight recorder uses), so an edited file of the
// same name never shows another file's times. A run counts when it ran whole from the top and
// completed. It keeps the whole job's time, tool changes included, and each tool's time from the
// end of its tool change to the start of the next one.

import { signal, effect, untracked } from '@preact/signals';
import { jobId } from '../flight-recorder-resume';
import * as idb from './idb';
import * as job from './job';
import * as program from './program';
import type { ToolRow } from './program';

export interface Runtime {
  id: string;
  name: string;
  /** When the run completed. */
  at: number;
  totalMs: number;
  /** One per tool row; null where the run didn't show where that tool started or ended. */
  rowMs: (number | null)[];
  /** Completed runs of this file so far; the times are the last one's. */
  runs: number;
}

export const measured = signal<Record<string, Runtime>>({});

function isRuntime(v: unknown): v is Runtime {
  const r = v as Runtime, num = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
  return !!r && typeof r === 'object' && typeof r.id === 'string' && typeof r.name === 'string' && num(r.at) && num(r.totalMs) && num(r.runs) &&
    Array.isArray(r.rowMs) && r.rowMs.every(ms => ms === null || num(ms));
}

// What was kept is checked as it is read back: a runtime that can't be read is dropped and reported.
idb.validEntries('runtimes', isRuntime, 'runtimes').then(list => {
  const map: Record<string, Runtime> = {};
  for (const r of list) map[r.id] = r;
  measured.value = { ...map, ...measured.value };
});

export function forFile(id: string): Runtime | null {
  return measured.value[id] ?? null;
}

/** When each tool row of the run started and ended, as far as the run has gone. `waiting` is the row
 *  whose tool change is under way. */
export function rowSpans(rows: ToolRow[], changes: job.ToolChange[], startedAt: number | null, endedAt: number | null):
  { spans: { start: number | null; end: number | null }[]; waiting: number | null } {
  const spans = rows.map(() => ({ start: null as number | null, end: null as number | null }));
  let waiting: number | null = null;
  if (!rows.length || startedAt === null) return { spans, waiting };
  spans[0].start = startedAt;
  for (const c of changes) {
    const k = rows.findIndex(r => r.changeLine === c.line);
    if (k < 0) continue;
    // The tool before ends when the hold begins; this one starts when the job goes on. Before the
    // first tool's own change there is nothing to time.
    if (k > 0 && spans[k - 1].start !== null && spans[k - 1].end === null) spans[k - 1].end = c.startedAt;
    spans[k].start = c.endedAt;
    waiting = c.endedAt === null ? k : null;
  }
  if (endedAt !== null) {
    for (const s of spans) if (s.start !== null && s.end === null) s.end = endedAt;
  }
  return { spans, waiting };
}

// A whole run that completed: keep its times, once per run.
let kept: number | null = null;
effect(() => {
  const ended = job.endedAt.value;
  if (ended === null || job.result.value !== 'completed') return;
  untracked(() => {
    const started = job.startedAt.value;
    const v = program.view.value;
    if (job.resumedFrom.value !== null || started === null || started === kept || !v) return;
    kept = started;
    const id = jobId(job.lines.value);
    const { spans } = rowSpans(v.rows, job.changes.value, started, ended);
    const before = measured.value[id];
    const r: Runtime = {
      id, name: job.file.value ?? '—', at: ended, totalMs: ended - started,
      rowMs: spans.map(s => s.start !== null && s.end !== null ? s.end - s.start : null),
      runs: (before?.runs ?? 0) + 1,
    };
    measured.value = { ...measured.value, [id]: r };
    idb.put('runtimes', id, r);
  });
});

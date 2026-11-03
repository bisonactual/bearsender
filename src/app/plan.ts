// The job's times: estimated, measured, and where the run is.
//
// Each tool row's time is the measured one from the last whole run of this file, or else the
// interpreter's estimate: a lower bound, with no acceleration, overrides or waits. Progress is by
// time: the rows before the current one, and the part of the current one up to the line being cut,
// by the interpreter's per-line times.

import { computed } from '@preact/signals';
import * as job from '../stores/job';
import * as program from '../stores/program';
import * as runtimes from '../stores/runtimes';
import * as queue from '../stores/queue';
import { rows, atLine, mode } from './mode';

export interface RowTime {
  /** The time the plan counts for the row, ms. */
  ms: number;
  measured: boolean;
  /** When the row started and ended in this run, if it has. */
  start: number | null;
  end: number | null;
}

export const plan = computed(() => {
  const rs = rows.value;
  const v = program.view.value;
  const run = runtimes.measured.value[job.fileId.value] ?? null;
  // Measured times only when the run's rows are the program's rows.
  const fits = !!run && run.rowMs.length === rs.length;
  const { spans, waiting } = runtimes.rowSpans(rs, job.changes.value, job.startedAt.value, job.endedAt.value);
  const times: RowTime[] = rs.map((r, k) => {
    const m = fits ? run!.rowMs[k] : null;
    return { ms: m ?? r.estSeconds * 1000, measured: m !== null, start: spans[k].start, end: spans[k].end };
  });
  const rowsMs = times.reduce((a, t) => a + t.ms, 0);
  const allMeasured = times.length > 0 && times.every(t => t.measured);
  // Progress by time.
  const line = atLine.value;
  const k = program.rowAt(rs, line);
  let doneMs = 0;
  if (job.result.value === 'completed') doneMs = rowsMs;
  else if (v && rs.length && (job.running.value || job.result.value !== null) && line > 0) {
    for (let j = 0; j < k; j++) doneMs += times[j].ms;
    if (waiting === null || waiting > k) {
      const r = rs[k], whole = v.cum[r.end] - v.cum[r.start - 1];
      const part = v.cum[Math.min(line, r.end)] - v.cum[r.start - 1];
      doneMs += whole > 0 ? times[k].ms * Math.min(1, Math.max(0, part / whole)) : 0;
    }
  }
  if (waiting !== null) { doneMs = 0; for (let j = 0; j < waiting; j++) doneMs += times[j].ms; }
  return {
    times, rowsMs, allMeasured, run: fits ? run : null, current: waiting ?? k, waiting,
    /** The whole job: the measured run with its tool changes, or the rows' estimates. */
    totalMs: fits ? run!.totalMs : rowsMs,
    doneMs, leftMs: Math.max(0, rowsMs - doneMs),
  };
});

/** When each row starts, ms from now while running; ms from the job's start when ready. */
export const rowStarts = computed(() => {
  const p = plan.value;
  const live = mode.value === 'running' || mode.value === 'hold' || mode.value === 'change';
  const out: number[] = [];
  if (live) {
    // What is left of the current row, then each row after it in turn. Tool change waits aren't counted.
    let through = 0;
    for (let j = 0; j <= p.current && j < p.times.length; j++) through += p.times[j].ms;
    let t = Math.max(0, through - p.doneMs);
    for (let j = 0; j < p.times.length; j++) {
      if (j <= p.current) { out.push(0); continue; }
      out.push(t);
      t += p.times[j].ms;
    }
    return { live, rows: out, endMs: t };
  }
  let t = 0;
  for (const time of p.times) { out.push(t); t += time.ms; }
  return { live, rows: out, endMs: p.totalMs };
});

/** A queued job's time: measured from a whole run of that file, or the estimate. */
export function queuedMs(e: queue.Entry): { ms: number; measured: boolean } {
  const run = runtimes.measured.value[e.summary.id];
  return run ? { ms: run.totalMs, measured: true } : { ms: e.summary.estSeconds * 1000, measured: false };
}

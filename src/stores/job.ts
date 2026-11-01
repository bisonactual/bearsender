// ═══════════════════════════════════════════════
// Job store — the loaded file and the run in progress
// ═══════════════════════════════════════════════

import { signal, computed } from '@preact/signals';
import { lsGet, lsSet } from '../ui';
import { push } from './messages';

export type JobResult = 'completed' | 'stopped' | 'error' | 'alarm' | 'link lost';

export interface LastJob { name: string; result: JobResult; endedAt: number; runtimeMs: number; }

const LAST_JOB_KEY = 'fs-last-job';

export interface AxisRange { xMin: number; xMax: number; yMin: number; yMax: number; zMin: number; zMax: number; hasX: boolean; hasY: boolean; hasZ: boolean; }
/** computeProgLimits(): overall in machine coordinates, and per work offset in that offset's coordinates. */
export interface ProgLimits { overall: AxisRange | null; perWcs: Record<string, AxisRange>; order: string[]; }

export const file = signal<string | null>(null);
/** The loaded program's extents, from computeProgLimits(). */
export const limits = signal<ProgLimits | null>(null);
/** The file's lines as BearSender holds them (blank lines dropped). Line numbers count these, from 1. */
export const lines = signal<string[]>([]);
export const running = signal(false);
export const paused = signal(false);
/** The lines carry N numbers (flight recorder), so the status report's Ln is a line of the file. */
export const numbered = signal(false);
/** The line most recently sent. */
export const sentLine = signal(0);
/** The line the controller most recently accepted (its ok came back). */
export const ackedLine = signal(0);
/** Ln from the status report. Only a line of the file when the job is numbered. */
export const reportedLine = signal(0);
export const startedAt = signal<number | null>(null);
export const endedAt = signal<number | null>(null);
/** How the last run ended; null while running and before the first run. */
export const result = signal<JobResult | null>(null);
export const lastJob = signal<LastJob | null>(lsGet<LastJob | null>(LAST_JOB_KEY, null));

/** Ticks once a second, for the elapsed time. */
export const now = signal(Date.now());
setInterval(() => { now.value = Date.now(); }, 1000);

/** The line being cut: from Ln with the flight recorder, otherwise the last line the controller accepted. */
export const executingLine = computed(() => numbered.value ? reportedLine.value : ackedLine.value);

export const elapsedMs = computed(() => {
  const start = startedAt.value;
  if (start === null) return 0;
  return (endedAt.value ?? now.value) - start;
});

export function loaded(name: string, fileLines: string[]): void {
  file.value = name;
  lines.value = fileLines;
  result.value = null;
  startedAt.value = null;
  endedAt.value = null;
  sentLine.value = 0;
  ackedLine.value = 0;
  reportedLine.value = 0;
}

export function started(isNumbered: boolean, resumedAt?: number): void {
  numbered.value = isNumbered;
  startedAt.value = Date.now();
  endedAt.value = null;
  result.value = null;
  sentLine.value = 0;
  ackedLine.value = 0;
  reportedLine.value = 0;
  push('job', (resumedAt ? `Job resumed from line ${resumedAt.toLocaleString('en-GB')}: ` : 'Job started: ') + (file.value ?? 'the loaded file') + '.');
}

/** A run ended. Keeps it as the last job, with its measured runtime. */
export function finished(how: JobResult): void {
  if (startedAt.value === null || endedAt.value !== null) return;
  const end = Date.now();
  endedAt.value = end;
  result.value = how;
  const last: LastJob = { name: file.value ?? '—', result: how, endedAt: end, runtimeMs: end - startedAt.value };
  lastJob.value = last;
  lsSet(LAST_JOB_KEY, last);
  const words: Record<JobResult, string> = {
    completed: 'Job completed', stopped: 'Job stopped', error: 'Job halted on an error',
    alarm: 'Job stopped by an alarm', 'link lost': 'Connection lost mid-job',
  };
  push('job', `${words[how]}: ${last.name}, after ${fmtDuration(last.runtimeMs)}.`);
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

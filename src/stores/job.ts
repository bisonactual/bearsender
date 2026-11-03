// The loaded file and the run in progress.

import { signal, computed } from '@preact/signals';
import { lsGet, lsSet } from '../ui';
import { push } from './messages';
import { jobId } from '../flight-recorder-resume';

export type JobResult = 'completed' | 'stopped' | 'error' | 'alarm' | 'link lost';

/** `id` is the file's contents (jobId), so an edited file of the same name isn't taken for it. */
export interface LastJob { name: string; id?: string; result: JobResult; endedAt: number; runtimeMs: number; }

const LAST_JOB_KEY = 'fs-last-job';

export interface AxisRange { xMin: number; xMax: number; yMin: number; yMax: number; zMin: number; zMax: number; hasX: boolean; hasY: boolean; hasZ: boolean; }
/** From the interpreter's bounds (gcode.ts): overall in machine coordinates, and per work offset in that offset's coordinates. */
export interface ProgramLimits { overall: AxisRange | null; perWcs: Record<string, AxisRange>; order: string[]; }

export const file = signal<string | null>(null);
/** The loaded program's extents, for the limits card and FRAME. */
export const limits = signal<ProgramLimits | null>(null);
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
/** The line the controller refused, when the last run ended on an error. */
export const halt = signal<{ line: number; code: number; why: string } | null>(null);
/** Stop has sent the hold and waits for the machine to stop before the reset. */
export const stopping = signal(false);
/** Why Start sent nothing (the recorder refused the job stamp), until the next start or file. */
export const notice = signal<string | null>(null);
/** The run started part way through (a resume from the flight record), at this line. */
export const resumedFrom = signal<number | null>(null);

/** A tool change of the run: the M6's line, when the hold began and when the job went on. `held` is
 *  false for an M6 the controller passed without a tool change (the same tool, or $341=4). */
export interface ToolChange { line: number; startedAt: number; endedAt: number | null; held: boolean; }
/** The run's tool changes so far, in order. */
export const changes = signal<ToolChange[]>([]);
/** BearSender holds the job at an M6 the controller passed without a tool change ("Hold at every M6"),
 *  until Resume. The controller is idle meanwhile. */
export const heldAtM6 = signal(false);
/** The job ends at an M2/M30 with lines after it, which aren't sent ("Run lines after M30" off). */
export const endsEarly = signal<{ line: number; left: number } | null>(null);
/** The file loaded itself from the queue when the job before it completed: that job's name. */
export const fromQueueAfter = signal<string | null>(null);

/** The controller has stopped at an M6 (streaming.ts). */
export function changeStarted(line: number, held: boolean): void {
  const now = Date.now();
  changes.value = [...changes.value, { line, startedAt: now, endedAt: held ? null : now, held }];
}

/** The job goes on after the tool change. */
export function changeEnded(): void {
  const list = changes.value;
  const last = list[list.length - 1];
  if (last && last.endedAt === null) changes.value = [...list.slice(0, -1), { ...last, endedAt: Date.now() }];
}

/** The loaded file's contents ID (the flight recorder's CRC), for the runtimes and the sound toggles. */
export const fileId = computed(() => jobId(lines.value));

/** The last run, if it was of the loaded file as it is now. */
export const lastOfThisFile = computed(() => {
  const last = lastJob.value;
  return last && last.name === file.value && last.id === fileId.value ? last : null;
});

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
  halt.value = null;
  notice.value = null;
  resumedFrom.value = null;
  changes.value = [];
  fromQueueAfter.value = null;
  endsEarly.value = null;
}

export function started(isNumbered: boolean, resumedAt?: number): void {
  numbered.value = isNumbered;
  notice.value = null;
  startedAt.value = Date.now();
  endedAt.value = null;
  result.value = null;
  sentLine.value = 0;
  ackedLine.value = 0;
  reportedLine.value = 0;
  resumedFrom.value = resumedAt ?? null;
  changes.value = [];
  fromQueueAfter.value = null;
  push('job', (resumedAt ? `Job resumed from line ${resumedAt.toLocaleString('en-GB')}: ` : 'Job started: ') + (file.value ?? 'the loaded file') + '.');
}

/** A run ended. Keeps it as the last job, with its measured runtime. */
export function finished(how: JobResult): void {
  if (startedAt.value === null || endedAt.value !== null) return;
  const end = Date.now();
  endedAt.value = end;
  result.value = how;
  const last: LastJob = { name: file.value ?? '-', id: jobId(lines.value), result: how, endedAt: end, runtimeMs: end - startedAt.value };
  lastJob.value = last;
  lsSet(LAST_JOB_KEY, last);
  const words: Record<JobResult, string> = {
    completed: 'Job completed', stopped: 'Job stopped', error: 'Job halted on an error',
    alarm: 'Job stopped by an alarm', 'link lost': 'Connection lost mid-job',
  };
  push('job', `${words[how]}: ${last.name}, after ${formatDuration(last.runtimeMs)}.`);
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

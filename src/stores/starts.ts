// ═══════════════════════════════════════════════
// Starts store — the modes each job started from, for a resume
// ═══════════════════════════════════════════════
//
// Kept per file contents (the job id, the CRC the flight recorder uses), in this browser next to the
// runtimes. Start reads $G (streaming.ts) and keeps its words here for a run from the top. A resume
// after a reset, a reboot or a lost link reads the program from these, not from the modes the
// controller is in by then, which a reset puts back to its defaults. The record on the controller
// keeps the line, the position, the tool and the work offset, but not the modes.

import { signal } from '@preact/signals';
import { jobId } from '../flight-recorder-resume';
import * as idb from './idb';

export interface Start {
  id: string;
  name: string;
  /** When the job was started. */
  at: number;
  /** The [GC:] words $G gave at Start, or null if it got no answer. */
  modes: string[] | null;
}

export const kept = signal<Record<string, Start>>({});

function isStart(v: unknown): v is Start {
  const s = v as Start;
  return !!s && typeof s === 'object' && typeof s.id === 'string' && typeof s.name === 'string' && typeof s.at === 'number' &&
    (s.modes === null || (Array.isArray(s.modes) && s.modes.every(w => typeof w === 'string')));
}

idb.validEntries('starts', isStart, 'job start modes').then(list => {
  const map: Record<string, Start> = {};
  for (const s of list) map[s.id] = s;
  kept.value = { ...map, ...kept.value };
});

/** Start of a run from the top: keep the modes it starts from. */
export function keep(lines: string[], name: string, modes: string[] | null): void {
  const s: Start = { id: jobId(lines), name, at: Date.now(), modes };
  kept.value = { ...kept.value, [s.id]: s };
  idb.put('starts', s.id, s);
}

export function forJob(id: string): Start | null {
  return kept.value[id.toUpperCase()] ?? null;
}

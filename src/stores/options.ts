// ═══════════════════════════════════════════════
// Options store — BearSender's own choices for jobs and the resume, kept in this browser
// ═══════════════════════════════════════════════
//
// Set in Options (index.html, wired in options.ts). The owner chose each default:
//   - "Hold at every M6" off: the job holds only where the controller really changes tools. An M6 for
//     the tool already loaded, or one the controller ignores ($341=4), carries on.
//   - "Run lines after M30" off: the job ends at the first M2/M30, and the lines after it aren't sent.
//     On, the file goes as it is and the interpreter follows grblHAL past the program end.
//   - "Resume lift" 5 mm below machine zero: the resume's first move goes up to machine Z -5 unless the
//     tool is already higher, and crosses XY at the higher of the two (away from the homing switch).

import { signal, effect } from '@preact/signals';
import { lsGet, lsSet } from '../ui';

export const holdEveryM6 = signal(lsGet<boolean>('fs-opt-hold-every-m6', false));
export const runAfterM30 = signal(lsGet<boolean>('fs-opt-run-after-m30', false));
/** mm below machine zero. */
export const resumeLiftMm = signal(validLift(lsGet<number>('fs-opt-resume-lift', 5)));

function validLift(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 5;
}

export function setResumeLift(v: number): void { resumeLiftMm.value = validLift(v); }

effect(() => lsSet('fs-opt-hold-every-m6', holdEveryM6.value));
effect(() => lsSet('fs-opt-run-after-m30', runAfterM30.value));
effect(() => lsSet('fs-opt-resume-lift', resumeLiftMm.value));

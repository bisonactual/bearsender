// BearSender's own choices for jobs and the resume, kept in this browser and set in Settings, Options.
// The defaults:
//   - "Hold at every M6" off: the job holds only where the controller really changes tools. An M6 for
//     the tool already loaded, or one the controller ignores ($341=4), carries on.
//   - "Run lines after M30" off: the job ends at the first M2/M30, and the lines after it aren't sent.
//     On, the file goes as it is and the interpreter follows grblHAL past the program end.
//   - "Resume lift" 5 mm below machine zero: the resume's first move goes up to machine Z -5 unless the
//     tool is already higher, and crosses XY at the higher of the two (away from the homing switch).
//   - "Coolant" mist: the Run tab's COOLANT button toggles mist (M7); it can be flood (M8) instead.
//   - "Park point" machine X -5, Y -5, with Z at the top of its travel: where PARK goes (park.ts).

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

export type Coolant = 'mist' | 'flood';
export const coolant = signal<Coolant>(lsGet<string>('fs-opt-coolant', 'mist') === 'flood' ? 'flood' : 'mist');

/** Machine coordinates in mm; Z null is the top of the Z travel, as the homing settings give it. */
export interface ParkPoint { x: number; y: number; z: number | null; }
export const PARK_DEFAULT: ParkPoint = { x: -5, y: -5, z: null };
export const parkPoint = signal<ParkPoint>(validPark(lsGet<unknown>('fs-opt-park', PARK_DEFAULT)));

function validPark(v: unknown): ParkPoint {
  const p = v as Partial<ParkPoint> | null;
  const ok = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
  if (!p || !ok(p.x) || !ok(p.y) || !(p.z === null || ok(p.z))) return { ...PARK_DEFAULT };
  return { x: p.x!, y: p.y!, z: p.z! };
}

export function setParkPoint(p: ParkPoint): void { parkPoint.value = validPark(p); }

effect(() => lsSet('fs-opt-hold-every-m6', holdEveryM6.value));
effect(() => lsSet('fs-opt-run-after-m30', runAfterM30.value));
effect(() => lsSet('fs-opt-resume-lift', resumeLiftMm.value));
effect(() => lsSet('fs-opt-coolant', coolant.value));
effect(() => lsSet('fs-opt-park', parkPoint.value));

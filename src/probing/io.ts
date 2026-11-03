// ═══════════════════════════════════════════════
// What a probing routine moves with: the machine (probe-program.ts machineIo), or the drawing's dry
// run over a virtual part (plan.ts), so the drawing shows the moves the machine makes, step for step.
// ═══════════════════════════════════════════════

export interface Point { x: number; y: number; z: number; }

/** A step of a routine: where it goes, and how. A touch is six: the fast probe to the contact, the
 *  contact, the back-off, the slow probe, the contact again, and the back-off. */
export type StepType = 'start' | 'rapid' | 'probe' | 'contact' | 'back' | 'slow' | 'result';
export interface Step extends Point { type: StepType; label: string; }

export interface Io {
  /** A rapid in machine coordinates (null: that axis stays); 'result' marks the routine's last move.
   *  Throws Stop if the move was refused or the routine cancelled. */
  move(x: number | null, y: number | null, z: number | null, label: string, type?: 'rapid' | 'result'): Promise<void>;
  /** A touch along one axis: fast probe, back off, slow probe, back off. Where the slow probe touched.
   *  Throws Miss if nothing was touched, Stop if a move was refused or the routine cancelled. */
  touch(axis: 'X' | 'Y' | 'Z', dir: number, distance: number, face: string): Promise<Point>;
}

/** The routine stopped: cancelled, or a command refused or not answered. */
export class Stop extends Error {
  constructor(readonly why: string) { super(why); }
}

/** No contact: on what, within how far, and on which touch. */
export class Miss extends Error {
  constructor(readonly face: string, readonly distance: number, readonly slow: boolean) {
    super(`No contact on the ${face} within ${distance} mm`);
  }
}

/** Runs `work`; after a Miss, runs `recover` (a Stop meanwhile is ignored: it is ending anyway) and throws the Miss on. */
export async function afterMiss<T>(work: () => Promise<T>, recover: () => Promise<void>): Promise<T> {
  try { return await work(); }
  catch (e) {
    if (e instanceof Miss) { try { await recover(); } catch (s) { if (!(s instanceof Stop)) throw s; } }
    throw e;
  }
}

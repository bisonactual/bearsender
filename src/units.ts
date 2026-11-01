// ═══════════════════════════════════════════════
// Units — BearSender works in millimetres
// ═══════════════════════════════════════════════
//
// Every command BearSender makes itself (jogs, probing, zeros, offset writes) says G21, so it means
// millimetres whatever the last job left (G20). grblHAL reports positions, offsets and feeds in
// inches when $13 bit 0 is set; they are read into millimetres here.

import * as machine from './stores/machine';

/** A position, offset or feed from a report, in mm. */
export function reportMm(v: number): number {
  const report = parseInt(machine.settings.value[13] ?? '');
  return !isNaN(report) && (report & 1) ? v * 25.4 : v;
}

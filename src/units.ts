// BearSender works in millimetres. Every command it makes itself (jogs, probing, zeros, offset writes)
// says G21, whatever the last job left. grblHAL reports positions, offsets and feeds in inches when
// $13 bit 0 is set; they are converted to millimetres here.

import * as machine from './stores/machine';

/** A position, offset or feed from a report, in mm. */
export function reportMm(v: number): number {
  const report = parseInt(machine.settings.value[13] ?? '');
  return !isNaN(report) && (report & 1) ? v * 25.4 : v;
}

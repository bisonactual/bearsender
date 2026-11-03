// ═══════════════════════════════════════════════
// PARK — the bottom bar's move to the park point (Settings, Options)
// ═══════════════════════════════════════════════
//
// The way there is the warmup's way to its start point (warmup.ts, wayTo): Z up first, to the higher of
// the park Z and where the tool is, so it never goes down while crossing; then over to X and Y; then to
// the park Z. All G53, in mm. The park Z defaults to the top of the Z travel as the controller allows
// it (machine.zTravel `max`): the very top (`top`) less the pull-off when hard limits are on, since a
// move to the top itself would be past the soft limit.

import { log } from './console';
import { sendCmd } from './connection';
import { wayTo, progress as warmupProgress } from './warmup';
import * as connection from './stores/connection';
import * as machine from './stores/machine';
import * as job from './stores/job';
import * as options from './stores/options';

/** The park point in machine coordinates, its Z worked out; null while the Z travel isn't known. */
export function target(): machine.Vec3 | null {
  const p = options.parkPoint.value;
  const z = p.z ?? machine.zTravel.value?.max;
  return z === undefined ? null : { x: p.x, y: p.y, z };
}

/** Why PARK does nothing now, in a few words, or null. */
export function whyNot(): string | null {
  if (!connection.connected.value) return 'not connected';
  if (job.running.value) return 'job running';
  if (warmupProgress.value) return 'warmup running';
  const s = machine.stateName.value;
  if (s !== 'idle') return s ? 'machine ' + (s === 'tool' ? 'at a tool change' : s) : 'no status yet';
  if (!target()) return 'Z travel not read';
  return null;
}

/** PARK: one tap, or a line in the console saying why nothing went. */
export function park(): void {
  const why = whyNot();
  if (why) { log('info', 'PARK: nothing was sent (' + why + ')'); return; }
  const t = target()!;
  const lines = wayTo(t, machine.mpos.peek().z);
  lines[0] = 'G21' + lines[0];
  log('info', `PARK: to machine X${t.x.toFixed(3)} Y${t.y.toFixed(3)} Z${t.z.toFixed(3)}, Z up first`);
  sendCmd(lines.join('\n'));
}

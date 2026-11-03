// PARK: the bottom bar's move to the park point set in Settings, Options. It goes the warmup's way
// (warmup.ts wayTo): Z up first, to the higher of the park Z and the tool's, then over to X and Y,
// then to the park Z, all G53 in mm. The park Z defaults to the highest Z the controller allows
// (machine.zTravel max): the very top less the pull-off when hard limits are on, since a move to the
// top itself would pass the soft limit.

import { log } from './console';
import { sendCmd } from './connection';
import { wayTo, progress as warmupProgress } from './warmup';
import * as connection from './stores/connection';
import * as machine from './stores/machine';
import * as job from './stores/job';
import * as options from './stores/options';

/** The park point in machine coordinates, its Z worked out; null while the Z travel isn't known. */
export function parkTarget(): machine.Vec3 | null {
  const saved = options.parkPoint.value;
  const z = saved.z ?? machine.zTravel.value?.max;
  return z === undefined ? null : { x: saved.x, y: saved.y, z };
}

/** Why PARK does nothing now, in a few words, or null. */
export function whyNot(): string | null {
  if (!connection.connected.value) return 'not connected';
  if (job.running.value) return 'job running';
  if (warmupProgress.value) return 'warmup running';
  const s = machine.stateName.value;
  if (s !== 'idle') return s ? 'machine ' + (s === 'tool' ? 'at a tool change' : s) : 'no status yet';
  if (!parkTarget()) return 'Z travel not read';
  return null;
}

/** PARK: one tap, or a line in the console saying why nothing went. */
export function park(): void {
  const why = whyNot();
  if (why) { log('info', 'PARK: nothing was sent (' + why + ')'); return; }
  const point = parkTarget()!;
  const lines = wayTo(point, machine.mpos.peek().z);
  lines[0] = 'G21' + lines[0];
  log('info', `PARK: to machine X${point.x.toFixed(3)} Y${point.y.toFixed(3)} Z${point.z.toFixed(3)}, Z up first`);
  sendCmd(lines.join('\n'));
}

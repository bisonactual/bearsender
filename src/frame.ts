// ═══════════════════════════════════════════════
// Program limits and framing — the program's extents per work offset, and a rapid round them
// ═══════════════════════════════════════════════

import { signal, computed, effect } from '@preact/signals';
import { lsGet, lsSet } from './ui';
import { log } from './console';
import { sendCmd } from './connection';
import * as connection from './stores/connection';
import * as machine from './stores/machine';
import * as job from './stores/job';
import type { AxisRange } from './stores/job';
import { progress as warmupProgress } from './warmup';

export interface LimitsTab { id: string; label: string; stats: AxisRange; frameable: boolean; }

/** The tab picked: Overall, or one of the program's work offsets. */
export const picked = signal<string | null>(null);
/** Safe Z, and what it is measured from: 'absolute' (machine Z, G53) or a work offset. */
export const safeZ = signal(lsGet('fs-frame-safe-z', 5));
export const safeRef = signal(lsGet('fs-frame-safe-ref', 'absolute'));
/** Why the last frame wasn't sent, until the next one. */
export const refusal = signal<string | null>(null);

effect(() => lsSet('fs-frame-safe-z', safeZ.value));
effect(() => lsSet('fs-frame-safe-ref', safeRef.value));

export const tabs = computed<LimitsTab[]>(() => {
  const limits = job.limits.value;
  if (!limits?.overall) return [];
  const list: LimitsTab[] = [{ id: 'overall', label: 'Overall', stats: limits.overall, frameable: false }];
  for (const code of limits.order) {
    const stats = limits.perWcs[code];
    if (stats) list.push({ id: code, label: code, stats, frameable: true });
  }
  return list;
});

/** The tab in view: the one picked, else the active work offset's, else Overall. */
export const selected = computed<LimitsTab | null>(() => {
  const list = tabs.value;
  if (!list.length) return null;
  return list.find(t => t.id === picked.value) ?? list.find(t => t.id === machine.wcs.value) ?? list[0];
});

// Hard limit: no absolute machine coordinate may exceed -1.
// Returns list of violating axis names, or empty if all clear.
function checkAbsoluteBounds(coords: { axis: string; absVal: number }[]): string[] {
  const BAD_LIMIT = -1;
  return coords.filter(c => c.absVal > BAD_LIMIT).map(c => `${c.axis} (${c.absVal.toFixed(3)})`);
}

/** Why FRAME does nothing now, in a few words, or null. Its moves would go between a job's or the
 *  warmup's lines, or after them; the controller takes them only when idle. */
export function whyNot(): string | null {
  if (!connection.connected.value) return 'not connected';
  if (!selected.value) return 'no program';
  if (job.running.value) return 'job running';
  if (warmupProgress.value) return 'warmup running';
  const s = machine.stateName.value;
  if (s !== 'idle') return s ? 'machine ' + (s === 'tool' ? 'at a tool change' : s) : 'no status yet';
  return null;
}

/** Lifts to safe Z, then rapids round the selected work offset's X and Y extents. */
export function frame(): void {
  const sel = selected.value;
  if (!connection.connected.value || !sel || !sel.frameable) return;
  const why = whyNot();
  if (why) { refusal.value = 'Not framed: ' + why + '.'; return; }
  const z = safeZ.value;
  if (!Number.isFinite(z)) { refusal.value = 'Safe Z is not a number.'; log('err', 'Frame: invalid Safe Z value'); return; }

  const ref = safeRef.value;
  const offsets = machine.offsets.value;
  const off = offsets[sel.id] ?? { x: 0, y: 0, z: 0 };
  const refOff = offsets[ref] ?? { x: 0, y: 0, z: 0 };
  const { xMin, xMax, yMin, yMax } = sel.stats;

  // Check every coordinate that will be commanded against the -1 limit
  const violations = checkAbsoluteBounds([
    { axis: 'X', absVal: xMax + off.x },
    { axis: 'Y', absVal: yMax + off.y },
    { axis: 'Z', absVal: ref === 'absolute' ? z : z + refOff.z },
  ]);
  if (violations.length) {
    refusal.value = `Not framed: it would go above −1 in machine coordinates on ${violations.join(', ')}. Check the work offset or the program.`;
    log('err', `Frame BLOCKED — would exceed -1 in absolute machine space: ${violations.join(', ')}. Adjust WCS or program.`);
    return;
  }
  refusal.value = null;

  // G21 G90 first: the frame is absolute mm, whatever a probe or a job left.
  const zCmd = ref === 'absolute'
    ? `G21 G90 G53 G0 Z${z.toFixed(4)}`
    : `G21 G90 G0 Z${(z + refOff.z - off.z).toFixed(4)}`;
  const f = (v: number) => v.toFixed(4);
  log('info', `Framing ${sel.id} — X[${xMin.toFixed(3)} → ${xMax.toFixed(3)}] Y[${yMin.toFixed(3)} → ${yMax.toFixed(3)}] SafeZ:${z} (${ref})`);
  sendCmd(zCmd);
  sendCmd(`G0 X${f(xMin)} Y${f(yMin)}`);
  sendCmd(`G0 X${f(xMax)} Y${f(yMin)}`);
  sendCmd(`G0 X${f(xMax)} Y${f(yMax)}`);
  sendCmd(`G0 X${f(xMin)} Y${f(yMax)}`);
  sendCmd(`G0 X${f(xMin)} Y${f(yMin)}`);
}

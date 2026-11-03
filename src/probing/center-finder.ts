// ═══════════════════════════════════════════════
// Center finder probe logic
// ═══════════════════════════════════════════════

import { state } from '../state';
import { log } from '../console';
import { probeAxis, rapidToMPos, applyXYResult, isProbingRunning, runProbing } from './probe-program';

function startPos() {
  return { x: (state as any).machineX, y: (state as any).machineY, z: (state as any).machineZ };
}

export async function runCenterFinder(cfg: any): Promise<boolean> {
  if (isProbingRunning()) { log('err', 'Probe already running'); return false; }
  return (await runProbing(() => centerFinder(cfg))) ?? false;
}

async function centerFinder(cfg: any): Promise<boolean> {
  const sp = startPos();
  let centerX = sp.x;
  let centerY = sp.y;
  for (let pass = 0; pass < cfg.passes; pass++) {
    if (pass > 0) log('info', `Center finder: pass ${pass + 1}/${cfg.passes}`);
    const result = await probeCenter(cfg, { x: centerX, y: centerY, z: sp.z });
    if (!result) return false;
    centerX = result.x;
    centerY = result.y;
    if (pass < cfg.passes - 1) {
      await rapidToMPos(centerX, centerY, null);
    }
  }
  await rapidToMPos(centerX, centerY, null);
  const opts = { mode: cfg.coordMode, wcs: cfg.wcs };
  applyXYResult(centerX, centerY, cfg.axes === 'X' ? 'X' : cfg.axes === 'Y' ? 'Y' : 'XY', opts);
  log('info', `✓ Center found: X=${centerX.toFixed(4)} Y=${centerY.toFixed(4)}`);
  return true;
}

/** One pass: the two walls of a bore, or the two sides of a boss, in X and then in Y, each from close by.
 *  A bore is probed at depth from inside: the probe goes near each wall (clear of it by the side
 *  clearance, if the bore is that wide) and probes out to it. A boss is probed from outside: the probe
 *  goes out past each side above it, down beside it, probes in, and comes up again. After each axis it
 *  goes to the middle found, so the other axis is measured across the middle. */
async function probeCenter(cfg: any, sp: { x: number; y: number; z: number }): Promise<{ x: number; y: number } | null> {
  const radius = cfg.probeDiameter / 2;
  const clr = cfg.xyClr + radius;
  const inside = cfg.centerMode === 'inside';
  const at = { x: sp.x, y: sp.y };
  const size: { X: number | null; Y: number | null } = { X: null, Y: null };
  const rapidAlong = (k: 'x' | 'y', v: number) => rapidToMPos(k === 'x' ? v : null, k === 'y' ? v : null, null);

  if (inside) await rapidToMPos(null, null, sp.z - cfg.depth);
  for (const axis of ['X', 'Y'] as const) {
    if (cfg.axes !== 'XY' && cfg.axes !== axis) continue;
    const k = axis === 'X' ? 'x' : 'y';
    const half = (axis === 'X' ? cfg.workpieceSizeX : cfg.workpieceSizeY) / 2;
    const found: number[] = [];
    for (const side of [-1, 1]) {
      const name = axis + (side < 0 ? '-' : '+');
      // The probe's direction of travel: out to a bore's wall, in to a boss's side.
      const dir = inside ? side : -side;
      if (inside) {
        await rapidAlong(k, at[k] + side * Math.max(half - clr, 0));
      } else {
        await rapidToMPos(null, null, sp.z);
        await rapidAlong(k, at[k] + side * (half + clr));
        await rapidToMPos(null, null, sp.z - cfg.depth);
      }
      const r = await probeAxis(axis, dir, cfg.probeFeedRate, cfg.latchFeedRate, cfg.probeDistance, cfg.latchDistance);
      if (!r) { await rapidToMPos(null, null, sp.z); log('err', `✗ Center ${name} probe failed`); return null; }
      // The tip's centre stops a radius short of the wall or side.
      found.push(r[k] + dir * radius);
      if (!inside) await rapidToMPos(null, null, sp.z);
    }
    at[k] = (found[0] + found[1]) / 2;
    size[axis] = found[1] - found[0];
    await rapidAlong(k, at[k]);
  }

  await rapidToMPos(null, null, sp.z);
  if (size.X !== null || size.Y !== null) {
    log('info', `Center size:${size.X !== null ? ' X=' + size.X.toFixed(3) : ''}${size.Y !== null ? ' Y=' + size.Y.toFixed(3) : ''} mm`);
  }
  return at;
}

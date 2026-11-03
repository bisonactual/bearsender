// ═══════════════════════════════════════════════
// Center finder probe logic: the centre of a bore (inside) or a boss (outside), and its size
// ═══════════════════════════════════════════════

import { log } from '../console';
import { afterMiss } from './io';
import type { Io, Point } from './io';
import type { ProbeSettings } from './settings';

export interface CentreCfg {
  centerMode: 'inside' | 'outside';
  axes: 'XY' | 'X' | 'Y';
  /** The bore's or the boss's size, about, mm. */
  workpieceSizeX: number;
  workpieceSizeY: number;
  /** How far below the start it probes, mm. */
  depth: number;
  /** Times round: each from the centre the last found. */
  passes: number;
}

/** The centre, in machine coordinates, and the size across it in each axis measured. */
export interface CentreFound { x: number; y: number; sizeX: number | null; sizeY: number | null; }

export async function centre(io: Io, sp: Point, c: CentreCfg, P: ProbeSettings): Promise<CentreFound> {
  return afterMiss(async () => {
    let found: CentreFound = { x: sp.x, y: sp.y, sizeX: null, sizeY: null };
    const times = Math.max(1, Math.round(c.passes) || 1);
    for (let pass = 0; pass < times; pass++) {
      if (pass > 0) { log('info', `Center finder: pass ${pass + 1}/${times}`); await io.move(found.x, found.y, null, `To the centre found, for time ${pass + 1}`); }
      found = await once(io, { ...sp, x: found.x, y: found.y }, c, P);
    }
    await io.move(found.x, found.y, null, `Over the centre: ${c.axes === 'XY' ? 'X0 Y0' : c.axes + '0'}`, 'result');
    log('info', `Center size:${found.sizeX !== null ? ' X=' + found.sizeX.toFixed(3) : ''}${found.sizeY !== null ? ' Y=' + found.sizeY.toFixed(3) : ''} mm`);
    return found;
  }, () => io.move(null, null, sp.z, 'Up'));
}

/** One time round: the two walls of a bore, or the two sides of a boss, in X and then in Y, each from close
 *  by (the owner, 3 Nov). A bore is probed at depth from inside: the probe goes near each wall (clear of it
 *  by the side clearance, if the bore is that wide) and probes out to it. A boss is probed from outside:
 *  the probe goes out past each side above it, down beside it, probes in, and comes up again. After each
 *  axis it goes to the middle found, so the other axis is measured across the middle. */
async function once(io: Io, sp: Point, c: CentreCfg, P: ProbeSettings): Promise<CentreFound> {
  const radius = P.tip / 2;
  const clr = P.clear + radius;
  const bore = c.centerMode === 'inside';
  const at = { x: sp.x, y: sp.y };
  const size: { X: number | null; Y: number | null } = { X: null, Y: null };
  const along = (k: 'x' | 'y', v: number, label: string) => io.move(k === 'x' ? v : null, k === 'y' ? v : null, null, label);

  if (bore) await io.move(null, null, sp.z - c.depth, `Down ${c.depth} mm into the bore`);
  for (const axis of ['X', 'Y'] as const) {
    if (c.axes !== 'XY' && c.axes !== axis) continue;
    const k = axis === 'X' ? 'x' : 'y';
    const half = (axis === 'X' ? c.workpieceSizeX : c.workpieceSizeY) / 2;
    const found: number[] = [];
    for (const side of [-1, 1]) {
      const name = (axis === 'X' ? (side < 0 ? 'left' : 'right') : (side < 0 ? 'front' : 'back')) + (bore ? ' wall' : ' side');
      // The probe's direction of travel: out to a bore's wall, in to a boss's side.
      const dir = bore ? side : -side;
      if (bore) await along(k, at[k] + side * Math.max(half - clr, 0), `Towards the ${name}`);
      else {
        await along(k, at[k] + side * (half + clr), `Out past the ${name}`);
        await io.move(null, null, sp.z - c.depth, `Down ${c.depth} mm`);
      }
      const r = await io.touch(axis, dir, P.search, name);
      found.push(r[k] + dir * radius);
      if (!bore) await io.move(null, null, sp.z, 'Up');
    }
    at[k] = (found[0] + found[1]) / 2;
    size[axis] = found[1] - found[0];
    await along(k, at[k], `To the middle in ${axis}`);
  }
  if (bore) await io.move(null, null, sp.z, 'Up out of the bore');
  return { x: at.x, y: at.y, sizeX: size.X, sizeY: size.Y };
}

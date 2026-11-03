// ═══════════════════════════════════════════════
// Edge finder probe logic: a corner, a side, or the top, outside the part or inside a pocket
// ═══════════════════════════════════════════════
//
// The letters are ioSender's: A front-left, B front-right, C back-right, D back-left; AB front, CD back,
// AD left, CB right; Z the top. Every touch is made with the tip a radius short of the surface, so the
// surface is the contact plus the direction of travel times the radius.

import { log } from '../console';
import { applyXYResult, applyZResult, isProbingRunning, runProbing, machineIo, machineAt, settingsOf } from './probe-program';
import { Miss, Stop, afterMiss } from './io';
import type { Io, Point } from './io';
import type { ProbeSettings } from './settings';

export interface EdgeCfg {
  mode: 'external' | 'internal';
  edge: string;
  /** How far from the corner each side is touched, mm. */
  offset: number;
  /** How far below the start the sides are probed, mm. */
  depth: number;
  /** Also probe Z at a corner. */
  probeZ: boolean;
  /** For Z: a plate under the probe, and how far below the top Z0 goes, mm. */
  touchPlateHeight: number;
  workpieceHeight: number;
}

/** What was found, in machine coordinates: the side's X or Y, the corner's X and Y, the top's Z (touched,
 *  with no plate taken off). `zMissed`: "also probe Z" found nothing. */
export interface EdgeFound { x?: number; y?: number; z?: number; zMissed?: Miss; }

/** Each corner's way along its sides from the corner: onto the part, or into the pocket. */
export const CORNERS: Record<string, { x: number; y: number }> = { A: { x: 1, y: 1 }, B: { x: -1, y: 1 }, C: { x: -1, y: -1 }, D: { x: 1, y: -1 } };
/** Each side: the axis it is found in, which way the part (or the pocket) lies from it, and its name. */
export const SIDES: Record<string, { axis: 'X' | 'Y'; into: number; name: string }> = {
  AD: { axis: 'X', into: 1, name: 'left' }, CB: { axis: 'X', into: -1, name: 'right' },
  AB: { axis: 'Y', into: 1, name: 'front' }, CD: { axis: 'Y', into: -1, name: 'back' },
};

/** The routine, from `sp`, with the probe settings P. Throws Miss or Stop as the Io does, after going
 *  back up to the start height from a miss. */
export async function edge(io: Io, sp: Point, c: EdgeCfg, P: ProbeSettings): Promise<EdgeFound> {
  return afterMiss(
    () => c.edge === 'Z' ? top(io, sp, c, P) : c.edge.length === 2 ? side(io, sp, c, P) : corner(io, sp, c, P),
    () => io.move(null, null, sp.z, 'Up'));
}

async function top(io: Io, sp: Point, c: EdgeCfg, P: ProbeSettings): Promise<EdgeFound> {
  const face = c.touchPlateHeight ? 'plate' : c.mode === 'internal' ? 'pocket floor' : 'top';
  const r = await io.touch('Z', -1, P.search, face);
  await io.move(null, null, sp.z, 'Back up to the start', 'result');
  return { z: r.z };
}

/** It starts over the side (or near the wall), moves out past it at the start height, goes down, then
 *  probes back in (the owner, 3 Nov). */
async function side(io: Io, sp: Point, c: EdgeCfg, P: ProbeSettings): Promise<EdgeFound> {
  const s = SIDES[c.edge];
  const dir = c.mode === 'external' ? s.into : -s.into;
  const clr = P.clear + P.tip / 2;
  const face = `${s.name} ${c.mode === 'external' ? 'side' : 'wall'}`;
  const isX = s.axis === 'X';
  await io.move(isX ? sp.x - dir * clr : null, isX ? null : sp.y - dir * clr, null, `Clear of the ${face}`);
  await io.move(null, null, sp.z - c.depth, `Down ${c.depth} mm`);
  const r = await io.touch(s.axis, dir, P.search, face);
  await io.move(null, null, sp.z, 'Up');
  await io.move(sp.x, sp.y, null, `Back to the start: ${s.axis}0 on the ${face}`, 'result');
  return isX ? { x: r.x + dir * P.tip / 2 } : { y: r.y + dir * P.tip / 2 };
}

async function corner(io: Io, sp: Point, c: EdgeCfg, P: ProbeSettings): Promise<EdgeFound> {
  const into = CORNERS[c.edge];
  const out = c.mode === 'external';
  // s: the probe's direction of travel, onto the part's sides, or out to the pocket's walls.
  const s = out ? into : { x: -into.x, y: -into.y };
  const clr = P.clear + P.tip / 2, rad = P.tip / 2;
  const wd = out ? 'side' : 'wall';
  const xf = `${into.x > 0 ? 'left' : 'right'} ${wd}`, yf = `${into.y > 0 ? 'front' : 'back'} ${wd}`;

  await io.move(null, sp.y + c.offset * into.y, null, `Along to the ${xf}`);
  await io.move(sp.x - s.x * clr, null, null, 'Clear of it');
  await io.move(null, null, sp.z - c.depth, `Down ${c.depth} mm`);
  const rx = await io.touch('X', s.x, P.search, xf);
  await io.move(null, null, sp.z, 'Up');

  await io.move(sp.x + c.offset * into.x, sp.y, null, `Along to the ${yf}`);
  await io.move(null, sp.y - s.y * clr, null, 'Clear of it');
  await io.move(null, null, sp.z - c.depth, `Down ${c.depth} mm`);
  const ry = await io.touch('Y', s.y, P.search, yf);
  await io.move(null, null, sp.z, 'Up');

  const found: EdgeFound = { x: rx.x + s.x * rad, y: ry.y + s.y * rad };
  if (c.probeZ) {
    // Z on the part (or the pocket floor), the corner offset in from both sides.
    const face = out ? 'top' : 'pocket floor';
    await io.move(found.x! + into.x * c.offset, found.y! + into.y * c.offset, null, `Over the ${face}`);
    try { found.z = (await io.touch('Z', -1, P.search, face)).z; }
    catch (e) { if (!(e instanceof Miss)) throw e; found.zMissed = e; }
    await io.move(null, null, sp.z, 'Up');
  }
  await io.move(found.x!, found.y!, null, `Over the corner: X0 Y0${c.probeZ ? ' and Z0' : ''}`, 'result');
  return found;
}

/** The old entry (the dead modules): runs it and writes the result, as before. */
export async function runEdgeFinder(cfg: any): Promise<boolean> {
  if (isProbingRunning()) { log('err', 'Probe already running'); return false; }
  return (await runProbing(async () => {
    try {
      const f = await edge(machineIo(settingsOf(cfg)), machineAt(), cfg, settingsOf(cfg));
      const opts = { mode: cfg.coordMode, wcs: cfg.wcs };
      if (f.x !== undefined || f.y !== undefined) applyXYResult(f.x ?? 0, f.y ?? 0, f.x !== undefined && f.y !== undefined ? 'XY' : f.x !== undefined ? 'X' : 'Y', opts);
      if (f.z !== undefined) applyZResult(f.z, cfg.touchPlateHeight, cfg.workpieceHeight, opts);
      return true;
    } catch (e) {
      if (e instanceof Miss) { log('err', `✗ ${cfg.edge}: ${e.message}`); return false; }
      if (e instanceof Stop) return false;
      throw e;
    }
  })) ?? false;
}

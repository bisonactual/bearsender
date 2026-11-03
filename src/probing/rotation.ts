// ═══════════════════════════════════════════════
// Rotation measurement probe logic
// ═══════════════════════════════════════════════

import { state } from '../state';
import { log } from '../console';
import { processGcode } from '../gcode';
import { lexLine } from '../gcode/lexer';
import * as job from '../stores/job';
import { isProbingRunning, runProbing, machineIo, machineAt, settingsOf } from './probe-program';
import { Miss, Stop, afterMiss } from './io';
import type { Io, Point } from './io';
import type { ProbeSettings } from './settings';

export type Rotation = { angleDeg: number; p1: { x: number; y: number }; p2: { x: number; y: number } };

export interface RotCfg {
  edge: 'AB' | 'AD' | 'CB' | 'CD';
  /** How far along the side the second point is, mm. */
  offset: number;
  /** How far below the start it probes, mm. */
  depth: number;
}

/** Each side as the edge finder names it: the axis it runs along, and the probe's direction of travel onto it. */
export const ROT_SIDES: Record<string, { along: 'X' | 'Y'; dir: number; name: string }> = {
  AB: { along: 'X', dir: 1, name: 'front' },
  CD: { along: 'X', dir: -1, name: 'back' },
  AD: { along: 'Y', dir: 1, name: 'left' },
  CB: { along: 'Y', dir: -1, name: 'right' },
};

/** Two points on the side, the point spacing apart along it (to the right, or further back). At each, as
 *  for a single side: out past the side at the start height, down, then in to it. */
export async function rotation(io: Io, sp: Point, c: RotCfg, P: ProbeSettings): Promise<Rotation> {
  const clr = P.clear + P.tip / 2;
  const side = ROT_SIDES[c.edge];
  const across = side.along === 'X' ? 'Y' : 'X';
  const pts = await afterMiss(async () => {
    const pts: { x: number; y: number }[] = [];
    for (const q of [0, c.offset]) {
      const n = pts.length + 1;
      const at = side.along === 'X' ? { x: sp.x + q, y: sp.y - side.dir * clr } : { x: sp.x - side.dir * clr, y: sp.y + q };
      await io.move(at.x, at.y, null, `To point ${n}, clear of the side`);
      await io.move(null, null, sp.z - c.depth, `Down ${c.depth} mm`);
      const r = await io.touch(across, side.dir, P.search, `${side.name} side at point ${n}`);
      await io.move(null, null, sp.z, 'Up');
      // Both touches are a tip radius short of the side, so the radius drops out of the angle.
      pts.push({ x: r.x, y: r.y });
    }
    return pts;
  }, () => io.move(null, null, sp.z, 'Up'));
  await io.move(sp.x, sp.y, null, 'Back to the start: angle measured', 'result');

  const [p1, p2] = pts;
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  // The part's turn, anticlockwise positive: a side along X runs at atan2(dy, dx), one along Y at atan2(-dx, dy).
  const angleRad = side.along === 'X' ? Math.atan2(dy, dx) : Math.atan2(-dx, dy);
  return { angleDeg: angleRad * 180 / Math.PI, p1, p2 };
}

/** The old entry (the dead modules). */
export async function runRotation(cfg: any): Promise<Rotation | null> {
  if (isProbingRunning()) { log('err', 'Probe already running'); return null; }
  return runProbing(async () => {
    try {
      log('info', `Rotation: probing two points on the ${ROT_SIDES[cfg.edge].name} side (${cfg.edge})…`);
      const r = await rotation(machineIo(settingsOf(cfg)), machineAt(), cfg, settingsOf(cfg));
      log('info', `✓ Rotation measured: ${r.angleDeg.toFixed(3)}°`);
      return r;
    } catch (e) {
      if (e instanceof Miss) { log('err', `✗ Rotation: ${e.message}`); return null; }
      if (e instanceof Stop) return null;
      throw e;
    }
  });
}

// G-words after which a line's X and Y aren't a point of the program in its work coordinates: machine
// coordinates (G53), offset settings (G10, G92), and the stored positions (G28, G30 and their sets).
const LEAVE = [53, 10, 92, 92.1, 28, 28.1, 30, 30.1];

/** The line with its X and Y words (or I and J) replaced by `put.XY` (or `put.IJ`), at the first of
 *  them; comments and everything else as they were. */
function replaceWords(line: string, put: { XY?: string; IJ?: string }): string {
  const group: Record<string, 'XY' | 'IJ'> = { X: 'XY', Y: 'XY', I: 'IJ', J: 'IJ' };
  let out = '', depth = 0;
  const placed = new Set<string>();
  for (let i = 0; i < line.length;) {
    const ch = line[i];
    if (!depth && ch === ';') { out += line.slice(i); break; }
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (!depth) {
      const m = /^([XYIJ])\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)/i.exec(line.slice(i));
      const g = m && group[m[1].toUpperCase()];
      if (m && g && put[g] !== undefined) {
        i += m[0].length;
        if (!placed.has(g)) { out += put[g]; placed.add(g); }
        else if (/\s$/.test(out)) while (i < line.length && /\s/.test(line[i])) i++;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out.trimEnd();
}

/** Turns the loaded program by the angle about X0 Y0. Every move's end is turned as a point (in G91, as a
 *  step) and written with both X and Y, so a line naming one axis gets the other too; an arc's centre
 *  (I, J) is turned with it. Lines in machine coordinates, offset settings and stored positions are left
 *  as they are, and so are comments. */
export function applyRotationToGcode(angleDeg: number): void {
  if (!(state as any).gcodeLines || (state as any).gcodeLines.length === 0) {
    log('err', 'No G-code loaded to rotate');
    return;
  }
  const angleRad = angleDeg * Math.PI / 180;
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  const turn = (a: number, b: number) => [a * cos - b * sin, a * sin + b * cos];
  const f = (v: number) => (Math.abs(v) < 5e-5 ? 0 : v).toFixed(4);
  const rotated: string[] = [];
  let x = 0, y = 0;             // where the program is, unturned
  let inc = false, arcAbs = false;
  let left = 0;
  for (const line of (state as any).gcodeLines as string[]) {
    const b = lexLine(line);
    const g = b.words.filter(([l]) => l === 'G').map(([, v]) => v);
    if (g.includes(90)) inc = false;
    if (g.includes(91)) inc = true;
    if (g.includes(90.1)) arcAbs = true;
    if (g.includes(91.1)) arcAbs = false;
    const w = (l: string) => b.words.find(([k]) => k === l)?.[1];
    const X = w('X'), Y = w('Y'), I = w('I'), J = w('J');
    const hasXY = X !== undefined || Y !== undefined, hasIJ = I !== undefined || J !== undefined;
    const leave = b.errors.length > 0 || g.some(v => LEAVE.includes(v));
    if ((!hasXY && !hasIJ) || leave) {
      if (leave && (hasXY || hasIJ)) left++;
      rotated.push(line);
      continue;
    }
    const put: { XY?: string; IJ?: string } = {};
    if (hasXY) {
      let rx: number, ry: number;
      if (inc) { [rx, ry] = turn(X ?? 0, Y ?? 0); x += X ?? 0; y += Y ?? 0; }
      else { x = X ?? x; y = Y ?? y; [rx, ry] = turn(x, y); }
      put.XY = `X${f(rx)} Y${f(ry)}`;
    }
    if (hasIJ) {
      const [ri, rj] = turn(I ?? 0, J ?? 0);
      put.IJ = `I${f(ri)} J${f(rj)}`;
    }
    rotated.push(replaceWords(line, put));
  }
  // Loaded again, so the 3D view, the limits and the frame show the program as it will now run.
  processGcode(rotated.join('\n'), job.file.value ?? 'rotated.nc');
  log('info', `G-code rotated by ${angleDeg.toFixed(3)}° (${rotated.length} lines)${left ? `; ${left} lines in machine coordinates, offset settings or stored positions left as they were` : ''}`);
  if (arcAbs) log('info', 'The program uses absolute arc centres (G90.1); they were turned as points');
}

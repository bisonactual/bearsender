// ═══════════════════════════════════════════════
// Rotation measurement probe logic
// ═══════════════════════════════════════════════

import { log } from '../console';
import { processGcode } from '../gcode';
import { lexLine } from '../gcode/lexer';
import * as job from '../stores/job';
import { afterMiss } from './io';
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

// What a line's G words do to the program's frame: settings that don't move (G10, G28.1, G30.1), moves to
// positions outside the program's work coordinates (G53, G28, G30), and G92, which shifts the coordinates.
const SETTINGS = [10, 28.1, 30.1];
const AWAY = [53, 28, 30];
const SHIFT = [92, 92.1, 92.2, 92.3];
const MOTION = [0, 1, 2, 3, 38.2, 38.3, 38.4, 38.5, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89];

/** Turns the loaded program by the angle about X0 Y0, and loads it again. Every move's end is turned as a
 *  point (in G91, as a step) and written with both X and Y, so a line naming one axis gets the other too;
 *  an arc's centre (I, J) is turned with it. The units are followed line by line: each line's numbers are
 *  read and written in its own units (G20 or G21), with the position kept in millimetres between them.
 *  Lines in machine coordinates, offset settings and stored positions are left as they are, and so are
 *  comments.
 *
 *  Some lines can't be turned exactly: G92 shifting the coordinates part way through, an arc in the XZ or
 *  YZ plane, a move naming one axis while the other isn't known (after a G53, G28 or G30 move, or before
 *  any move sets it), numbers before any G20 or G21 in a program that changes units, a line that can't be
 *  read. Then nothing is replaced, and what can't be turned is returned, in words; empty when it was. */
export function applyRotationToGcode(angleDeg: number): string[] {
  const lines = job.lines.peek();
  if (!lines || lines.length === 0) return ['No program is loaded.'];
  const angleRad = angleDeg * Math.PI / 180;
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  const turn = (a: number, b: number) => [a * cos - b * sin, a * sin + b * cos];
  const f = (v: number) => (Math.abs(v) < 5e-5 ? 0 : v).toFixed(4);
  const lexed = lines.map(l => lexLine(l));
  const gOf = (b: ReturnType<typeof lexLine>) => b.words.filter(([l]) => l === 'G').map(([, v]) => v);
  const changesUnits = lexed.some(b => gOf(b).includes(20)) && lexed.some(b => gOf(b).includes(21));

  const rotated: string[] = [];
  const cant: string[] = [];
  // Where the program is, unturned, in mm; null while that axis isn't known.
  let x: number | null = null, y: number | null = null;
  let unit = 0;                 // mm per program unit: 1 in G21, 25.4 in G20, 0 until the program says
  let inc = false, arcAbs = false, plane = 17, motion = 0;
  let left = 0;
  lexed.forEach((b, i) => {
    const line = lines[i], n = i + 1;
    const g = gOf(b);
    if (b.errors.length) { cant.push(`Line ${n} can't be read (${b.errors[0]}).`); rotated.push(line); return; }
    if (g.includes(20)) unit = 25.4;
    if (g.includes(21)) unit = 1;
    if (g.includes(90)) inc = false;
    if (g.includes(91)) inc = true;
    if (g.includes(90.1)) arcAbs = true;
    if (g.includes(91.1)) arcAbs = false;
    for (const p of [17, 18, 19]) if (g.includes(p)) plane = p;
    for (const m of MOTION) if (g.includes(m)) motion = m;
    const w = (l: string) => b.words.find(([k]) => k === l)?.[1];
    const X = w('X'), Y = w('Y'), I = w('I'), J = w('J');
    const hasXY = X !== undefined || Y !== undefined, hasIJ = I !== undefined || J !== undefined;
    if (g.some(v => SHIFT.includes(v))) { cant.push(`Line ${n} shifts the coordinates (G92) part way through, so its points aren't where the turn about X0 Y0 expects.`); rotated.push(line); return; }
    if (g.some(v => SETTINGS.includes(v))) { if (hasXY) left++; rotated.push(line); return; }
    if (g.some(v => AWAY.includes(v))) {
      // A move to a machine position, or to a stored one: after it, where the program is in X and Y isn't known.
      if (hasXY || g.includes(28) || g.includes(30)) { x = null; y = null; }
      if (hasXY) left++;
      rotated.push(line);
      return;
    }
    if (!hasXY && !hasIJ) { rotated.push(line); return; }
    const arc = motion === 2 || motion === 3;
    if (arc && plane !== 17) { cant.push(`Line ${n} is an arc in the ${plane === 18 ? 'XZ' : 'YZ'} plane (G${plane}), which isn't an arc once turned about Z.`); rotated.push(line); x = y = null; return; }
    if (!unit && changesUnits) { cant.push(`Line ${n} has X or Y before the program says G20 or G21, and the program changes units later, so its units aren't known.`); rotated.push(line); x = y = null; return; }
    const k = unit || 1;
    const put: { XY?: string; IJ?: string } = {};
    // The arc's start, for absolute centres (G90.1), before the end moves it.
    const sx = x, sy = y;
    if (hasXY) {
      let rx: number, ry: number;
      if (inc) {
        [rx, ry] = turn((X ?? 0) * k, (Y ?? 0) * k);
        if (x !== null) x += (X ?? 0) * k;
        if (y !== null) y += (Y ?? 0) * k;
      } else {
        const nx = X !== undefined ? X * k : x, ny = Y !== undefined ? Y * k : y;
        if (nx === null || ny === null) {
          cant.push(`Line ${n} names only ${X !== undefined ? 'X' : 'Y'}, and ${X !== undefined ? 'Y' : 'X'} isn't known before it, so its turned end isn't known.`);
          rotated.push(line);
          x = nx; y = ny;
          return;
        }
        x = nx; y = ny;
        [rx, ry] = turn(nx, ny);
      }
      put.XY = `X${f(rx / k)} Y${f(ry / k)}`;
    }
    if (hasIJ) {
      if (arcAbs && (sx === null || sy === null) && (I === undefined || J === undefined)) {
        cant.push(`Line ${n} gives an absolute arc centre (G90.1) on one axis while the other isn't known.`);
        rotated.push(line);
        return;
      }
      const ci = I !== undefined ? I * k : arcAbs ? sx! : 0, cj = J !== undefined ? J * k : arcAbs ? sy! : 0;
      const [ri, rj] = turn(ci, cj);
      put.IJ = `I${f(ri / k)} J${f(rj / k)}`;
    }
    rotated.push(replaceWords(line, put));
  });
  if (cant.length) {
    for (const c of cant) log('err', `Rotation not applied: ${c}`);
    return cant;
  }
  // Loaded again, so the 3D view, the limits and the frame show the program as it will now run.
  processGcode(rotated.join('\n'), job.file.value ?? 'rotated.nc');
  log('info', `G-code rotated by ${angleDeg.toFixed(3)}° (${rotated.length} lines)${left ? `; ${left} lines in machine coordinates, offset settings or stored positions left as they were` : ''}`);
  return [];
}

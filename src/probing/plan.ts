// What a routine will do, for the Probing screen's drawing: the routine itself, run against a virtual
// part (a dry run of its Io), so the moves drawn are the moves the machine makes. Also where the probe
// must start, how far it reaches, and what the drawing shows of the part.
//
// The drawing's frame is millimetres from the feature: the corner, side or middle at X0 Y0, the top at
// Z0, and the start 1-3 mm from it, 2 mm above the top. Tool length's frame: the plate's top, or the
// toolsetter's (G59.3) top, at 0.

import { Miss, Stop } from './io';
import type { Io, Point, Step, StepType } from './io';
import type { ProbeSettings } from './settings';
import { probeProblems } from './settings';
import { edge, CORNERS, SIDES } from './edge-finder';
import type { EdgeConfig } from './edge-finder';
import { centre } from './center-finder';
import type { CentreConfig } from './center-finder';
import { rotation, ROTATION_SIDES } from './rotation';
import type { RotationConfig } from './rotation';
import { touchPlate, toolsetter } from './probe-program';

export type Routine = 'tl' | 'ef' | 'cf' | 'rot';

export type Stock =
  | { k: 'corner' | 'pcorner'; s: { x: number; y: number } }
  | { k: 'side' | 'pside'; a: 'x' | 'y'; d: number }
  | { k: 'top' | 'pfloor'; plate: number }
  | { k: 'bore' | 'boss'; R: { x: number; y: number } }
  | { k: 'rot'; th: number; along: 'x' | 'y'; d: number }
  | { k: 'plate'; top: number }
  | { k: 'setter'; z0: number; known: boolean }
  | { k: 'none' };

/** The new zero the drawing marks: X0 Y0, X0, Y0, the centre, Z0 at a height, the angle; none for tool length. */
export type NewZero = { k: 'xy' | 'x' | 'y' | 'c' | 'angle' } | { k: 'z'; z: number } | null;

export interface Plan {
  r: Routine;
  wps: Step[];
  views: ('xy' | 'xz')[];
  stock: Stock;
  res: NewZero;
  /** Where to jog the probe, and how far it reaches. */
  where: string;
  sub: string;
  warn: string;
  /** A tool is drawn rather than the probe. */
  tool: boolean;
  /** Rotation: the point spacing and the side's turn drawn. */
  spacing: number;
  /** The dry run found nothing to touch: the settings can't reach the part as drawn. */
  miss: string;
}

export interface ToolLengthPlanConfig { mode: 'touchplate' | 'toolsetter'; probeDistance: number; touchPlateHeight: number; toolsetterDepth: number; }

export interface PlanInputs {
  P: ProbeSettings;
  tl: ToolLengthPlanConfig;
  ef: Omit<EdgeConfig, 'edge'>;
  efEdge: string | null;
  cf: CentreConfig;
  rot: RotationConfig;
  /** The toolsetter (G59.3) and where the machine is, machine coordinates; null when not known. */
  ts: Point | null;
  at: Point | null;
}

// The virtual part: signed distance functions, negative inside

type SDF = (p: Point) => number;
const BIG = 1e4;
const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): SDF => p => {
  const qx = Math.abs(p.x - (x0 + x1) / 2) - (x1 - x0) / 2;
  const qy = Math.abs(p.y - (y0 + y1) / 2) - (y1 - y0) / 2;
  const qz = Math.abs(p.z - (z0 + z1) / 2) - (z1 - z0) / 2;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0);
};
const union = (...a: SDF[]): SDF => p => Math.min(...a.map(f => f(p)));
const minus = (a: SDF, b: SDF): SDF => p => Math.max(a(p), -b(p));
const turned = (f: SDF, rad: number): SDF => p => f({ x: p.x * Math.cos(-rad) - p.y * Math.sin(-rad), y: p.x * Math.sin(-rad) + p.y * Math.cos(-rad), z: p.z });
/** The half (or quadrant) where x·sx ≥ 0 and y·sy ≥ 0; 0 leaves that axis whole. */
const span = (s: number): [number, number] => s > 0 ? [0, BIG] : s < 0 ? [-BIG, 0] : [-BIG, BIG];
const quad = (sx: number, sy: number, z0: number, z1: number) => box(...span(sx), ...span(sy), z0, z1);
const PLATE = box(-BIG, BIG, -BIG, BIG, -60, 0);

const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });

/** Where along a→b a ball of radius r centred on the path first touches the part (0..1), or null. */
function firstTouch(part: SDF, r: number, a: Point, b: Point): number | null {
  const L = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  const gap = (t: number) => part(lerp(a, b, t)) - r;
  if (L < 1e-9 || gap(0) <= 0) return null;
  let s = 0;
  for (let i = 0; i < 10000; i++) {
    const d = gap(s / L);
    if (d <= 1e-6) return s / L;
    s += Math.max(d, 1e-4);
    if (s > L) return gap(1) <= 1e-6 ? 1 : null;
  }
  return null;
}

/** The dry run's Io: moves in machine coordinates, drawn less `origin`, touching `part`. */
function dryIo(part: SDF, r: number, P: ProbeSettings, start: Point, origin: Point): { io: Io; steps: Step[] } {
  const steps: Step[] = [];
  let pos = { x: start.x - origin.x, y: start.y - origin.y, z: start.z - origin.z };
  const push = (p: Point, type: StepType, label: string) => steps.push({ ...p, type, label });
  push(pos, 'start', 'Start');
  const io: Io = {
    async move(x, y, z, label, type = 'rapid') {
      pos = { x: x === null ? pos.x : x - origin.x, y: y === null ? pos.y : y - origin.y, z: z === null ? pos.z : z - origin.z };
      push(pos, type, label);
    },
    async touch(axis, dir, distance, face) {
      const k = axis.toLowerCase() as 'x' | 'y' | 'z';
      const to = { ...pos, [k]: pos[k] + dir * distance };
      const t = firstTouch(part, r, pos, to);
      if (t === null) { push(to, 'probe', `No touch within ${distance} mm`); pos = to; throw new Miss(face, distance, false); }
      const c = lerp(pos, to, t), b = { ...c, [k]: c[k] - dir * P.back };
      push(c, 'probe', `Find the ${face} (fast)`); push(c, 'contact', `Touched the ${face}`);
      push(b, 'back', `Back off ${P.back} mm`); push(c, 'slow', `Touch the ${face} again (slow)`);
      push(c, 'contact', `Touched the ${face}`); push(b, 'back', `Back off ${P.back} mm`);
      pos = b;
      return { x: c.x + origin.x, y: c.y + origin.y, z: c.z + origin.z };
    },
  };
  return { io, steps };
}

const ORIGIN = { x: 0, y: 0, z: 0 };
const START_HEIGHT = 2;    // the start, this far above the top

/** The routine's plan for the drawing. */
export async function makePlan(r: Routine, inputs: PlanInputs): Promise<Plan> {
  const P = inputs.P, rad = P.tip / 2, clr = P.clear + rad, reach = Math.max(+(P.search - clr).toFixed(3), 0);
  const plan: Plan = { r, wps: [], views: ['xy', 'xz'], stock: { k: 'none' }, res: null, where: '', sub: '', warn: '', tool: false, spacing: 0, miss: '' };
  // Settings that can't be used aren't drawn: they are never sent.
  const problems = probeProblems(P, r === 'tl');
  if (problems.length) {
    plan.where = "The probe settings can't be used, so nothing is drawn and nothing is sent.";
    plan.warn = `${problems.join('; ')}. Fix them in PROBE SETTINGS.`;
    return plan;
  }
  let part: SDF = () => BIG, start: Point = { x: 0, y: 0, z: START_HEIGHT }, origin = ORIGIN, ballR = rad;
  let run: ((io: Io) => Promise<unknown>) | null = null;

  if (r === 'ef') {
    const c = inputs.ef, pick = inputs.efEdge, ins = c.mode === 'internal';
    if (!pick) {
      plan.where = 'Pick a corner, a side or the top on the picture.';
      plan.sub = 'The drawing then shows where to start the probe and every move it makes.';
      return plan;
    }
    const cfg: EdgeConfig = { ...c, edge: pick };
    if (pick === 'Z') {
      const top = (ins ? -8 : 0) + c.touchPlateHeight;
      part = union(ins ? box(-BIG, BIG, -BIG, BIG, -60, -8) : PLATE, ...(c.touchPlateHeight ? [box(-14, 14, -14, 14, top - c.touchPlateHeight, top)] : []));
      start = { x: 0, y: 0, z: top + 6 };
      plan.stock = { k: ins ? 'pfloor' : 'top', plate: c.touchPlateHeight };
      plan.res = { k: 'z', z: (ins ? -8 : 0) - c.workpieceHeight };
      plan.views = ['xz'];
      const on = ins ? 'pocket floor' : 'top';
      plan.where = c.touchPlateHeight ? `Put the ${c.touchPlateHeight.toFixed(3)} mm plate on the ${on} and jog the probe over it, less than ${P.search} mm above it.`
        : `Jog the probe over the ${on}, less than ${P.search} mm above it.`;
      plan.sub = 'It probes straight down, then goes back up to where it started.';
    } else if (pick.length === 2) {
      const s = SIDES[pick], a = s.axis === 'X' ? 'x' : 'y', face = `${s.name} ${ins ? 'wall' : 'side'}`;
      const half = a === 'x' ? quad(s.into, 0, ins ? -8 : -60, ins ? 1 : 0) : quad(0, s.into, ins ? -8 : -60, ins ? 1 : 0);
      part = ins ? minus(PLATE, half) : half;
      start = { x: a === 'x' ? s.into * (ins ? 3 : 1) : 0, y: a === 'y' ? s.into * (ins ? 3 : 1) : 0, z: START_HEIGHT };
      plan.stock = { k: ins ? 'pside' : 'side', a, d: s.into };
      plan.res = { k: a };
      plan.where = ins ? `Jog the probe into the pocket, about 3 mm from its ${face}, tip 1 to 2 mm above the top.`
        : `Jog the probe over the ${face}, tip 1 to 2 mm above the top.`;
      plan.sub = `It reaches the ${ins ? 'wall' : 'side'} up to ${reach} mm from the tip, ${c.depth} mm below where it starts.`;
    } else {
      const s = CORNERS[pick], nm = CORNER_NAMES[pick];
      part = ins ? minus(PLATE, quad(s.x, s.y, -8, 1)) : quad(s.x, s.y, -60, 0);
      start = ins ? { x: s.x * 3, y: s.y * 3, z: START_HEIGHT } : { x: -s.x * 2, y: -s.y * 2, z: START_HEIGHT };
      plan.stock = { k: ins ? 'pcorner' : 'corner', s };
      plan.res = { k: 'xy' };
      plan.where = ins ? `Jog the probe into the pocket near its ${nm}, about 3 mm from both walls, tip 1 to 2 mm above the top.`
        : `Jog the probe over the ${nm}, tip 1 to 2 mm above the top.`;
      plan.sub = `It reaches a ${ins ? 'wall' : 'side'} up to ${reach} mm from the tip in X and Y, and probes ${c.depth} mm below where it starts.`;
    }
    if (pick !== 'Z' && reach <= 0) plan.warn = `The search distance (${P.search} mm) isn't more than the clearance (${+clr.toFixed(3)} mm): it can't reach the ${ins ? 'walls' : 'sides'}.`;
    run = io => edge(io, start, cfg, P);
  } else if (r === 'cf') {
    const c = inputs.cf, bore = c.centerMode === 'inside', R = { x: c.workpieceSizeX / 2, y: c.workpieceSizeY / 2 };
    part = bore ? minus(PLATE, box(-R.x, R.x, -R.y, R.y, -14, 1)) : union(box(-R.x, R.x, -R.y, R.y, -10, 0), box(-BIG, BIG, -BIG, BIG, -60, -10));
    plan.stock = { k: bore ? 'bore' : 'boss', R };
    plan.res = { k: 'c' };
    plan.where = `Jog the probe over the middle of the ${bore ? 'bore' : 'boss'}, tip 1 to 2 mm above the ${bore ? 'top' : 'top of the boss'}.`;
    plan.sub = bore ? `It rapids to ${+P.clear.toFixed(3)} mm from each wall of a ${c.workpieceSizeX} × ${c.workpieceSizeY} mm bore, so give a size a little under the real one.`
      : `It goes out to ${+(Math.max(R.x, R.y) + clr).toFixed(3)} mm from the middle before going down, so give a size a little over the real one.`;
    if (P.search <= P.clear) plan.warn = `The search distance (${P.search} mm) isn't more than the clearance (${P.clear} mm): it can't reach the ${bore ? 'walls' : 'sides'}.`;
    run = io => centre(io, start, c, P);
  } else if (r === 'rot') {
    const c = inputs.rot, s = ROTATION_SIDES[c.edge], along = s.along === 'X' ? 'x' : 'y', th = 1.5 * Math.PI / 180;
    part = turned(along === 'x' ? quad(0, s.dir, -60, 0) : quad(s.dir, 0, -60, 0), th);
    start = along === 'x' ? { x: 0, y: s.dir, z: START_HEIGHT } : { x: s.dir, y: 0, z: START_HEIGHT };
    plan.stock = { k: 'rot', th, along, d: s.dir };
    plan.res = { k: 'angle' };
    plan.spacing = c.offset;
    plan.where = `Jog the probe over the ${s.name} side near its ${along === 'x' ? 'left' : 'front'} end, tip 1 to 2 mm above the top.`;
    plan.sub = `The second point is ${c.offset} mm ${along === 'x' ? 'to the right' : 'further back'}: keep the side clear for ${+(c.offset + clr).toFixed(3)} mm.`;
    run = io => rotation(io, start, c, P);
  } else {
    const c = inputs.tl;
    plan.tool = true;
    plan.views = ['xz'];
    ballR = 0;
    if (c.mode === 'touchplate') {
      const top = c.touchPlateHeight;
      part = union(box(-BIG, BIG, -BIG, BIG, -40, 0), box(-18, 18, -18, 18, 0, top));
      start = { x: 0, y: 0, z: top + 22 };
      plan.stock = { k: 'plate', top };
      plan.where = `Put the ${top.toFixed(3)} mm plate under the tool, clip the lead to the tool, and jog the tip over the plate, less than ${c.probeDistance} mm above it.`;
      plan.sub = 'It probes straight down, then goes back up to where it started.';
      run = io => touchPlate(io, start, c);
    } else {
      // Machine coordinates, drawn from the toolsetter's top. Without G59.3 or a position, an example.
      const ts = inputs.ts ?? { x: 0, y: 0, z: -150 };
      start = inputs.ts && inputs.at ? inputs.at : { x: ts.x - 120, y: ts.y, z: ts.z + 40 };
      origin = ts;
      part = union(box(-8, 8, -8, 8, -60, 0), box(start.x - ts.x - 40, start.x - ts.x + 40, -40, 40, -BIG, -60));
      plan.stock = { k: 'setter', z0: -ts.z, known: !!inputs.ts };
      plan.where = `Start anywhere: the tool goes up to the top of its Z travel, over to the toolsetter, down to ${c.toolsetterDepth} mm above it, then probes.`;
      plan.sub = inputs.ts ? `Toolsetter (G59.3): X ${signedMm(inputs.ts.x)} Y ${signedMm(inputs.ts.y)} Z ${signedMm(inputs.ts.z)}, machine. Set it in Setup, Offsets.`
        : 'G59.3 is not read yet, so the toolsetter is drawn at an example place. Set it in Setup, Offsets.';
      run = io => toolsetter(io, start, ts, c);
    }
  }

  const dry = dryIo(part, ballR, P, start, origin);
  try { await run!(dry.io); }
  catch (e) {
    if (e instanceof Miss) plan.miss = e.message;
    else if (!(e instanceof Stop)) throw e;
  }
  plan.wps = dry.steps;
  return plan;
}

export const CORNER_NAMES: Record<string, string> = { A: 'front-left corner', B: 'front-right corner', C: 'back-right corner', D: 'back-left corner' };
const signedMm = (v: number) => (v < 0 ? '−' : '') + Math.abs(v).toFixed(3);

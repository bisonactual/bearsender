// ═══════════════════════════════════════════════
// The probing routines as the Probing screen runs them: what each measures, which one is running and
// how far it is, what each last said and found, and writing what was found
// ═══════════════════════════════════════════════

import { signal } from '@preact/signals';
import type { Signal } from '@preact/signals';
import { lsGet, lsSet } from '../ui';
import { sendCmd } from '../connection';
import { lastError } from '../console';
import * as machine from '../stores/machine';
import * as job from '../stores/job';
import { cancelProbing, probingRefusal, getActiveWcs, runProbing, machineIo, machineAt, touchPlate, toolsetter, applyXYResult, applyZResult } from './probe-program';
import { edge, SIDES } from './edge-finder';
import type { EdgeCfg } from './edge-finder';
import { centre } from './center-finder';
import type { CentreCfg } from './center-finder';
import { rotation, applyRotationToGcode, ROT_SIDES } from './rotation';
import type { RotCfg } from './rotation';
import { Miss, Stop } from './io';
import type { Io, Point } from './io';
import { probe } from './settings';
import { CORNER_NAMES } from './plan';
import type { Plan, Routine } from './plan';

export type { Routine } from './plan';

// The old tab's keys, so the settings carry over. (The probe settings that were in them are the one
// set now: settings.ts.)
const SAVE_KEY = 'fs-probing-tab';

function saved<T extends object>(sub: Routine, defaults: T): Signal<T> {
  return signal<T>({ ...defaults, ...lsGet(`${SAVE_KEY}-${sub}`, {}) });
}

/** Changes some of a routine's settings and keeps them. What it said last was about the settings before. */
export function update<T extends object>(sub: Routine, sig: Signal<T>, patch: Partial<T>): void {
  sig.value = { ...sig.value, ...patch };
  lsSet(`${SAVE_KEY}-${sub}`, sig.value);
  settled(sub);
}

export interface TlCfg {
  mode: 'touchplate' | 'toolsetter';
  /** How far down it searches for the plate, mm (tool length's own). */
  probeDistance: number;
  /** The touch plate's thickness, mm. */
  touchPlateHeight: number;
  /** How far above the toolsetter it stops before probing, mm. */
  toolsetterDepth: number;
  /** The reference tool: the machine Z it touched at, its number and when. */
  tloReference: number | null;
  refTool?: number | null;
  refAt?: number | null;
}
export const tl = saved<TlCfg>('tl', { mode: 'touchplate', probeDistance: 50, touchPlateHeight: 0, toolsetterDepth: 10, tloReference: null, refTool: null, refAt: null });

export type EfCfg = Omit<EdgeCfg, 'edge'>;
export const ef = saved<EfCfg>('ef', { mode: 'external', depth: 3, offset: 5, probeZ: false, touchPlateHeight: 0, workpieceHeight: 0 });
export const cf = saved<CentreCfg>('cf', { centerMode: 'inside', axes: 'XY', depth: 3, workpieceSizeX: 50, workpieceSizeY: 50, passes: 1 });
export const rot = saved<RotCfg>('rot', { edge: 'AB', depth: 3, offset: 50 });
export type RotEdge = RotCfg['edge'];

/** Where a result goes: a work offset ('' is the active one) and how (G10, or measure only). Picked each time, as before. */
export interface Target { wcs: string; mode: 'G10' | 'measure'; }
export const efTarget = signal<Target>({ wcs: '', mode: 'G10' });
export const cfTarget = signal<Target>({ wcs: '', mode: 'G10' });

/** The corner, side or top picked for the edge finder: none until one is picked. */
export const efEdge = signal<string | null>(null);
export function pickEdge(id: string): void { efEdge.value = id; settled('ef'); }

// ── A run, as the screen shows it ─────────────────────────────────────────────

export type Phase = 'running' | 'ok' | 'fail' | 'cancelled';
export interface ResultLine { k: string; v: string; old?: string; }
export interface Run {
  phase: Phase;
  /** The plan when PROBE was pressed: the drawing follows the run on it. */
  plan: Plan | null;
  /** The step under way, as the plan numbers them, and its name. */
  step: number;
  label: string;
  /** Where it started, machine coordinates. */
  start: Point | null;
  /** The status line, and what was found. */
  text: string;
  lines: ResultLine[];
}

/** Each routine's last run; none once its settings change. */
export const runs = signal<Partial<Record<Routine, Run>>>({});
/** The routine running now, if any: one at a time. */
export const running = signal<Routine | null>(null);
/** The angle measured last, until it is applied: applying it twice would turn the program twice. */
export const rotAngle = signal<number | null>(null);

function setRun(r: Routine, patch: Partial<Run>): void {
  const was = runs.value[r] ?? { phase: 'fail', plan: null, step: 0, label: '', start: null, text: '', lines: [] };
  runs.value = { ...runs.value, [r]: { ...was, ...patch } };
}

/** The settings changed: what the routine said last no longer applies (unless it is still running). */
function settled(r: Routine): void {
  if (running.value === r || !runs.value[r]) return;
  const { [r]: _, ...rest } = runs.value;
  runs.value = rest;
  if (r === 'rot') rotAngle.value = null;
}

/** What is measured, in words: "front-left corner", "bore centre". */
export function measuring(r: Routine): string {
  if (r === 'tl') return 'tool length';
  if (r === 'cf') return (cf.value.centerMode === 'inside' ? 'bore' : 'boss') + ' centre';
  if (r === 'rot') return ROT_SIDES[rot.value.edge].name + ' side angle';
  const p = efEdge.value, ins = ef.value.mode === 'internal';
  if (!p) return 'nothing picked';
  if (p === 'Z') return ins ? 'pocket floor' : 'top surface';
  return p.length === 1 ? CORNER_NAMES[p] : `${SIDES[p].name} ${ins ? 'wall' : 'side'}`;
}

/** The status line with no run on show. */
export function readyText(r: Routine): string {
  if (r === 'ef' && !efEdge.value) return 'Pick a corner, a side or the top on the picture, then PROBE.';
  if (r === 'tl' && tl.value.tloReference === null) return 'Ready. No reference tool yet: this tool will be measured on its own.';
  return `Ready: ${measuring(r)}.`;
}

const f3 = (v: number) => (v < 0 ? '−' : '') + Math.abs(v).toFixed(3);
const axesText = (p: { x?: number; y?: number; z?: number }) =>
  (['x', 'y', 'z'] as const).filter(a => p[a] !== undefined).map(a => `${a.toUpperCase()} ${f3(p[a]!)}`).join(' ');

let _cancelRequested = false;

/** Runs a routine on the machine from where it is, following its steps; what it found, or null after
 *  saying why not. */
async function exec<T>(r: Routine, plan: Plan | null, body: (io: Io, sp: Point) => Promise<T>): Promise<T | null> {
  const why = probingRefusal();
  if (why) { setRun(r, { phase: 'fail', plan: null, step: 0, label: '', start: null, text: why, lines: [] }); return null; }
  _cancelRequested = false;
  const sp = machineAt(), since = Date.now();
  running.value = r;
  setRun(r, { phase: 'running', plan, step: 0, label: 'Start', start: sp, text: '', lines: [] });
  if (r === 'rot') rotAngle.value = null;
  const io = machineIo(probe.value, (_, label) => {
    const cur = runs.value[r];
    if (cur) setRun(r, { step: cur.step + 1, label });
  });
  try {
    const v = await runProbing(() => body(io, sp));
    if (v === null) {
      const e = lastError.value;
      setRun(r, _cancelRequested ? { phase: 'cancelled', text: 'Cancelled before anything moved.' }
        : { phase: 'fail', text: e && e.at >= since ? e.text.replace(/^✗\s*/, '') : 'Probing didn\'t start.' });
    }
    return v;
  } catch (e) {
    if (e instanceof Miss) setRun(r, { phase: 'fail', text: missText(r, e) });
    else if (e instanceof Stop && (e.why === 'cancelled' || _cancelRequested)) setRun(r, { phase: 'cancelled', text: cancelText(sp) });
    else if (e instanceof Stop) setRun(r, { phase: 'fail', text: `Stopped: ${e.why}.` });
    else { setRun(r, { phase: 'fail', text: String(e) }); throw e; }
    return null;
  } finally {
    running.value = null;
  }
}

function missText(r: Routine, e: Miss): string {
  if (e.slow) return `Touched the ${e.face}, then nothing on the slow touch within ${e.distance} mm. Check the probe and its lead.`;
  if (r === 'tl' && e.face === 'plate') return `No contact on the plate within ${e.distance} mm. Start closer to it, or raise "Search down up to".`;
  if (r === 'tl') return `No contact on the toolsetter within ${e.distance} mm. Check G59.3's Z, or raise "Stop this far above the toolsetter".`;
  return `No contact on the ${e.face} within ${e.distance} mm. Start closer to it, or raise the search distance in Probe settings.`;
}

function cancelText(sp: Point): string {
  const down = sp.z - machineAt().z;
  return down > 0.05 ? `Cancelled. The probe stopped ${down.toFixed(1)} mm below where it started: raise Z before jogging sideways.`
    : 'Cancelled. The probe stopped where it was.';
}

export function cancel(): void {
  const r = running.value;
  if (!r) return;
  _cancelRequested = true;
  cancelProbing();
  setRun(r, { text: 'Cancelling…' });
}

/** What the old value of a work offset was, for "was". */
const wasOf = (wcs: string, axes: ('x' | 'y' | 'z')[]) => {
  const o = machine.offsets.value[wcs];
  return o ? 'was ' + axes.map(a => `${a.toUpperCase()} ${f3(o[a])}`).join(' ') : undefined;
};

// ── Edge finder, centre finder, rotation ──────────────────────────────────────

export async function findEdge(plan: Plan | null): Promise<void> {
  const pick = efEdge.value;
  if (!pick) { setRun('ef', { phase: 'fail', plan: null, start: null, lines: [], text: 'Pick a corner, a side or the top on the picture first.' }); return; }
  const c: EdgeCfg = { ...ef.value, edge: pick };
  const t = efTarget.value, wcs = t.wcs || getActiveWcs();
  const f = await exec('ef', plan, (io, sp) => edge(io, sp, c, probe.value));
  if (!f) return;
  const set = { x: f.x, y: f.y, z: f.z !== undefined ? f.z - c.touchPlateHeight - c.workpieceHeight : undefined };
  const axes = (['x', 'y', 'z'] as const).filter(a => set[a] !== undefined);
  const lines: ResultLine[] = [{ k: 'FOUND', v: axesText({ x: f.x, y: f.y, z: f.z }), old: 'machine' }];
  if (t.mode === 'G10') {
    lines.push({ k: wcs, v: axesText(set), old: wasOf(wcs, axes) });
    const opts = { mode: 'G10', wcs };
    if (f.x !== undefined || f.y !== undefined) applyXYResult(f.x ?? 0, f.y ?? 0, f.x !== undefined && f.y !== undefined ? 'XY' : f.x !== undefined ? 'X' : 'Y', opts);
    if (f.z !== undefined) applyZResult(f.z, c.touchPlateHeight, c.workpieceHeight, opts);
  } else lines.push({ k: 'NOT SET', v: '', old: 'measure only' });
  if (f.zMissed) lines.push({ k: 'Z', v: '', old: `${f.zMissed.message}: X and Y ${t.mode === 'G10' ? 'written' : 'measured'} only` });
  setRun('ef', { phase: 'ok', text: t.mode === 'G10' ? `Done. Written to ${wcs}.` : 'Measured. Nothing was written.', lines });
}

export async function findCentre(plan: Plan | null): Promise<void> {
  const c = cf.value, t = cfTarget.value, wcs = t.wcs || getActiveWcs();
  const f = await exec('cf', plan, (io, sp) => centre(io, sp, c, probe.value));
  if (!f) return;
  const set = { x: c.axes !== 'Y' ? f.x : undefined, y: c.axes !== 'X' ? f.y : undefined };
  const axes = (['x', 'y'] as const).filter(a => set[a] !== undefined);
  const size = [f.sizeX, f.sizeY].filter((v): v is number => v !== null).map(v => v.toFixed(3)).join(' × ');
  const lines: ResultLine[] = [
    { k: 'CENTRE', v: axesText(set), old: 'machine' },
    { k: 'SIZE', v: `${c.centerMode === 'inside' ? 'bore' : 'boss'} ${size} mm${c.axes === 'XY' ? '' : ' in ' + c.axes}` },
  ];
  if (t.mode === 'G10') {
    lines.push({ k: wcs, v: axesText(set), old: wasOf(wcs, axes) });
    applyXYResult(f.x, f.y, c.axes, { mode: 'G10', wcs });
  } else lines.push({ k: 'NOT SET', v: '', old: 'measure only' });
  setRun('cf', { phase: 'ok', text: t.mode === 'G10' ? `Done. Written to ${wcs}.` : 'Measured. Nothing was written.', lines });
}

export async function measureRotation(plan: Plan | null): Promise<void> {
  const c = rot.value;
  const f = await exec('rot', plan, (io, sp) => rotation(io, sp, c, probe.value));
  if (!f) return;
  rotAngle.value = f.angleDeg;
  const loaded = job.lines.value.length > 0;
  setRun('rot', {
    phase: 'ok',
    text: loaded ? 'Measured. APPLY ROTATION turns the program by this angle.' : 'Measured. Load a program, then APPLY ROTATION turns it by this angle.',
    lines: [{ k: 'ANGLE', v: `${f.angleDeg.toFixed(3)}°` }, { k: 'POINTS', v: '', old: `${Math.hypot(f.p2.x - f.p1.x, f.p2.y - f.p1.y).toFixed(3)} mm apart on the ${ROT_SIDES[c.edge].name} side` }],
  });
}

export function applyRotation(): void {
  const a = rotAngle.value;
  if (a === null) return;
  applyRotationToGcode(a);
  rotAngle.value = null;
  setRun('rot', { text: `Done. ${job.file.value ?? 'The program'} turned by ${a.toFixed(3)}° about X0 Y0.` });
}

// ── Tool length ───────────────────────────────────────────────────────────────

export async function measureTool(asReference: boolean, plan: Plan | null = null): Promise<void> {
  const c = tl.value;
  const ts = machine.offsets.value['G59.3'];
  if (c.mode === 'toolsetter' && !ts && !probingRefusal()) {
    setRun('tl', { phase: 'fail', plan: null, start: null, lines: [], text: 'G59.3 isn\'t read yet: read the offsets, or set the toolsetter there (Setup, Offsets).' });
    return;
  }
  const f = await exec('tl', plan, (io, sp) => c.mode === 'toolsetter' ? toolsetter(io, sp, ts!, c) : touchPlate(io, sp, c));
  if (!f) return;
  const tool = machine.tool.value;
  const T = (n: number | null | undefined) => n === null || n === undefined ? 'this tool' : 'T' + n;
  if (asReference) {
    update('tl', tl, { tloReference: f.z, refTool: tool, refAt: Date.now() });
    sendCmd('G49');
    setRun('tl', {
      phase: 'ok', text: `Reference set: ${T(tool)} touched at machine Z ${f3(f.z)}. Measure each later tool with PROBE.`,
      lines: [{ k: 'TOUCHED', v: `Z ${f3(f.z)}`, old: 'machine' }, { k: 'TLO', v: '', old: 'cancelled (G49): the reference has none' }],
    });
    return;
  }
  // Against a reference, the plate (or the toolsetter) is under both tools, so it drops out. Without one,
  // the touch plate's thickness comes off once; a toolsetter has none.
  const tlo = c.tloReference !== null ? f.z - c.tloReference
    : c.mode === 'touchplate' ? f.z - c.touchPlateHeight : f.z;
  sendCmd(`G21G43.1Z${tlo.toFixed(4)}`);
  const known = (n: number | null | undefined) => n !== null && n !== undefined;
  const against = c.tloReference !== null ? `· ${known(tool) ? T(tool) + ' ' : ''}against ${known(c.refTool) ? T(c.refTool) : 'the reference'} (Z ${f3(c.tloReference)})`
    : c.mode === 'touchplate' ? `· no reference: the touch less the ${c.touchPlateHeight.toFixed(3)} mm plate` : '· no reference: the touch itself';
  setRun('tl', {
    phase: 'ok', text: 'Done. Tool length offset set (G43.1).',
    lines: [{ k: 'TOUCHED', v: `Z ${f3(f.z)}`, old: 'machine' }, { k: 'TLO', v: `${f3(tlo)} mm`, old: against }],
  });
}

export function clearReference(): void {
  update('tl', tl, { tloReference: null, refTool: null, refAt: null });
  sendCmd('G49');
  setRun('tl', { phase: 'ok', plan: null, start: null, lines: [], text: 'Reference cleared; G49 sent.' });
}

// ── The job screen's 3D view ──────────────────────────────────────────────────

/** Draws a plan's moves in the job screen's 3D view, from where the machine is. */
export function show3d(plan: Plan | null): void {
  if (!plan?.wps.length) return;
  const s = plan.wps[0];
  const TYPE: Record<string, string> = { back: 'retract', slow: 'probe', result: 'rapid' };
  (window as any).loadPreview3D?.(plan.wps.map(w => ({ x: w.x - s.x, y: w.y - s.y, z: w.z - s.z, type: TYPE[w.type] ?? w.type, label: w.label })));
}

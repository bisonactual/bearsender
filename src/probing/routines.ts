// ═══════════════════════════════════════════════
// The probing routines as the Probing screen runs them: their settings, which one is running,
// what each last said, and the moves each makes (for the preview)
// ═══════════════════════════════════════════════

import { signal } from '@preact/signals';
import type { Signal } from '@preact/signals';
import { lsGet, lsSet } from '../ui';
import { sendCmd } from '../connection';
import { lastError } from '../console';
import * as machine from '../stores/machine';
import { cancelProbing, runToolLengthProbe, probingRefusal, getActiveWcs } from './probe-program';
import { runEdgeFinder } from './edge-finder';
import { runCenterFinder } from './center-finder';
import { runRotation, applyRotationToGcode } from './rotation';
import * as pv from './preview';

export type Routine = 'tl' | 'ef' | 'cf' | 'rot';
export type Tone = 'idle' | 'run' | 'ok' | 'err';

// The old tab's keys, so the settings carry over.
const SAVE_KEY = 'fs-probing-tab';

function saved<T extends object>(sub: Routine, defaults: T): Signal<T> {
  return signal<T>({ ...defaults, ...lsGet(`${SAVE_KEY}-${sub}`, {}) });
}

/** Changes some of a routine's settings and keeps them. */
export function update<T extends object>(sub: Routine, sig: Signal<T>, patch: Partial<T>): void {
  sig.value = { ...sig.value, ...patch };
  lsSet(`${SAVE_KEY}-${sub}`, sig.value);
}

interface ProbeFeeds { probeFeedRate: number; latchFeedRate: number; probeDistance: number; latchDistance: number; }

export interface TlCfg extends ProbeFeeds { mode: 'touchplate' | 'toolsetter'; touchPlateHeight: number; toolsetterDepth: number; tloReference: number | null; }
export const tl = saved<TlCfg>('tl', {
  mode: 'touchplate', probeFeedRate: 100, latchFeedRate: 25,
  probeDistance: 50, latchDistance: 1, touchPlateHeight: 0,
  toolsetterDepth: 10, tloReference: null,
});

export interface EfCfg extends ProbeFeeds { mode: 'external' | 'internal'; xyClr: number; depth: number; offset: number; probeDiameter: number; probeZ: boolean; touchPlateHeight: number; workpieceHeight: number; }
export const ef = saved<EfCfg>('ef', {
  mode: 'external', probeFeedRate: 100, latchFeedRate: 25,
  probeDistance: 10, latchDistance: 1, xyClr: 5, depth: 3, offset: 5,
  probeDiameter: 2, probeZ: false, touchPlateHeight: 0, workpieceHeight: 0,
});

export interface CfCfg extends ProbeFeeds { centerMode: 'inside' | 'outside'; axes: 'XY' | 'X' | 'Y'; xyClr: number; depth: number; probeDiameter: number; workpieceSizeX: number; workpieceSizeY: number; passes: number; }
export const cf = saved<CfCfg>('cf', {
  centerMode: 'inside', axes: 'XY', probeFeedRate: 100, latchFeedRate: 25,
  probeDistance: 10, latchDistance: 1, xyClr: 5, depth: 3, probeDiameter: 2,
  workpieceSizeX: 50, workpieceSizeY: 50, passes: 1,
});

export interface RotCfg extends ProbeFeeds { edge: 'AB' | 'AD' | 'CB' | 'CD'; xyClr: number; depth: number; offset: number; probeDiameter: number; }
export const rot = saved<RotCfg>('rot', {
  edge: 'AB', probeFeedRate: 100, latchFeedRate: 25,
  probeDistance: 10, latchDistance: 1, xyClr: 5, depth: 3, offset: 50, probeDiameter: 2,
});

/** Where a result goes: a work offset ('' is the active one) and how (G10 or measure only). Picked each time, as before. */
export interface Target { wcs: string; mode: 'G10' | 'measure'; }
export const efTarget = signal<Target>({ wcs: '', mode: 'G10' });
export const cfTarget = signal<Target>({ wcs: '', mode: 'G10' });

/** The edge or corner picked for the edge finder: none until one is picked. */
export const efEdge = signal<string | null>(null);

/** The routine running now, if any: one at a time. */
export const running = signal<Routine | null>(null);

export const status = signal<Record<Routine, { text: string; tone: Tone }>>({
  tl: { text: 'Ready', tone: 'idle' },
  ef: { text: 'Pick an edge or corner, then PROBE', tone: 'idle' },
  cf: { text: 'Ready', tone: 'idle' },
  rot: { text: 'Ready', tone: 'idle' },
});
export const tlResult = signal('');
export const rotResult = signal('');
/** The angle measured last, until it is applied: applying it twice would turn the program twice. */
export const rotAngle = signal<number | null>(null);

/** What the preview shows, as a title. */
export const previewOf = signal('');

function say(r: Routine, text: string, tone: Tone = 'idle'): void {
  status.value = { ...status.value, [r]: { text, tone } };
}

let _cancelled = false;

/** Starts a routine's run, or says why it can't. The time it started, for the error it may end on. */
function begin(r: Routine, text: string): number | null {
  const why = probingRefusal();
  if (why) { say(r, why, 'err'); return null; }
  _cancelled = false;
  running.value = r;
  say(r, text, 'run');
  return Date.now();
}

/** Ends a run: the status after Cancel, a failure (with the reason logged since it started), or success. */
function end(r: Routine, since: number, ok: boolean, okText: string): boolean {
  running.value = null;
  if (_cancelled) { say(r, 'Cancelled: the move in progress was stopped', 'idle'); return false; }
  if (!ok) {
    const e = lastError.value;
    say(r, e && e.at >= since ? e.text.replace(/^✗\s*/, '') : 'Probe failed', 'err');
    return false;
  }
  say(r, okText, 'ok');
  return true;
}

export function cancel(): void {
  const r = running.value;
  if (!r) return;
  _cancelled = true;
  cancelProbing();
  say(r, 'Cancelling…', 'run');
}

// ── Tool length ───────────────────────────────────────────────────────────────

export async function measureTool(asReference: boolean): Promise<void> {
  const c = tl.value;
  const ts = machine.offsets.value['G59.3'];
  if (c.mode === 'toolsetter' && !ts && !probingRefusal()) {
    say('tl', 'G59.3 not set: read the offsets, or set the toolsetter there (Setup, Offsets)', 'err');
    return;
  }
  const since = begin('tl', asReference ? 'Measuring the reference tool…' : 'Probing…');
  if (since === null) return;
  const result = await runToolLengthProbe({
    mode: c.mode,
    probeFeedRate: c.probeFeedRate, latchFeedRate: c.latchFeedRate,
    probeDistance: c.probeDistance, latchDistance: c.latchDistance,
    touchPlateHeight: c.touchPlateHeight,
    toolsetterX: ts?.x, toolsetterY: ts?.y, toolsetterZ: ts?.z,
    toolsetterDepth: c.toolsetterDepth,
  });
  const ok = !!result && result.success;
  if (!end('tl', since, ok, asReference ? '✓ Reference set' : '✓ Complete: TLO applied') || !result) return;
  if (asReference) {
    update('tl', tl, { tloReference: result.z });
    sendCmd('G49');
  } else {
    // Against a reference, the plate (or the toolsetter) is under both tools, so it drops out. Without one,
    // the touch plate's thickness comes off once; a toolsetter has none.
    const tlo = c.tloReference !== null ? result.z - c.tloReference
      : c.mode === 'touchplate' ? result.z - c.touchPlateHeight : result.z;
    sendCmd(`G21G43.1Z${tlo.toFixed(4)}`);
    tlResult.value = `Z=${result.z.toFixed(4)}  TLO=${tlo.toFixed(4)} mm`;
  }
}

export function clearReference(): void {
  update('tl', tl, { tloReference: null });
  sendCmd('G49');
  say('tl', 'Reference cleared');
}

// ── Edge finder, centre finder, rotation ──────────────────────────────────────

export async function findEdge(): Promise<void> {
  const edge = efEdge.value;
  if (!edge) { say('ef', 'Pick an edge or corner first', 'err'); return; }
  const t = efTarget.value;
  const since = begin('ef', `Probing ${edge}…`);
  if (since === null) return;
  const ok = await runEdgeFinder({ ...ef.value, edge, coordMode: t.mode, wcs: t.wcs || getActiveWcs() });
  end('ef', since, ok, `✓ ${edge} complete`);
}

export async function findCentre(): Promise<void> {
  const t = cfTarget.value;
  const since = begin('cf', 'Finding the centre…');
  if (since === null) return;
  const ok = await runCenterFinder({ ...cf.value, passes: cf.value.passes || 1, coordMode: t.mode, wcs: t.wcs || getActiveWcs() });
  end('cf', since, ok, '✓ Centre found');
}

export async function measureRotation(): Promise<void> {
  const since = begin('rot', 'Probing…');
  if (since === null) return;
  rotAngle.value = null;
  rotResult.value = '';
  const r = await runRotation(rot.value);
  if (!end('rot', since, !!r, r ? `✓ Measured: ${r.angleDeg.toFixed(3)}°` : '') || !r) return;
  rotAngle.value = r.angleDeg;
  rotResult.value = `Angle: ${r.angleDeg.toFixed(3)}°`;
}

export function applyRotation(): void {
  const a = rotAngle.value;
  if (a === null) return;
  applyRotationToGcode(a);
  rotAngle.value = null;
  say('rot', `✓ G-code rotated by ${a.toFixed(3)}°`, 'ok');
}

// ── Preview ───────────────────────────────────────────────────────────────────

/** Shows a routine's moves in the preview card, and in the job screen's 3D view as before. */
function show(title: string, wps: pv.Waypoint[]): void {
  previewOf.value = title;
  pv.loadPreview(wps);
  (window as any).loadPreview3D?.(wps);
}

export function preview(r: Routine): void {
  if (r === 'tl') {
    const c = tl.value;
    if (c.mode === 'toolsetter') {
      const ts = machine.offsets.value['G59.3'] || { x: 50, y: 50, z: -20 };
      const at = machine.mpos.value;
      show('TOOL LENGTH · TOOLSETTER', pv.waypointsToolsetter({
        probeDistance: c.probeDistance, latchDistance: c.latchDistance, toolsetterDepth: c.toolsetterDepth,
        tsOffX: ts.x - at.x, tsOffY: ts.y - at.y, tsOffZ: ts.z - at.z,
      }));
    } else {
      show('TOOL LENGTH · TOUCH PLATE', pv.waypointsTouchplate({ probeDistance: c.probeDistance, latchDistance: c.latchDistance, touchPlateHeight: c.touchPlateHeight }));
    }
  } else if (r === 'ef') {
    const edge = efEdge.value;
    if (!edge) { say('ef', 'Pick an edge or corner first', 'err'); return; }
    const c = ef.value;
    const title = `EDGE FINDER · ${edge.length === 1 ? 'CORNER ' : edge === 'Z' ? '' : 'EDGE '}${edge} · ${c.mode.toUpperCase()}`;
    if (edge === 'Z') show(title, pv.waypointsTouchplate({ probeDistance: c.probeDistance, latchDistance: c.latchDistance, touchPlateHeight: 0 }));
    else if (edge.length === 1) show(title, pv.waypointsEdgeCorner({ ...c, edge }));
    else show(title, pv.waypointsEdgeSingle({ ...c, edge }));
  } else if (r === 'cf') {
    const c = cf.value;
    show(`CENTRE FINDER · ${c.centerMode.toUpperCase()} · ${c.axes}`, pv.waypointsCenter({
      centerMode: c.centerMode, axes: c.axes, sizeX: c.workpieceSizeX, sizeY: c.workpieceSizeY,
      xyClr: c.xyClr, depth: c.depth, probeDistance: c.probeDistance, latchDistance: c.latchDistance, probeDiameter: c.probeDiameter,
    }));
  } else {
    const c = rot.value;
    show(`ROTATION · EDGE ${c.edge}`, pv.waypointsRotation(c));
  }
}

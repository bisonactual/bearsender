// ═══════════════════════════════════════════════
// The Probing screen: tool length, edge finder, centre finder and rotation, the probe preview, and
// the position and jog cards to put the probe where a routine starts. The job screen's probe and
// measure popups show the same routine and preview cards.
// ═══════════════════════════════════════════════

import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import type { Signal } from '@preact/signals';
import * as connection from '../stores/connection';
import * as machine from '../stores/machine';
import * as job from '../stores/job';
import * as ui from './ui';
import * as pr from '../probing/routines';
import * as pv from '../probing/preview';
import { getActiveWcs } from '../probing/probe-program';
import { Card, NumIn, PositionCard, JogCard, width } from './SetupScreen';

const fix3 = (v: number) => v.toFixed(3);
const WCS9 = ['G54', 'G55', 'G56', 'G57', 'G58', 'G59', 'G59.1', 'G59.2', 'G59.3'];

const PROBING_TABS: [ui.ProbingTab, string][] = [['tl', 'TOOL LENGTH'], ['ef', 'EDGE FINDER'], ['cf', 'CENTRE FINDER'], ['rot', 'ROTATION']];

function Seg<T extends string>({ value, set, opts, label }: { value: T; set: (v: T) => void; opts: [T, string][]; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} class="fs-seg fs-seg-sm fs-self-start">
      {opts.map(([v, t]) => <button type="button" role="radio" aria-checked={v === value ? 'true' : 'false'} class={v === value ? 'is-on' : ''} onClick={() => set(v)}>{t}</button>)}
    </div>
  );
}

type NumKey<T> = { [K in keyof T]: T[K] extends number ? K : never }[keyof T];
type FieldDef<T> = [NumKey<T>, string, number, number?, number?];

/** Number fields for a routine's settings, kept as they change. */
function Fields<T extends object>({ sub, sig, list }: { sub: pr.Routine; sig: Signal<T>; list: FieldDef<T>[] }) {
  const c = sig.value;
  return (
    <div class="fs-fields">
      {list.map(([k, label, step, min, max]) => (
        <label class="fs-field"><span>{label}</span>
          <NumIn value={c[k] as unknown as number} step={step} min={min} max={max} label={label} set={v => pr.update(sub, sig, { [k]: v } as Partial<T>)} />
        </label>
      ))}
    </div>
  );
}

const FEEDS: FieldDef<{ probeFeedRate: number; latchFeedRate: number; probeDistance: number; latchDistance: number }>[] = [
  ['probeFeedRate', 'Probe feed, mm/min', 10, 1], ['latchFeedRate', 'Latch feed, mm/min', 5, 1],
  ['probeDistance', 'Probe distance, mm', 1, 1], ['latchDistance', 'Latch distance, mm', 0.1, 0.1],
];

/** Where an edge or centre result is written. */
function TargetFields({ sig }: { sig: Signal<pr.Target> }) {
  const t = sig.value;
  return (
    <div class="fs-fields">
      <label class="fs-field"><span>Write to</span>
        <select class="fs-in" aria-label="Work offset to write" value={t.wcs} onChange={e => { sig.value = { ...t, wcs: (e.target as HTMLSelectElement).value }; }}>
          <option value="">Active ({getActiveWcs()})</option>
          {WCS9.map(o => <option value={o}>{o === 'G59.3' ? 'G59.3 (toolsetter)' : o}</option>)}
        </select>
      </label>
      <label class="fs-field"><span>As</span>
        <select class="fs-in" aria-label="How the result is written" value={t.mode} onChange={e => { sig.value = { ...t, mode: (e.target as HTMLSelectElement).value as pr.Target['mode'] }; }}>
          <option value="G10">G10: kept</option>
          <option value="G92">G92: this session</option>
          <option value="measure">Measure only</option>
        </select>
      </label>
    </div>
  );
}

/** The routine's status, its result, and its buttons: always in view, below the settings. */
function Foot({ r, run, result, extra }: { r: pr.Routine; run: () => void; result?: string; extra?: ComponentChildren }) {
  const linked = connection.connected.value;
  const busy = pr.running.value;
  const s = pr.status.value[r];
  return (
    <div class="fs-probe-foot">
      <div class={'fs-pstatus is-' + s.tone} role="status">{s.text}</div>
      {result && <div class="fs-presult fs-mono">{result}</div>}
      <div class="fs-probe-btns">
        <button type="button" class="fs-btn" title="Show the moves in the preview, and in the job screen's 3D view" onClick={() => pr.preview(r)}>PREVIEW</button>
        <button type="button" class="fs-btn fs-btn-go" disabled={!linked || !!busy} onClick={run}>PROBE</button>
        {extra}
        <button type="button" class={'fs-btn' + (busy ? ' is-stop' : '')} disabled={!busy} title="Stop the routine and the move in progress" onClick={() => pr.cancel()}>CANCEL</button>
      </div>
    </div>
  );
}

// ── The routines ──────────────────────────────────────────────────────────────

function ToolLengthCard() {
  const c = pr.tl.value;
  const ts = machine.offsets.value['G59.3'];
  const tlo = machine.tlo.value;
  const linked = connection.connected.value;
  const busy = !!pr.running.value;
  return (
    <Card title="TOOL LENGTH" class="fs-probe-card">
      <div class="fs-probe-body">
        <Seg label="Measure on" value={c.mode} set={v => pr.update('tl', pr.tl, { mode: v })}
          opts={[['touchplate', 'TOUCH PLATE'], ['toolsetter', 'TOOLSETTER (G59.3)']]} />
        <div class="fs-cap">PROBE</div>
        <Fields sub="tl" sig={pr.tl} list={FEEDS} />
        {c.mode === 'touchplate'
          ? <Fields sub="tl" sig={pr.tl} list={[['touchPlateHeight', 'Plate height, mm', 0.1, 0]]} />
          : <>
            <Fields sub="tl" sig={pr.tl} list={[['toolsetterDepth', 'Approach depth, mm', 1, 1]]} />
            <div class="fs-note">{ts
              ? <>The toolsetter is G59.3: <span class="fs-mono">X {fix3(ts.x)} Y {fix3(ts.y)} Z {fix3(ts.z)}</span>, machine coordinates. Set it in Setup, Offsets.</>
              : 'The toolsetter is G59.3, not read yet. Set it in Setup, Offsets.'}</div>
          </>}
        <div class="fs-cap">REFERENCE TOOL</div>
        <div class={'fs-mono ' + (c.tloReference !== null ? 'fs-go-text' : 'fs-dim')}>{c.tloReference !== null ? `Ref: ${c.tloReference.toFixed(4)} mm` : 'No reference set'}</div>
        <div class="fs-grid2b">
          <button type="button" class="fs-btn" disabled={!linked || busy} title="Probe this tool as the reference the others are measured from" onClick={() => pr.measureTool(true)}>SET REF TOOL</button>
          {c.tloReference !== null && <button type="button" class="fs-btn" title="Forget the reference and cancel the tool length offset (G49)" onClick={() => pr.clearReference()}>CLEAR</button>}
        </div>
        <div class="fs-note">Tool length offset now: <span class="fs-mono">{tlo === null ? 'not read' : fix3(tlo) + ' mm'}</span></div>
      </div>
      <Foot r="tl" run={() => pr.measureTool(false)} result={pr.tlResult.value} />
    </Card>
  );
}

// The probe's direction of travel for each edge and corner, from outside the stock; inside, it is the reverse.
const OUTSIDE: Record<string, string> = { A: '↗', B: '↖', C: '↙', D: '↘', AD: '→', CB: '←', AB: '↑', CD: '↓', Z: '↓' };
const REVERSE: Record<string, string> = { '↗': '↙', '↙': '↗', '↖': '↘', '↘': '↖', '→': '←', '←': '→', '↑': '↓', '↓': '↑' };
// As the stock is seen from above: corners at its corners, edges at its sides, Z in the middle.
const EDGES: [string, string][] = [['D', 'X− Y+'], ['CD', 'Y+'], ['C', 'X+ Y+'], ['AD', 'X−'], ['Z', 'top'], ['CB', 'X+'], ['A', 'X− Y−'], ['AB', 'Y−'], ['B', 'X+ Y−']];

function EdgeFinderCard() {
  const c = pr.ef.value;
  const edge = pr.efEdge.value;
  const arrow = (id: string) => c.mode === 'internal' && id !== 'Z' ? REVERSE[OUTSIDE[id]] : OUTSIDE[id];
  return (
    <Card title="EDGE FINDER" class="fs-probe-card">
      <div class="fs-probe-body">
        <Seg label="Probe from" value={c.mode} set={v => pr.update('ef', pr.ef, { mode: v })} opts={[['external', 'EXTERNAL'], ['internal', 'INTERNAL']]} />
        <div class="fs-cap">EDGE OR CORNER</div>
        <div class="fs-edgegrid" role="radiogroup" aria-label="Edge or corner">
          {EDGES.map(([id, side]) => (
            <button type="button" role="radio" aria-checked={edge === id ? 'true' : 'false'} class={'fs-edge' + (edge === id ? ' is-on' : '') + (id.length === 2 ? ' is-side' : '')}
              title={id === 'Z' ? 'The top surface' : (id.length === 1 ? 'Corner ' : 'Edge ') + id + ', the ' + side + ' ' + (id.length === 1 ? 'corner' : 'side')}
              onClick={() => { pr.efEdge.value = id; pr.status.value = { ...pr.status.value, ef: { text: `${id.length === 1 ? 'Corner' : id === 'Z' ? 'Surface' : 'Edge'} ${id} picked`, tone: 'idle' } }; }}>
              <span class="fs-edge-id">{id} {arrow(id)}</span><span class="fs-edge-side">{side}</span>
            </button>
          ))}
        </div>
        <div class="fs-cap">RESULT</div>
        <TargetFields sig={pr.efTarget} />
        <div class="fs-cap">PROBE</div>
        <Fields sub="ef" sig={pr.ef} list={[...FEEDS as FieldDef<pr.EfCfg>[],
          ['xyClr', 'XY clearance, mm', 0.5, 0.5], ['depth', 'Probe depth, mm', 0.5, 0.5],
          ['offset', 'Corner offset, mm', 1, 1], ['probeDiameter', 'Probe dia., mm', 0.1, 0]]} />
        <label class="fs-check">
          <input type="checkbox" checked={c.probeZ} onChange={e => pr.update('ef', pr.ef, { probeZ: (e.target as HTMLInputElement).checked })} />
          Also probe Z at a corner
        </label>
        {(c.probeZ || edge === 'Z') && <Fields sub="ef" sig={pr.ef} list={[['touchPlateHeight', 'Touch plate height, mm', 0.1, 0], ['workpieceHeight', 'Workpiece height, mm', 0.1, 0]]} />}
      </div>
      <Foot r="ef" run={() => pr.findEdge()} />
    </Card>
  );
}

function CentreFinderCard() {
  const c = pr.cf.value;
  return (
    <Card title="CENTRE FINDER" class="fs-probe-card">
      <div class="fs-probe-body">
        <Seg label="Centre of" value={c.centerMode} set={v => pr.update('cf', pr.cf, { centerMode: v })} opts={[['inside', 'INSIDE (BORE)'], ['outside', 'OUTSIDE (BOSS)']]} />
        <Seg label="Axes" value={c.axes} set={v => pr.update('cf', pr.cf, { axes: v })} opts={[['XY', 'XY'], ['X', 'X ONLY'], ['Y', 'Y ONLY']]} />
        <div class="fs-cap">WORKPIECE SIZE</div>
        <Fields sub="cf" sig={pr.cf} list={[['workpieceSizeX', 'X size, mm', 1, 1], ['workpieceSizeY', 'Y size, mm', 1, 1]]} />
        <div class="fs-cap">RESULT</div>
        <TargetFields sig={pr.cfTarget} />
        <div class="fs-cap">PROBE</div>
        <Fields sub="cf" sig={pr.cf} list={[...FEEDS as FieldDef<pr.CfCfg>[],
          ['xyClr', 'XY clearance, mm', 0.5, 0.5], ['depth', 'Probe depth, mm', 0.5, 0.5],
          ['probeDiameter', 'Probe dia., mm', 0.1, 0], ['passes', 'Passes', 1, 1, 5]]} />
      </div>
      <Foot r="cf" run={() => pr.findCentre()} />
    </Card>
  );
}

function RotationCard() {
  const c = pr.rot.value;
  const loaded = job.lines.value.length > 0;
  const angle = pr.rotAngle.value;
  return (
    <Card title="ROTATION" class="fs-probe-card">
      <div class="fs-probe-body">
        <div class="fs-cap">EDGE TO PROBE ALONG</div>
        <Seg label="Edge" value={c.edge} set={v => pr.update('rot', pr.rot, { edge: v })} opts={[['AB', 'AB'], ['AD', 'AD'], ['CB', 'CB'], ['CD', 'CD']]} />
        <div class="fs-note">AB bottom (Y−) · AD left (X−) · CB right (X+) · CD top (Y+)</div>
        <div class="fs-cap">PROBE</div>
        <Fields sub="rot" sig={pr.rot} list={[...FEEDS as FieldDef<pr.RotCfg>[],
          ['xyClr', 'XY clearance, mm', 0.5, 0.5], ['depth', 'Probe depth, mm', 0.5, 0.5],
          ['offset', 'Point spacing, mm', 5, 5], ['probeDiameter', 'Probe dia., mm', 0.1, 0]]} />
        <div class="fs-note">APPLY ROTATION turns the loaded program about X0 Y0 by the angle measured, once.{loaded ? '' : ' No program is loaded.'}</div>
      </div>
      <Foot r="rot" run={() => pr.measureRotation()} result={pr.rotResult.value} extra={
        <button type="button" class="fs-btn is-accent" disabled={angle === null || !loaded}
          title={angle === null ? 'Measure first' : `Turn the program by ${angle.toFixed(3)}°`} onClick={() => pr.applyRotation()}>APPLY ROTATION</button>
      } />
    </Card>
  );
}

function RoutineCard({ tab }: { tab: ui.ProbingTab }) {
  return tab === 'tl' ? <ToolLengthCard /> : tab === 'ef' ? <EdgeFinderCard /> : tab === 'cf' ? <CentreFinderCard /> : <RotationCard />;
}

// ── The preview ───────────────────────────────────────────────────────────────

const LEGEND: [string, string][] = [['rapid', 'Rapid'], ['probe', 'Probe'], ['retract', 'Retract'], ['contact', 'Contact'], ['result', 'Result']];

function PreviewCard() {
  const wps = pv.waypoints.value;
  const cur = pv.step.value;
  const xy = useRef<HTMLCanvasElement>(null);
  const xz = useRef<HTMLCanvasElement>(null);
  const draw = () => {
    if (xy.current) pv.drawView(xy.current, 'XY', pv.waypoints.peek(), pv.step.peek());
    if (xz.current) pv.drawView(xz.current, 'XZ', pv.waypoints.peek(), pv.step.peek());
  };
  useEffect(draw, [wps, cur]);
  useEffect(() => {
    const ro = new ResizeObserver(draw);
    if (xy.current) ro.observe(xy.current);
    if (xz.current) ro.observe(xz.current);
    return () => ro.disconnect();
  }, []);
  const wp = wps[cur];
  return (
    <Card title="PROBE PREVIEW" class="fs-pv-card" end={<span class="fs-dim fs-pv-title">{pr.previewOf.value || 'Press PREVIEW on a routine'}</span>}>
      <div class="fs-pv-views">
        <div class="fs-pv-view"><canvas ref={xy} aria-label="The moves from above, X and Y" /></div>
        <div class="fs-pv-view"><canvas ref={xz} aria-label="The moves from the front, X and Z" /></div>
      </div>
      <div class="fs-pv-ctl">
        <button type="button" class="fs-btn fs-btn-sm" aria-label="Previous move" disabled={cur <= 0} onClick={() => pv.stepPreview(-1)}>◀</button>
        <button type="button" class="fs-btn fs-btn-sm" aria-label={pv.playing.value ? 'Pause' : 'Play'} disabled={!wps.length} onClick={() => pv.playPreview()}>{pv.playing.value ? '❚❚' : '▶'}</button>
        <button type="button" class="fs-btn fs-btn-sm" aria-label="Next move" disabled={cur >= wps.length - 1} onClick={() => pv.stepPreview(1)}>▶|</button>
        <span class="fs-mono fs-dim">{wps.length ? `${cur + 1} / ${wps.length}` : '—'}</span>
        <span class="fs-pv-step fs-ellipsis">{wp?.label ?? ''}</span>
      </div>
      <div class="fs-pv-dro fs-mono">
        {(['x', 'y', 'z'] as const).map(a => <span><span class="fs-dim">{a.toUpperCase()}</span> {wp ? fix3(wp[a]) : '—'}</span>)}
      </div>
      <div class="fs-legend">
        {LEGEND.map(([t, label]) => <span><i style={{ background: pv.TYPE_COLOR[t] }} />{label}</span>)}
      </div>
      <div class="fs-note">Moves in mm from where the probe starts. PREVIEW also draws them in the job screen's 3D view.</div>
    </Card>
  );
}

// ── The screen and the popups ─────────────────────────────────────────────────

function ProbingTabs() {
  const tab = ui.probingTab.value;
  return (
    <div role="tablist" class="fs-subtabs">
      {PROBING_TABS.map(([id, label]) => (
        <button type="button" role="tab" aria-selected={tab === id ? 'true' : 'false'} class={tab === id ? 'is-on' : ''}
          onClick={() => { ui.probingTab.value = id; }}>{label}{pr.running.value === id ? ' ●' : ''}</button>
      ))}
    </div>
  );
}

export function ProbingScreen() {
  if (ui.screen.value !== 'probing') return null;
  const tab = ui.probingTab.value;
  // Three columns from 1000 px, two below; each scrolls on its own, so the page never does.
  return (
    <section class="fs-screen">
      <ProbingTabs />
      <div class="fs-setup">
        <div class="fs-col"><RoutineCard tab={tab} /></div>
        {width.value >= 1000
          ? <><div class="fs-col"><PreviewCard /></div><div class="fs-col"><PositionCard /><JogCard /></div></>
          : <div class="fs-col"><PreviewCard /><PositionCard /><JogCard /></div>}
      </div>
    </section>
  );
}

/** The job screen's probe and measure popups: the routines and the preview. */
export function ProbingPopupBody() {
  return (
    <div class="fs-probe-popup">
      <ProbingTabs />
      <div class="fs-setup">
        <div class="fs-col"><RoutineCard tab={ui.probingTab.value} /></div>
        <div class="fs-col"><PreviewCard /></div>
      </div>
    </div>
  );
}

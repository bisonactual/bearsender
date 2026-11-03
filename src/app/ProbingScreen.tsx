// ═══════════════════════════════════════════════
// The Probing screen, as the agreed mockup (3 Nov): four routines, each in three numbered columns in the
// order of the work. 1: what to measure, picked on a picture of the part. 2: where to start the probe
// and what it does, drawn from the routine itself (plan.ts). 3: the probe light, the jog pad, then the
// status, the result and PROBE and CANCEL, always in view. The job screen's PROBE and MEASURE popups
// show the same columns.
// ═══════════════════════════════════════════════

import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { signal, effect } from '@preact/signals';
import type { Signal } from '@preact/signals';
import * as connection from '../stores/connection';
import * as machine from '../stores/machine';
import * as job from '../stores/job';
import * as jog from '../jog';
import * as ui from './ui';
import * as pr from '../probing/routines';
import * as ps from '../probing/settings';
import { makePlan, CORNER_NAMES } from '../probing/plan';
import type { Plan, PlanInputs, Routine } from '../probing/plan';
import { viewSvg, pickerSvg, pickAt, tileSvg } from '../probing/drawing';
import type { ViewState } from '../probing/drawing';
import { SIDES } from '../probing/edge-finder';
import { getActiveWcs } from '../probing/probe-program';
import { JogButton, Steps, NumIn } from './SetupScreen';
import { ProbeSettingsCard, UnitField } from './ProbeSettings';

const f3 = (v: number) => (v < 0 ? '−' : '') + Math.abs(v).toFixed(3);
const ROUTINES: Routine[] = ['tl', 'ef', 'cf', 'rot'];
const PROBING_TABS: [ui.ProbingTab, string][] = [['tl', 'TOOL LENGTH'], ['ef', 'EDGE & CORNER'], ['cf', 'CENTRE'], ['rot', 'ROTATION']];
const TAB_NAME = Object.fromEntries(PROBING_TABS) as Record<Routine, string>;

export function Seg<T extends string>({ value, set, opts, label }: { value: T; set: (v: T) => void; opts: [T, string][]; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} class="fs-seg fs-seg-sm fs-self-start">
      {opts.map(([v, t]) => <button type="button" role="radio" aria-checked={v === value ? 'true' : 'false'} class={v === value ? 'is-on' : ''} onClick={() => set(v)}>{t}</button>)}
    </div>
  );
}

/** The mockup's segmented choice: taller text, and the full width with `full`. */
function Choice<T extends string>({ value, set, opts, label, full }: { value: T; set: (v: T) => void; opts: [T, string][]; label: string; full?: boolean }) {
  return (
    <div role="radiogroup" aria-label={label} class={'fs-seg fs-pseg' + (full ? ' is-full' : '')}>
      {opts.map(([v, t]) => <button type="button" role="radio" aria-checked={v === value ? 'true' : 'false'} class={v === value ? 'is-on' : ''} onClick={() => set(v)}>{t}</button>)}
    </div>
  );
}

// Each routine's plan, for its drawing: a dry run whenever what it depends on changes

function inputs(): PlanInputs {
  const linked = connection.connected.value;
  return {
    P: ps.probe.value, tl: pr.toolLengthConfig.value, ef: pr.edgeConfig.value, efEdge: pr.pickedEdge.value, cf: pr.centreConfig.value, rot: pr.rotationConfig.value,
    ts: machine.offsets.value['G59.3'] ?? null,
    // Where the machine is matters to the toolsetter's drawing only; it is read when the rest changes, not followed.
    at: linked ? machine.mpos.peek() : null,
  };
}

const plans = signal<Partial<Record<Routine, Plan>>>({});
let planSeq = 0;
effect(() => {
  const inp = inputs(), n = ++planSeq;
  Promise.all(ROUTINES.map(r => makePlan(r, inp))).then(list => {
    if (n === planSeq) plans.value = Object.fromEntries(list.map(p => [p.r, p]));
  });
});

/** The preview's step, per routine, and whether the drawing follows a run that ended badly (until the
 *  preview is stepped). */
const pvStep = signal<Record<Routine, number>>({ tl: 0, ef: 0, cf: 0, rot: 0 });
const pvFree = signal<Record<Routine, boolean>>({ tl: true, ef: true, cf: true, rot: true });
let pvTimer: ReturnType<typeof setInterval> | null = null;
const pvPlaying = signal<Routine | null>(null);

function setStep(r: Routine, i: number): void {
  pvStep.value = { ...pvStep.value, [r]: i };
  pvFree.value = { ...pvFree.value, [r]: true };
}
function stopPlay(): void { if (pvTimer) clearInterval(pvTimer); pvTimer = null; pvPlaying.value = null; }
function play(r: Routine, n: number): void {
  if (pvPlaying.value === r) { stopPlay(); return; }
  stopPlay();
  setStep(r, 0);
  pvPlaying.value = r;
  pvTimer = setInterval(() => {
    const i = pvStep.value[r];
    if (i >= n - 1) { stopPlay(); return; }
    setStep(r, i + 1);
  }, 420);
}

const settingsOpen = signal(false);

async function probeNow(r: Routine, asReference = false): Promise<void> {
  stopPlay();
  // Planned again now, from where the machine is: the drawing then follows the run step for step.
  const plan = await makePlan(r, { ...inputs(), at: machine.mpos.peek() });
  pvFree.value = { ...pvFree.value, [r]: false };
  if (r === 'tl') await pr.measureTool(asReference, plan);
  else if (r === 'ef') await pr.findEdge(plan);
  else if (r === 'cf') await pr.findCentre(plan);
  else await pr.measureRotation(plan);
  const run = pr.runs.value[r];
  if (run?.phase === 'ok' && run.plan) pvStep.value = { ...pvStep.value, [r]: run.plan.wps.length - 1 };
}

// ── Column 1: what to measure ─────────────────────────────────────────────────

const WCS8 = ['G54', 'G55', 'G56', 'G57', 'G58', 'G59', 'G59.1', 'G59.2'];

/** Where a result goes, in plain words. */
function TargetBlock({ sig, what }: { sig: Signal<pr.Target>; what: string }) {
  const t = sig.value;
  const tell = t.mode === 'G10' ? `Writes ${what} into the offset (G10 L2). Kept until changed.` : 'Shows what it found and changes nothing.';
  return (
    <div class="fs-psect">
      <div class="fs-cap">RESULT</div>
      <label class="fs-prow2"><span>Set the zero in</span>
        <select class="fs-in" aria-label="Work offset to set the zero in" value={t.wcs} onChange={e => { sig.value = { ...t, wcs: (e.target as HTMLSelectElement).value }; }}>
          <option value="">{getActiveWcs()} · the active one</option>
          {WCS8.map(o => <option value={o}>{o}</option>)}
          <option value="G59.3">G59.3 · the toolsetter's place</option>
        </select>
      </label>
      <Choice label="How the result is used" full value={t.mode} set={v => { sig.value = { ...t, mode: v }; }} opts={[['G10', 'SAVE IT'], ['measure', 'JUST MEASURE']]} />
      <div class="fs-note">{tell}</div>
    </div>
  );
}

/** The probe settings in one line, and the way to them. */
function ProbeLine({ toolLength }: { toolLength?: boolean }) {
  const P = ps.probe.value;
  const problems = ps.probeProblems(P, toolLength);
  const n = (v: number) => Number.isFinite(v) ? String(v) : '?';
  return (
    <div class={'fs-psect fs-pset' + (problems.length ? ' is-warn' : '')}>
      <span>{problems.length ? <>Probe settings can't be used, so no routine sends them: {problems.join('; ')}.</>
        : <>Probe: tip Ø <b class="fs-mono">{Number.isFinite(P.tip) ? P.tip.toFixed(3) : '?'}</b> · fast <b class="fs-mono">{n(P.fast)}</b>, slow <b class="fs-mono">{n(P.slow)}</b> mm/min · back off <b class="fs-mono">{n(P.back)}</b> · clearance <b class="fs-mono">{n(P.clear)}</b> · search <b class="fs-mono">{n(P.search)}</b> mm</>}</span>
      <button type="button" class="fs-btn fs-btn-sm" onClick={() => { settingsOpen.value = true; }}>PROBE SETTINGS</button>
    </div>
  );
}

/** Measures an element as it is laid out, for the drawings. */
function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize(s => s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

const SIDE_IDS = ['CD', 'AD', 'CB', 'AB'];

function pickName(id: string, ins: boolean): string {
  if (id === 'Z') return ins ? 'Pocket floor' : 'Top surface';
  const n = id.length === 1 ? CORNER_NAMES[id] : `${SIDES[id].name} ${ins ? 'wall' : 'side'}`;
  return n[0].toUpperCase() + n.slice(1);
}

/** The part from above with a round target on each corner, side and the top; rotation shows the sides only. */
function Picker({ kind }: { kind: 'ef' | 'rot' }) {
  const [ref, size] = useSize<HTMLDivElement>();
  const ins = kind === 'ef' && pr.edgeConfig.value.mode === 'internal';
  const pick = kind === 'ef' ? pr.pickedEdge.value : pr.rotationConfig.value.edge;
  const ids = kind === 'ef' ? Object.keys(CORNER_NAMES).concat(Object.keys(SIDES), ['Z']) : SIDE_IDS;
  return (
    <div class="fs-picker" ref={ref} role="radiogroup" aria-label={kind === 'ef' ? 'Corner, side or surface' : 'Side to measure along'}>
      <svg class="fs-pk-svg" aria-hidden="true" viewBox={`0 0 ${size.w || 1} ${size.h || 1}`} dangerouslySetInnerHTML={{ __html: pickerSvg(size.w, size.h, pick, ins, kind === 'rot') }} />
      <span class="fs-pk-lab is-back">BACK · Y+</span><span class="fs-pk-lab is-front">FRONT · Y−</span>
      <span class="fs-pk-lab is-left">LEFT<br />X−</span><span class="fs-pk-lab is-right">RIGHT<br />X+</span>
      {ids.map(id => {
        const [x, y] = pickAt(id), name = kind === 'rot' ? pickName(id, false) : pickName(id, ins);
        return <button type="button" class={'fs-pk-t' + (pick === id ? ' is-on' : '')} role="radio" aria-checked={pick === id ? 'true' : 'false'}
          aria-label={name} title={`${name} (${id})`} style={{ left: x + '%', top: y + '%' }}
          onClick={() => kind === 'ef' ? pr.pickEdge(id) : pr.update('rot', pr.rotationConfig, { edge: id as pr.RotationEdge })} />;
      })}
    </div>
  );
}

function Tiles<T extends 'bore' | 'boss' | 'plate' | 'setter', V extends string>({ label, value, opts, set }: { label: string; value: V; opts: [V, T, string][]; set: (v: V) => void }) {
  return (
    <div class="fs-tiles" role="radiogroup" aria-label={label}>
      {opts.map(([v, pic, t]) => (
        <button type="button" role="radio" aria-checked={v === value ? 'true' : 'false'} class={'fs-tile' + (v === value ? ' is-on' : '')} onClick={() => set(v)}>
          <span class="fs-tile-pic" dangerouslySetInnerHTML={{ __html: tileSvg(pic) }} />{t}
        </button>
      ))}
    </div>
  );
}

function EdgeWhat() {
  const c = pr.edgeConfig.value, ins = c.mode === 'internal', pick = pr.pickedEdge.value;
  const set = (p: Partial<pr.EdgeFinderConfig>) => pr.update('ef', pr.edgeConfig, p);
  const kind = !pick ? '' : pick === 'Z' ? 'z' : pick.length === 2 ? 's' : 'c';
  const sets = kind === 'c' ? 'sets X and Y' + (c.probeZ ? ' and Z' : '') : kind === 's' ? 'sets ' + SIDES[pick!].axis : 'sets Z';
  return <>
    <Choice label="Probe from" full value={c.mode} set={v => set({ mode: v })} opts={[['external', 'OUTSIDE THE PART'], ['internal', 'INSIDE A POCKET']]} />
    <Picker kind="ef" />
    {pick ? <div class="fs-pk-cap"><span class="nm">{pickName(pick, ins)}</span><span class="ds">{sets} · was “{pick}”</span></div>
      : <div class="fs-pk-cap"><span class="ds">Pick a corner, a side or the top: tap its target.</span></div>}
    {kind === 'c' && <label class="fs-pchk"><input type="checkbox" checked={c.probeZ} onChange={e => set({ probeZ: (e.target as HTMLInputElement).checked })} /> Also probe Z {ins ? 'on the pocket floor' : 'on the top'} at the corner</label>}
    {kind && <div class="fs-prow">
      {kind === 'c' && <UnitField label="Touch the sides this far from the corner" value={c.offset} unit="mm" step={1} min={0} set={v => set({ offset: v })} />}
      {kind !== 'z' && <UnitField label="Probe this far below the start" value={c.depth} unit="mm" step={0.5} min={0} set={v => set({ depth: v })} />}
      {(kind === 'z' || c.probeZ) && <>
        <UnitField label="Plate under the probe (0 = none)" value={c.touchPlateHeight} unit="mm" step={0.1} min={0} set={v => set({ touchPlateHeight: v })} />
        <UnitField label={`Put Z0 this far below the ${ins ? 'floor' : 'top'}`} value={c.workpieceHeight} unit="mm" step={0.1} set={v => set({ workpieceHeight: v })} />
      </>}
    </div>}
    <TargetBlock sig={pr.edgeTarget} what={kind === 'c' ? (c.probeZ ? 'X, Y and Z' : 'X and Y') : kind === 's' ? SIDES[pick!].axis : kind === 'z' ? 'Z' : 'the zero'} />
    <ProbeLine />
  </>;
}

function CentreWhat() {
  const c = pr.centreConfig.value;
  const set = (p: Partial<typeof c>) => pr.update('cf', pr.centreConfig, p);
  return <>
    <Tiles label="Centre of" value={c.centerMode} set={v => set({ centerMode: v })} opts={[['inside', 'bore', 'BORE · INSIDE'], ['outside', 'boss', 'BOSS · OUTSIDE']]} />
    <div class="fs-prow fs-pmid"><span class="fs-cap">FIND</span><Choice label="Axes" value={c.axes} set={v => set({ axes: v })} opts={[['XY', 'X AND Y'], ['X', 'X ONLY'], ['Y', 'Y ONLY']]} /></div>
    <div class="fs-prow">
      <UnitField label="Size in X, about" value={c.workpieceSizeX} unit="mm" step={1} min={0} set={v => set({ workpieceSizeX: v })} />
      <UnitField label="Size in Y, about" value={c.workpieceSizeY} unit="mm" step={1} min={0} set={v => set({ workpieceSizeY: v })} />
    </div>
    <div class="fs-prow">
      <UnitField label="Probe this far below the start" value={c.depth} unit="mm" step={0.5} min={0} set={v => set({ depth: v })} />
      <UnitField label="Times round" value={c.passes} unit="×" step={1} min={1} set={v => set({ passes: Math.max(1, Math.round(v)) })} />
    </div>
    <TargetBlock sig={pr.centreTarget} what={c.axes === 'XY' ? 'X and Y' : c.axes} />
    <ProbeLine />
  </>;
}

function RotationWhat() {
  const c = pr.rotationConfig.value;
  const file = job.file.value;
  return <>
    <Picker kind="rot" />
    <div class="fs-pk-cap"><span class="nm">{pickName(c.edge, false)}</span><span class="ds">two points along it give the angle · was “{c.edge}”</span></div>
    <div class="fs-prow">
      <UnitField label="Second point this far along" value={c.offset} unit="mm" step={5} min={1} set={v => pr.update('rot', pr.rotationConfig, { offset: v })} />
      <UnitField label="Probe this far below the start" value={c.depth} unit="mm" step={0.5} min={0} set={v => pr.update('rot', pr.rotationConfig, { depth: v })} />
    </div>
    <div class="fs-psect"><div class="fs-cap">RESULT</div>
      <div class="fs-note">The angle shows in column 3. <b>APPLY ROTATION</b> then turns {file ? <b>{file}</b> : 'the loaded program'} about X0 Y0 by that angle, once. No work offset is written.{job.lines.value.length ? '' : ' No program is loaded.'}</div>
    </div>
    <ProbeLine />
  </>;
}

function ToolWhat() {
  const c = pr.toolLengthConfig.value;
  const set = (p: Partial<pr.ToolLengthConfig>) => pr.update('tl', pr.toolLengthConfig, p);
  const tlo = machine.tlo.value, tool = machine.tool.value;
  const linked = connection.connected.value, busy = !!pr.running.value;
  const when = (at: number) => new Date(at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const T = (n: number | null | undefined) => n !== null && n !== undefined ? 'T' + n : 'the reference tool';
  // A reference belongs to the surface it was measured on; the other surface's, or one from before
  // references were kept per surface, doesn't apply here and is said so.
  const here = pr.SURFACE_NAME[c.mode], otherMode = c.mode === 'touchplate' ? 'toolsetter' : 'touchplate';
  const ref = pr.referenceFor(c), other = c.refs?.[otherMode] ?? null;
  return <>
    <Tiles label="Measure on" value={c.mode} set={v => set({ mode: v })} opts={[['touchplate', 'plate', 'ON A TOUCH PLATE'], ['toolsetter', 'setter', 'ON THE TOOLSETTER']]} />
    <div class="fs-prow">
      {c.mode === 'touchplate' ? <>
        <UnitField label="Plate thickness" value={c.touchPlateHeight} unit="mm" step={0.1} min={0} set={v => set({ touchPlateHeight: v })} />
        <UnitField label="Search down up to" value={c.probeDistance} unit="mm" step={1} min={1} set={v => set({ probeDistance: v })} />
      </> : <UnitField label="Stop this far above the toolsetter" value={c.toolsetterDepth} unit="mm" step={1} min={1} set={v => set({ toolsetterDepth: v })} />}
    </div>
    <div class="fs-psect"><div class="fs-cap">REFERENCE TOOL</div>
      <div class="fs-note">{ref
        ? <><b>{T(ref.tool)}, touched at machine Z <span class="fs-mono">{f3(ref.z)}</span> on the {here}</b>, {when(ref.at)}. Later tools measured on the {here} are measured against it.</>
        : <><b>Not set on the {here}.</b> Measure the reference tool on the {here} first. Every later tool is measured against it, and the difference becomes its tool length offset.</>}</div>
      {!ref && other && <div class="fs-note is-warn">The {pr.SURFACE_NAME[otherMode]}'s reference ({T(other.tool)}, Z {f3(other.z)}) doesn't apply on the {here}: a touch on one isn't comparable with a touch on the other.</div>}
      {!ref && c.tloReference !== null && <div class="fs-note is-warn">A reference kept from before ({T(c.refTool)}, Z {f3(c.tloReference)}) doesn't say whether it was on the plate or the toolsetter, so it isn't used. Measure it again.</div>}
      <div class="fs-row-gap">
        <button type="button" class="fs-btn" disabled={!linked || busy} title={`Probe this tool on the ${here} as the reference the others are measured from`} onClick={() => probeNow('tl', true)}>MEASURE AS REFERENCE</button>
        {(ref || c.tloReference !== null) && <button type="button" class="fs-btn" title={`Forget the ${here}'s reference and cancel the tool length offset (G49)`} onClick={() => pr.clearReference()}>CLEAR</button>}
      </div>
    </div>
    <div class="fs-psect"><div class="fs-cap">TOOL LENGTH OFFSET NOW</div>
      <div class="fs-mono fs-ptlo">{tlo === null ? 'not read' : f3(tlo)} <span class="fs-dim">mm{tool !== null ? ` · T${tool} in the spindle` : ''}</span></div>
      <div class="fs-note">At a tool change in a job, the job screen's MEASURE has the controller measure the tool itself ($TPW).</div>
    </div>
    <ProbeLine toolLength />
  </>;
}

function What({ tab }: { tab: Routine }) {
  return tab === 'tl' ? <ToolWhat /> : tab === 'ef' ? <EdgeWhat /> : tab === 'cf' ? <CentreWhat /> : <RotationWhat />;
}

// ── Column 2: where it starts, and what it does ───────────────────────────────

let viewIds = 0;

function View({ v, m, s }: { v: 'xy' | 'xz'; m: Plan; s: ViewState }) {
  const [ref, size] = useSize<HTMLDivElement>();
  const id = useRef('pv' + ++viewIds).current;
  return (
    <div class="fs-vbox" ref={ref}>
      <svg role="img" aria-label={v === 'xy' ? 'From above' : 'From the front'} viewBox={`0 0 ${size.w || 1} ${size.h || 1}`}
        dangerouslySetInnerHTML={{ __html: viewSvg(size.w, size.h, v, m, s, id) }} />
      <span class="fs-vlab">{v === 'xy' ? 'FROM ABOVE' : 'FROM THE FRONT'}</span>
    </div>
  );
}

function Where({ tab, plan }: { tab: Routine; plan: Plan | null }) {
  const run = pr.runs.value[tab];
  const runningHere = pr.running.value === tab;
  // A run on show follows its own plan: under way, or ended in a miss or a cancel, until the preview is stepped.
  const follow = !!run?.plan && run.start && (runningHere || ((run.phase === 'fail' || run.phase === 'cancelled') && !pvFree.value[tab]));
  const m = follow ? run!.plan! : plan;
  if (!m) return <div class="fs-where">…</div>;
  const n = m.wps.length;
  const cur = follow ? Math.min(run!.step, n - 1) : Math.min(pvStep.value[tab], Math.max(n - 1, 0));
  let at = null;
  if (follow && n) {
    const p = machine.mpos.value, s0 = run!.start!, w0 = m.wps[0];
    at = { x: w0.x + p.x - s0.x, y: w0.y + p.y - s0.y, z: w0.z + p.z - s0.z };
  }
  const ok = run?.phase === 'ok';
  const s: ViewState = { cur, live: !!follow || ok, showRes: !follow, at, tip: ps.probe.value.tip, angle: tab === 'rot' && ok ? pr.measuredAngle.value ?? lastAngle(run) : null };
  const w = m.wps[cur], w0 = m.wps[0];
  const busy = !!pr.running.value;
  return <>
    <div class="fs-where">{m.where}<small>{m.sub}</small>{m.warn && <small class="is-warn">{m.warn}</small>}</div>
    {n > 0 && <div class={'fs-views' + (m.views.length === 1 ? ' is-one' : '')}>
      {m.views.map(v => <View v={v} m={m} s={s} />)}
    </div>}
    {n > 0 && <div class="fs-play">
      <button type="button" class="fs-btn fs-btn-sm" aria-label="Previous move" disabled={busy || cur <= 0} onClick={() => { stopPlay(); setStep(tab, cur - 1); }}>◀</button>
      <button type="button" class="fs-btn fs-btn-sm" aria-label={pvPlaying.value === tab ? 'Pause' : 'Play the moves'} disabled={busy} onClick={() => play(tab, n)}>{pvPlaying.value === tab ? '❚❚' : '▶'}</button>
      <button type="button" class="fs-btn fs-btn-sm" aria-label="Next move" disabled={busy || cur >= n - 1} onClick={() => { stopPlay(); setStep(tab, cur + 1); }}>▶|</button>
      <span class="fs-pstep">{cur + 1} / {n} · {follow && run ? run.label : w.label}</span>
      <span class="fs-mono fs-dim fs-pxyz" title="This step's position, mm from where the probe starts">X {f3(w.x - w0.x)} Y {f3(w.y - w0.y)} Z {f3(w.z - w0.z)}</span>
      <button type="button" class="fs-btn fs-btn-sm" title="Draw these moves in the job screen's 3D view" onClick={() => pr.showInJobPreview(m)}>3D VIEW</button>
    </div>}
    {n > 0 && <div class="fs-plegend" aria-label="Key">
      <span><i class="is-rapid" />Rapid</span><span><i class="is-probe" />Probe move</span><span><i class="is-touch" />Touch</span>
      <span><i class="is-start" />Start</span><span><i class="is-zero" />New zero</span>
    </div>}
  </>;
}

/** Rotation's angle from its result line, once APPLY has cleared the one to apply. */
function lastAngle(run: pr.Run | undefined): number | null {
  const v = run?.lines.find(l => l.k === 'ANGLE')?.v;
  return v ? parseFloat(v) : null;
}

// Column 3: the probe light, the jog pad, then the status, the result and the buttons

function ProbeLight({ tab }: { tab: Routine }) {
  const linked = connection.connected.value;
  const hit = linked && machine.pins.value.includes('P');
  const what = tab === 'tl' && pr.toolLengthConfig.value.mode === 'touchplate' ? 'plate on the tool' : 'stylus';
  return (
    <div class={'fs-plamp' + (hit ? ' is-hit' : '')} role="status">
      <span class="fs-lamp" /><span class="w">PROBE {!linked ? '—' : hit ? 'TOUCHING' : 'OPEN'}</span>
      <span>{!linked ? 'Not connected: this follows the controller\'s probe input.' : hit ? 'Contact.' : `Tap the ${what}: this lights when the probe triggers.`}</span>
    </div>
  );
}

const PAD: [string, string][] = [['X-Y+', '↖'], ['Y+', 'Y+'], ['X+Y+', '↗'], ['Z+', 'Z+'], ['X-', 'X−'], ['STOP', 'STOP'], ['X+', 'X+'], ['Z-', 'Z−'], ['X-Y-', '↙'], ['Y-', 'Y−'], ['X+Y-', '↘'], ['XY0', 'XY0']];

/** The jog pad, compact: no feed slider here (the owner, 3 Nov), the feed as a number. */
function ProbeJog() {
  const hold = jog.holdMode.value, linked = connection.connected.value;
  const busy = !!pr.running.value;
  const maxF = Math.max(jog.maxXY.value, jog.maxZ.value);
  return (
    <div class={'fs-pjog' + (busy ? ' is-off' : '')} aria-label="Jog">
      <div class="fs-pjog-head"><span class="fs-cap">JOG</span>
        <div role="group" aria-label="Jog mode" class="fs-seg fs-seg-sm" title="Click: one step per tap. Hold: jogs while held, stops on release">
          <button type="button" class={!hold ? 'is-on' : ''} aria-pressed={!hold ? 'true' : 'false'} onClick={() => jog.setHoldMode(false)}>CLICK</button>
          <button type="button" class={hold ? 'is-on' : ''} aria-pressed={hold ? 'true' : 'false'} onClick={() => jog.setHoldMode(true)}>HOLD</button>
        </div>
      </div>
      <div class="fs-pjgrid">
        {PAD.map(([d, t]) => d === 'STOP' ? <button type="button" class="fs-jog is-stop" disabled={!linked} onClick={() => jog.stopJog()}>STOP</button>
          : d === 'XY0' ? <button type="button" class="fs-jog" disabled={!linked} title="Rapid to X0 Y0 in the active work offset" onClick={() => jog.goToXY0()}>XY0</button>
          : <JogButton dir={d} label={t} />)}
      </div>
      <Steps label="XY" steps={jog.stepsXY.value} value={jog.stepXY.value} set={v => { jog.stepXY.value = v; }} />
      <Steps label="Z" steps={jog.stepsZ.value} value={jog.stepZ.value} set={v => { jog.stepZ.value = v; }} />
      <div class="fs-pjog-feed"><span class="fs-cap">FEED</span>
        <span class="fs-pin"><NumIn value={jog.feed.value} min={1} max={maxF} label="Jog feed, mm/min" set={v => { jog.feed.value = Math.max(1, Math.round(v)); }} /><i>mm/min</i></span>
      </div>
      {busy && <div class="fs-note">The routine is moving the machine. Jog again once it ends or after CANCEL.</div>}
    </div>
  );
}

function RunFoot({ tab }: { tab: Routine }) {
  const linked = connection.connected.value;
  const busy = pr.running.value;
  const run = pr.runs.value[tab];
  let tone = '', text: string;
  if (busy && busy !== tab) { tone = 'run'; text = `${TAB_NAME[busy]} is probing. CANCEL stops it from here.`; }
  else if (run?.phase === 'running') { tone = 'run'; text = run.text || `Probing the ${pr.measuring(tab)}: ${run.label.toLowerCase()}.`; }
  else if (run) { tone = run.phase === 'ok' ? 'ok' : run.phase === 'fail' ? 'err' : run.phase === 'held' ? 'warn' : ''; text = run.text; }
  else text = pr.readyText(tab);
  const lines = run?.phase === 'ok' && (!busy || busy === tab) ? run.lines : [];
  const canApply = tab === 'rot' && pr.measuredAngle.value !== null && job.lines.value.length > 0;
  return <>
    <div class={'fs-pstatus2' + (tone ? ' is-' + tone : '')} role="status">{text}</div>
    {lines.length > 0 && <div class="fs-pres fs-mono">
      {lines.map(l => <div><span class="k">{l.k}</span>{l.v}{l.old && <span class="old">{l.v ? ' ' : ''}{l.old}</span>}</div>)}
    </div>}
    <div class="fs-prunb">
      <button type="button" class="fs-pgo" disabled={!linked || !!busy} onClick={() => probeNow(tab)}>PROBE</button>
      {tab === 'rot' && <button type="button" class="fs-pap" disabled={!canApply}
        title={pr.measuredAngle.value === null ? 'Measure first' : `Turn the program by ${pr.measuredAngle.value.toFixed(3)}°`} onClick={() => pr.applyRotation()}>APPLY ROTATION</button>}
      <button type="button" class={'fs-pcx' + (busy && !pr.finishing.value ? ' is-live' : '')} disabled={!busy || pr.finishing.value}
        title={pr.finishing.value ? 'The moves are done and the result is being written: nothing is left to cancel' : 'Stop the routine and the move in progress'} onClick={() => pr.cancel()}>CANCEL</button>
    </div>
  </>;
}

// The screen and the popups

function ProbingTabs() {
  const tab = ui.probingTab.value;
  return (
    <div role="tablist" aria-label="What to measure" class="fs-subtabs">
      {PROBING_TABS.map(([id, label]) => (
        <button type="button" role="tab" aria-selected={tab === id ? 'true' : 'false'} class={tab === id ? 'is-on' : ''}
          onClick={() => { stopPlay(); ui.probingTab.value = id; }}>{label}{pr.running.value === id && <span class="fs-pdot" aria-label="running"> ●</span>}</button>
      ))}
    </div>
  );
}

function Col({ n, title, class: cls, foot, children }: { n: number; title: string; class: string; foot?: ComponentChildren; children: ComponentChildren }) {
  return (
    <section class={'fs-pbcol ' + cls} aria-label={title}>
      <div class="fs-pbhead"><span class="n">{n}</span><span class="t">{title}</span></div>
      <div class="fs-pbbody">{children}</div>
      {foot && <div class="fs-pbfoot">{foot}</div>}
    </section>
  );
}

function SettingsPopup() {
  useEffect(() => {
    // Escape closes this one only, not the job screen's popup under it.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); settingsOpen.value = false; } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  return (
    <div class="fs-popup-back fs-pset-back" onClick={e => { if (e.target === e.currentTarget) settingsOpen.value = false; }}>
      <section role="dialog" aria-label="Settings, Probe" class="fs-popup">
        <div class="fs-popup-head">
          <h2 class="fs-h">SETTINGS · PROBE</h2>
          <button type="button" class="fs-btn fs-btn-sm" onClick={() => { settingsOpen.value = false; }}>CLOSE</button>
        </div>
        <div class="fs-popup-cards"><ProbeSettingsCard /></div>
      </section>
    </div>
  );
}

function Columns() {
  const tab = ui.probingTab.value;
  const plan = plans.value[tab] ?? null;
  return (
    <div class="fs-pb">
      <Col n={1} title="WHAT TO MEASURE" class="fs-pb1"><What tab={tab} /></Col>
      <Col n={2} title="WHERE IT STARTS · WHAT IT DOES" class="fs-pb2"><Where tab={tab} plan={plan} /></Col>
      <Col n={3} title="POSITION AND PROBE" class="fs-pb3" foot={<RunFoot tab={tab} />}><ProbeLight tab={tab} /><ProbeJog /></Col>
      {settingsOpen.value && <SettingsPopup />}
    </div>
  );
}

export function ProbingScreen() {
  if (ui.screen.value !== 'probing') return null;
  return (
    <section class="fs-screen">
      <ProbingTabs />
      <Columns />
    </section>
  );
}

/** The job screen's probe and measure popups: the same columns, the jog pad with them (the owner, 3 Nov). */
export function ProbingPopupBody() {
  return (
    <div class="fs-probe-popup">
      <ProbingTabs />
      <Columns />
    </div>
  );
}

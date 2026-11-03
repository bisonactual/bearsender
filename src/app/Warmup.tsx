// ═══════════════════════════════════════════════
// The machine warmup: the Setup screen's Spindle warmup tab, the job screen's progress strip while it
// runs, and the bottom bar's MACHINE WARMUP button, held for 5 s to start it (src/warmup.ts runs it).
// ═══════════════════════════════════════════════

import { useEffect, useRef, useState } from 'preact/hooks';
import type { Signal } from '@preact/signals';
import * as connection from '../stores/connection';
import * as machine from '../stores/machine';
import * as job from '../stores/job';
import * as wu from '../warmup';
import { Card, NumIn, Columns, width } from './SetupScreen';
import { Seg } from './ProbingScreen';

const num = (v: number) => v.toLocaleString('en-GB', { maximumFractionDigits: 3 });
/** About how long: "about 6 min", "about 40 s". */
const about = (secs: number) => 'about ' + (secs >= 90 ? Math.round(secs / 60) + ' min' : Math.round(secs) + ' s');
const patternName = (p: wu.Pattern) => wu.PATTERNS.find(([v]) => v === p)?.[1] ?? p;

/** A machine setting as a number, or null before it has been read. */
function setting(k: number): number | null {
  const v = parseFloat(machine.settings.value[k] ?? '');
  return Number.isFinite(v) ? v : null;
}

// ── The Setup tab ─────────────────────────────────────────────────────────────

function SummaryCard() {
  const isCold = wu.fromCold.value;
  const p = wu.progress.value;
  const m = wu.motion.value;
  return (
    <Card title="MACHINE WARMUP">
      <div class="fs-inline">
        <span class="fs-cap">RUNS</span>
        <Seg label="Which routine MACHINE WARMUP runs" value={isCold ? 'cold' : 'normal'} set={v => { wu.fromCold.value = v === 'cold'; }}
          opts={[['normal', 'NORMAL'], ['cold', 'FROM COLD']]} />
      </div>
      <div class="fs-note-sm">Turn on From cold when the machine hasn't run for a while, more than 3 days say.</div>
      <div class="fs-warm-est">
        <div><span class="fs-cap">NORMAL</span> <span class="fs-mono">{about(wu.estimate(wu.normal.value, m))}</span></div>
        <div><span class="fs-cap">FROM COLD</span> <span class="fs-mono">{about(wu.estimate(wu.cold.value, m))}</span></div>
      </div>
      {p
        ? <div class="fs-pstatus is-run">{progressText(p)}</div>
        : <div class="fs-note-sm">Hold <strong>MACHINE WARMUP</strong>, left of Start, for 5 seconds to run it. Hold and Stop act on it as on a job; Stop stops the spindle.</div>}
    </Card>
  );
}

function RoutineCard({ which }: { which: 'normal' | 'cold' }) {
  const sig: Signal<wu.Routine> = which === 'cold' ? wu.cold : wu.normal;
  const r = sig.value;
  const set = (patch: Partial<wu.Routine>) => { sig.value = { ...sig.value, ...patch }; };
  const sp = wu.speeds(r);
  const max = setting(30);
  const over = max !== null && max > 0 && sp.some(s => s > max);
  const on = wu.fromCold.value === (which === 'cold');
  const each = r.minutes === 1 ? '1 min' : num(r.minutes) + ' min';
  return (
    <Card title={which === 'cold' ? 'FROM COLD' : 'NORMAL'} class={on ? 'is-picked' : ''}
      end={on ? <span class="fs-warm-tag">THE BUTTON RUNS THIS</span> : undefined}>
      <div class="fs-fields">
        <label class="fs-field"><span>Starting speed, rpm</span>
          <NumIn value={r.start} min={0} step={500} label="Starting speed, rpm" set={v => set({ start: Math.max(0, Math.round(v)) })} /></label>
        <label class="fs-field"><span>Target max speed, rpm</span>
          <NumIn value={r.max} min={0} step={500} label="Target max speed, rpm" set={v => set({ max: Math.max(0, Math.round(v)) })} /></label>
        <label class="fs-field"><span>Interval steps</span>
          <NumIn value={r.steps} min={1} max={20} step={1} label="Interval steps" set={v => set({ steps: Math.min(20, Math.max(1, Math.round(v))) })} /></label>
        <label class="fs-field"><span>Duration per step, min</span>
          <NumIn value={r.minutes} min={0.05} step={0.5} label="Duration per step, min" set={v => set({ minutes: Math.max(0.05, v) })} /></label>
      </div>
      <div class="fs-note">{sp.map(num).join(' · ')} rpm, {each} each: {about(wu.estimate(r, wu.motion.value))} in all.</div>
      {over && <div class="fs-note is-warn">Over the controller's maximum spindle speed ($30 = {num(max!)} rpm): it runs those steps at {num(max!)}.</div>}
    </Card>
  );
}

function MotionCard() {
  const m = wu.motion.value;
  const p = wu.point.value;
  const set = (patch: Partial<wu.Motion>) => { wu.motion.value = { ...wu.motion.value, ...patch }; };
  const moves = m.pattern !== 'none';
  const usesX = m.pattern !== 'none' && m.pattern !== 'y';
  const usesY = m.pattern !== 'none' && m.pattern !== 'x';
  const each = wu.passSecs(m);
  // Machine travel as the frame check takes it: from 0 down to −$130 (X) and −$131 (Y).
  const tx = setting(130), ty = setting(131);
  const past: string[] = [];
  if (usesX && tx !== null && p.x - m.xRange < -tx) past.push(`X to machine ${num(p.x - m.xRange)}, past the X travel ($130 = ${num(tx)} mm)`);
  if (usesY && ty !== null && p.y - m.yRange < -ty) past.push(`Y to machine ${num(p.y - m.yRange)}, past the Y travel ($131 = ${num(ty)} mm)`);
  return (
    <Card title="MOTION ROUTINE">
      <label class="fs-field"><span>Exercise pattern</span>
        <select class="fs-in" aria-label="Exercise pattern" value={m.pattern} onChange={e => set({ pattern: (e.target as HTMLSelectElement).value as wu.Pattern })}>
          {wu.PATTERNS.map(([v, t]) => <option value={v}>{t}</option>)}
        </select>
      </label>
      <div class="fs-fields">
        <label class="fs-field"><span>X range, mm</span>
          <NumIn value={m.xRange} min={0} step={10} label="X range, mm" set={v => set({ xRange: Math.max(0, v) })} /></label>
        <label class="fs-field"><span>Y range, mm</span>
          <NumIn value={m.yRange} min={0} step={10} label="Y range, mm" set={v => set({ yRange: Math.max(0, v) })} /></label>
        <label class="fs-field"><span>Feed, mm/min</span>
          <NumIn value={m.feed} min={1} step={100} label="Feed, mm/min" set={v => set({ feed: Math.max(1, Math.round(v)) })} /></label>
      </div>
      <div class="fs-note">{moves
        ? <>From the start point toward −X and −Y, and back to it. One pass is {about(each)}; each step runs whole passes for its time, then dwells what is left. Acceleration isn't counted.</>
        : <>The spindle runs at the start point; nothing moves.</>}</div>
      {past.length > 0 && <div class="fs-note is-warn">The pattern takes {past.join(', and ')}.</div>}
    </Card>
  );
}

function StartPointCard() {
  const p = wu.point.value;
  const set = (patch: Partial<wu.Point>) => { wu.point.value = { ...wu.point.value, ...patch }; };
  const linked = connection.connected.value;
  return (
    <Card title="START POINT" end={
      <button type="button" class="fs-btn fs-btn-xs" disabled={!linked} title="Take the machine position now"
        onClick={() => { const m = machine.mpos.peek(); set({ x: m.x, y: m.y, z: m.z }); }}>USE CURRENT POSITION</button>
    }>
      <div class="fs-fields">
        {(['x', 'y', 'z'] as const).map(a => (
          <label class="fs-field"><span>Machine {a.toUpperCase()}, mm</span>
            <NumIn value={p[a]} step={1} label={'Start point, machine ' + a.toUpperCase()} set={v => set({ [a]: v })} /></label>
        ))}
      </div>
      <div class="fs-note">Machine coordinates (G53). The way there: Z goes up first, to the higher of this Z and where the tool is, and never down while crossing; then over to X and Y; then to this Z. The spindle starts there.</div>
    </Card>
  );
}

export function WarmupCards() {
  return <Columns cols={width.value >= 1000
    ? [[SummaryCard, StartPointCard], [() => <RoutineCard which="normal" />, () => <RoutineCard which="cold" />], [MotionCard]]
    : [[SummaryCard, () => <RoutineCard which="normal" />, () => <RoutineCard which="cold" />], [MotionCard, StartPointCard]]} />;
}

// ── Progress ──────────────────────────────────────────────────────────────────

function progressText(p: wu.Progress): string {
  const routine = p.cold ? 'From cold' : 'Normal';
  if (p.step < 0) return routine + ': going to the start point';
  return `${routine}: step ${p.step + 1} of ${p.steps.length} at ${num(p.steps[p.step].rpm)} rpm${p.held ? ', held' : ''}, ${job.fmtDuration(p.leftMs)} left`;
}

/** In place of the Current Job strip while the warmup runs. */
export function WarmupStrip() {
  const p = wu.progress.value;
  if (!p) return null;
  const pct = p.totalMs ? Math.min(100, (p.totalMs - p.leftMs) / p.totalMs * 100) : 0;
  return (
    <section aria-labelledby="fs-warm" class="fs-card fs-current">
      <div class="fs-current-name">
        <h2 id="fs-warm" class="fs-h">MACHINE WARMUP</h2>
        <div class="fs-file">{p.cold ? 'From cold' : 'Normal'} · {patternName(p.pattern)}</div>
        <div class="fs-now">{p.step < 0 ? 'Going to the start point' : `Step ${p.step + 1} of ${p.steps.length} · ${num(p.steps[p.step].rpm)} rpm`}{p.held ? ' · held' : ''}</div>
      </div>
      <div class="fs-current-bar">
        <div class="fs-bar">
          <div class="fs-bar-sections">
            {p.steps.map((s, k) => (
              <div class={k === p.step ? 'is-now' : ''} style={{ flex: Math.max(1, Math.round(s.secs)) + ' 1 0', background: k <= p.step ? '#29403e' : '#2a271e' }}
                title={num(s.rpm) + ' rpm, ' + job.fmtDuration(s.secs * 1000)}>{num(s.rpm)}</div>
            ))}
          </div>
          <div class="fs-bar-done" style={{ width: pct.toFixed(1) + '%' }} />
        </div>
        <div class="fs-note">Progress by time, from the step times in Setup, Spindle warmup. Hold and Stop act on it; Stop stops the spindle.</div>
      </div>
      <div class="fs-times">
        <div><div class="fs-cap">ELAPSED</div><div class="fs-time">{job.fmtDuration(p.elapsedMs)}</div></div>
        <div><div class="fs-cap">LEFT, EST.</div><div class="fs-time is-dim">~{job.fmtDuration(p.leftMs)}</div></div>
        <div><div class="fs-cap">SPINDLE</div><div class="fs-time is-dim">{num(machine.spindle.value)}</div></div>
      </div>
    </section>
  );
}

// ── The button ────────────────────────────────────────────────────────────────

const HOLD_MS = 5000;

/** MACHINE WARMUP: held for 5 s it starts the warmup; let go sooner, nothing happens. The hold lasts only
 *  while the press does: letting go, the button losing focus, the window losing focus or the page being
 *  hidden all end it (a key let go elsewhere never reaches the button). */
export function WarmupButton() {
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false);
  const why = wu.whyNot();
  const isCold = wu.fromCold.value;
  const release = () => {
    held.current = false;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    setHolding(false);
  };
  const press = () => {
    if (why || timer.current) return;
    held.current = true;
    setHolding(true);
    timer.current = setTimeout(() => { timer.current = null; setHolding(false); if (held.current) { held.current = false; wu.start(); } }, HOLD_MS);
  };
  useEffect(() => release, []);
  // A reason coming up while it's held (a job started, the link dropped) lets go of it.
  useEffect(() => { if (why) release(); }, [why]);
  // The window losing focus or the page hidden while held lets go of it too.
  useEffect(() => {
    if (!holding) return;
    const hidden = () => { if (document.hidden) release(); };
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', hidden);
    return () => { window.removeEventListener('blur', release); document.removeEventListener('visibilitychange', hidden); };
  }, [holding]);
  const sub = why ? why.toUpperCase() : isCold ? '· COLD' : '· NORMAL';
  return (
    <button type="button" class={'fs-run-btn is-warmup' + (holding ? ' is-holding' : '')} disabled={!!why}
      aria-label={'Machine warmup, ' + (isCold ? 'from cold' : 'normal') + (why ? ': ' + why : '. Hold for 5 seconds to activate')}
      title={why ? 'Machine warmup: ' + why : 'Hold for 5 seconds to run the ' + (isCold ? 'from-cold' : 'normal') + ' warmup'}
      onPointerDown={e => { e.preventDefault(); try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch (_) {} press(); }}
      onPointerUp={release} onPointerCancel={release} onLostPointerCapture={release}
      onKeyDown={e => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); press(); } }}
      onKeyUp={e => { if (e.key === ' ' || e.key === 'Enter') release(); }}
      onBlur={release}
      onContextMenu={e => e.preventDefault()}>
      <span class="fs-warm-fill" aria-hidden="true" />
      {holding
        ? <span class="fs-warm-text is-hint">Hold for 5 seconds to activate</span>
        : <span class="fs-warm-text">MACHINE WARMUP<small>{sub}</small></span>}
    </button>
  );
}

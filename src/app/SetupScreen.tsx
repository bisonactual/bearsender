// ═══════════════════════════════════════════════
// The Setup screen: the machine's cards (position, jogging, spindle, overrides, program limits, surfacing,
// SD card) and the work offsets table. The jog, offsets and frame popups show the same cards.
// ═══════════════════════════════════════════════

import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import * as connection from '../stores/connection';
import * as machine from '../stores/machine';
import * as job from '../stores/job';
import * as ui from './ui';
import * as jog from '../jog';
import * as frame from '../frame';
import * as sd from '../sd';
import * as surfacing from '../surfacing';
import { sendCmd, rtSend } from '../connection';
import { setWCS } from '../streaming';
import { processGcode } from '../gcode';
import { log } from '../console';
import { loadOffsets, writeOffset, zeroOffset, setToCurrentPos, cancelTlo, WCS_ENTRIES } from '../offsets';
import { fmtBytes } from '../ui';

const fix3 = (v: number) => v.toFixed(3);
const num = (v: number) => v.toLocaleString('en-GB');
const WCS6 = ['G54', 'G55', 'G56', 'G57', 'G58', 'G59'];

export function Card({ title, end, class: cls, children }: { title: string; end?: ComponentChildren; class?: string; children: ComponentChildren }) {
  return (
    <section class={'fs-card fs-mcard' + (cls ? ' ' + cls : '')} aria-label={title}>
      <div class="fs-card-head"><h2 class="fs-h">{title}</h2>{end && <div class="fs-head-end">{end}</div>}</div>
      {children}
    </section>
  );
}

/** A number field that takes the value on Enter or leaving it, so typing "0." isn't rewritten as it goes. */
function NumIn({ value, set, step, min, max, label, wide }: { value: number; set: (v: number) => void; step?: number; min?: number; max?: number; label: string; wide?: boolean }) {
  return (
    <input type="number" class={'fs-in' + (wide ? ' is-wide' : '')} aria-label={label} value={String(value)} step={step} min={min} max={max}
      onChange={e => { const v = parseFloat((e.target as HTMLInputElement).value); if (Number.isFinite(v)) set(v); else (e.target as HTMLInputElement).value = String(value); }} />
  );
}

// ── Position ──────────────────────────────────────────────────────────────────

function stateTone(sl: string): string {
  if (sl === 'run' || sl === 'jog' || sl === 'home') return ' is-go';
  if (sl === 'alarm') return ' is-stop';
  if (sl === 'hold' || sl === 'door' || sl === 'tool') return ' is-warn';
  return '';
}

export function PositionCard() {
  const linked = connection.connected.value;
  const sl = machine.stateName.value;
  const w = machine.wpos.value, m = machine.mpos.value;
  const wcs = machine.wcs.value;
  const buf = machine.buffer.value;
  const ln = job.reportedLine.value;
  return (
    <Card title="POSITION" end={
      <label class="fs-inline">
        <span class="fs-cap">WCS</span>
        <select class="fs-in" value={WCS6.includes(wcs) ? wcs : ''} disabled={!linked} onChange={e => setWCS((e.target as HTMLSelectElement).value)}>
          {!WCS6.includes(wcs) && <option value="">{wcs}</option>}
          {WCS6.map(c => <option value={c}>{c}</option>)}
        </select>
      </label>
    }>
      <div class={'fs-badge' + stateTone(sl)}>{linked ? (machine.state.value || 'NO REPORT YET').toUpperCase() : 'OFFLINE'}</div>
      <div class="fs-dro">
        {(['x', 'y', 'z'] as const).map(a => (
          <div class="fs-dro-row">
            <span class="fs-axis-name">{a.toUpperCase()}</span>
            <span class="fs-dro-w fs-mono">{fix3(w[a])}</span>
            <span class="fs-dro-m fs-mono" title="Machine position">M {fix3(m[a])}</span>
            <span class="fs-unit">MM</span>
            <button type="button" class="fs-btn fs-btn-xs" disabled={!linked} title={`Zero ${a.toUpperCase()} in ${wcs} here (G10 L20)`}
              onClick={() => sendCmd('G10 L20 P' + machine.activeP.value + ' ' + a.toUpperCase() + '0')}>ZERO</button>
          </div>
        ))}
      </div>
      <div class="fs-minis">
        <div><div class="fs-cap">FEED</div><div class="fs-mono">{num(machine.feed.value)} <span class="fs-unit">mm/min</span></div></div>
        <div><div class="fs-cap">SPINDLE</div><div class="fs-mono">{num(machine.spindle.value)} <span class="fs-unit">rpm</span></div></div>
        <div title="Planner blocks and input bytes free"><div class="fs-cap">BUFFER</div><div class="fs-mono">{buf ? `${buf.blocks} blk / ${buf.bytes} B` : '—'}</div></div>
        <div title="Line number from the status report"><div class="fs-cap">LINE</div><div class="fs-mono">{ln ? num(ln) : '—'}</div></div>
      </div>
    </Card>
  );
}

// ── Jogging ───────────────────────────────────────────────────────────────────

function JogButton({ dir, label, class: cls }: { dir: string; label: string; class?: string }) {
  const v = jog.dirVec(dir);
  const axis = v.z ? 'is-z' : v.x && v.y ? 'is-diag' : v.x ? 'is-x' : 'is-y';
  const lit = jog.keyDir.value === dir;
  return (
    <button type="button" class={`fs-jog ${axis}${cls ? ' ' + cls : ''}${lit ? ' is-lit' : ''}`} disabled={!connection.connected.value}
      aria-label={'Jog ' + dir}
      onMouseEnter={() => jog.showJogPreview(dir)}
      onMouseLeave={() => { jog.clearHoverPreview(); jog.releaseJog(); }}
      onPointerDown={e => { if (jog.holdMode.value) { e.preventDefault(); jog.pressJog(dir); } }}
      onPointerUp={() => jog.releaseJog()}
      onPointerCancel={() => jog.releaseJog()}
      onClick={() => jog.clickJog(dir)}>{label}</button>
  );
}

function Steps({ label, steps, value, set }: { label: string; steps: number[]; value: number; set: (v: number) => void }) {
  return (
    <div class="fs-steps">
      <span class="fs-cap">{label}</span>
      <div role="group" aria-label={label + ' step'} class="fs-seg fs-seg-sm">
        {steps.map(s => (
          <button type="button" class={s === value ? 'is-on' : ''} aria-pressed={s === value ? 'true' : 'false'} onClick={() => set(s)}>
            {s}<span class="fs-step-unit">mm</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function JogCard() {
  const hold = jog.holdMode.value;
  const linked = connection.connected.value;
  const maxF = Math.max(jog.maxXY.value, jog.maxZ.value);
  return (
    <Card title="JOGGING" end={
      <div role="group" aria-label="Jog mode" class="fs-seg fs-seg-sm" title="Click: one step per tap. Hold: jogs while held, stops on release">
        <button type="button" class={!hold ? 'is-on' : ''} aria-pressed={!hold ? 'true' : 'false'} onClick={() => jog.setHoldMode(false)}>CLICK</button>
        <button type="button" class={hold ? 'is-on' : ''} aria-pressed={hold ? 'true' : 'false'} onClick={() => jog.setHoldMode(true)}>HOLD</button>
      </div>
    }>
      <div class="fs-jog-row">
        <div class="fs-jog-pad">
          <JogButton dir="X-Y+" label="↖" />
          <JogButton dir="Y+" label="Y+" />
          <JogButton dir="X+Y+" label="↗" />
          <JogButton dir="X-" label="X−" />
          <button type="button" class="fs-jog is-stop" disabled={!linked} onClick={() => jog.stopJog()}>STOP</button>
          <JogButton dir="X+" label="X+" />
          <JogButton dir="X-Y-" label="↙" />
          <JogButton dir="Y-" label="Y−" />
          <JogButton dir="X+Y-" label="↘" />
        </div>
        <div class="fs-jog-z">
          <JogButton dir="Z+" label="Z+" />
          <JogButton dir="Z-" label="Z−" />
          <button type="button" class="fs-jog" disabled={!linked} title="Rapid to X0 Y0 in the active work offset" onClick={() => jog.goToXY0()}>XY0</button>
        </div>
      </div>
      <div class="fs-feedrow">
        <span class="fs-cap">FEED</span>
        <input type="range" class="fs-range" min="100" max={maxF} step="10" value={Math.min(jog.feed.value, maxF)} aria-label="Jog feed"
          onInput={e => { jog.feed.value = parseInt((e.target as HTMLInputElement).value); }} />
        <NumIn value={jog.feed.value} min={1} max={maxF} label="Jog feed, mm/min" set={v => { jog.feed.value = Math.max(1, Math.round(v)); }} />
        <span class="fs-unit">mm/min</span>
      </div>
      <Steps label="XY" steps={jog.stepsXY.value} value={jog.stepXY.value} set={v => { jog.stepXY.value = v; }} />
      <Steps label="Z" steps={jog.stepsZ.value} value={jog.stepZ.value} set={v => { jog.stepZ.value = v; }} />
      <div class="fs-note">Keys: arrows jog X and Y, Page Up and Down jog Z, while held.</div>
    </Card>
  );
}

// ── Spindle and coolant ───────────────────────────────────────────────────────

const rpm = signal(10000);
/** What was last pressed, shown until the controller reports its own state (A:). */
const pressed = signal({ dir: '', flood: false, mist: false });

function coolantNow(): { flood: boolean; mist: boolean } {
  const a = machine.accessories.value;
  return a === null ? pressed.value : { flood: a.includes('F'), mist: a.includes('M') };
}

function setCoolant(flood: boolean, mist: boolean): void {
  pressed.value = { ...pressed.value, flood, mist };
  if (flood && mist) sendCmd('M7\nM8');
  else if (flood) sendCmd('M8');
  else if (mist) sendCmd('M7');
  else sendCmd('M9');
}

function SpindleCard() {
  const linked = connection.connected.value;
  const a = machine.accessories.value;
  const dir = a === null ? pressed.value.dir : a.includes('S') ? 'CW' : a.includes('C') ? 'CCW' : 'OFF';
  const cool = coolantNow();
  const spin = (d: string, cmd: string) => { pressed.value = { ...pressed.value, dir: d }; sendCmd(cmd); };
  return (
    <Card title="SPINDLE AND COOLANT">
      <div class="fs-inline">
        <span class="fs-cap">RPM</span>
        <NumIn value={rpm.value} min={0} max={30000} step={100} label="Spindle speed, rpm" wide set={v => { rpm.value = Math.max(0, Math.round(v)); }} />
      </div>
      <div class="fs-grid3">
        <button type="button" class={'fs-btn' + (dir === 'CW' ? ' is-go' : '')} disabled={!linked} onClick={() => spin('CW', 'M3 S' + rpm.value)}>CW</button>
        <button type="button" class={'fs-btn' + (dir === 'CCW' ? ' is-go' : '')} disabled={!linked} onClick={() => spin('CCW', 'M4 S' + rpm.value)}>CCW</button>
        <button type="button" class={'fs-btn' + (dir === 'OFF' ? ' is-on' : '')} disabled={!linked} onClick={() => spin('OFF', 'M5')}>OFF</button>
      </div>
      <div class="fs-grid2b">
        <button type="button" class={'fs-btn' + (cool.flood ? ' is-go' : '')} aria-pressed={cool.flood ? 'true' : 'false'} disabled={!linked}
          onClick={() => setCoolant(!cool.flood, cool.mist)}>FLOOD</button>
        <button type="button" class={'fs-btn' + (cool.mist ? ' is-go' : '')} aria-pressed={cool.mist ? 'true' : 'false'} disabled={!linked}
          onClick={() => setCoolant(cool.flood, !cool.mist)}>MIST</button>
      </div>
      <div class="fs-note">{a === null ? 'Lit as last pressed, until the controller reports them.' : 'Lit as the controller reports them.'}</div>
    </Card>
  );
}

// ── Overrides ─────────────────────────────────────────────────────────────────

type OvrKind = 'feed' | 'rapid' | 'spindle';
/** Where each override stands as far as the bytes sent go; the status report corrects it. */
const ovrSent: Record<OvrKind, number> = { feed: 100, rapid: 100, spindle: 100 };
let ovrSeen = machine.overrides.peek();

function syncOvr(): machine.Overrides {
  const now = machine.overrides.value;
  if (now !== ovrSeen) { ovrSeen = now; Object.assign(ovrSent, now); }
  return now;
}

function resetOverride(kind: OvrKind): void {
  rtSend(({ feed: '\x90', rapid: '\x95', spindle: '\x99' } as const)[kind]);
  ovrSent[kind] = 100;
}

// Real-time bytes: ±10% and ±1% for feed (0x91-0x94) and spindle (0x9A-0x9D); rapid 100/50/25% (0x95-0x97).
function applyOverride(kind: OvrKind, target: number): void {
  if (kind === 'rapid') {
    const closest = [100, 50, 25].reduce((a, b) => Math.abs(b - target) < Math.abs(a - target) ? b : a);
    rtSend(({ 100: '\x95', 50: '\x96', 25: '\x97' } as Record<number, string>)[closest]);
    ovrSent.rapid = closest;
    return;
  }
  const [up10, down10, up1, down1] = kind === 'feed' ? ['\x91', '\x92', '\x93', '\x94'] : ['\x9A', '\x9B', '\x9C', '\x9D'];
  let current = ovrSent[kind];
  let delta = target - current;
  let cmds = 0;
  const MAX = 20;
  while (delta >= 10 && cmds < MAX) { rtSend(up10); delta -= 10; current += 10; cmds++; }
  while (delta <= -10 && cmds < MAX) { rtSend(down10); delta += 10; current -= 10; cmds++; }
  while (delta >= 1 && cmds < MAX) { rtSend(up1); delta -= 1; current += 1; cmds++; }
  while (delta <= -1 && cmds < MAX) { rtSend(down1); delta += 1; current -= 1; cmds++; }
  ovrSent[kind] = current;
}

function OverridesCard() {
  const ov = syncOvr();
  const linked = connection.connected.value;
  const rows: [OvrKind, string, number, number][] = [['feed', 'FEED', 10, 200], ['rapid', 'RAPID', 25, 100], ['spindle', 'SPINDLE', 10, 200]];
  return (
    <Card title="OVERRIDES" end={<span class="fs-dim fs-small">tap a name for 100%</span>}>
      {rows.map(([kind, label, min, max]) => (
        <div class="fs-ovrrow">
          <button type="button" class="fs-btn fs-btn-xs fs-ovrname" disabled={!linked} title={'Put ' + label.toLowerCase() + ' back to 100%'} onClick={() => resetOverride(kind)}>{label}</button>
          <input type="range" class="fs-range" min={min} max={max} step={kind === 'rapid' ? 25 : 1} value={ov[kind]} disabled={!linked} aria-label={label + ' override'}
            onInput={e => applyOverride(kind, parseInt((e.target as HTMLInputElement).value))} />
          <span class="fs-ovrpct fs-mono">{ov[kind]}%</span>
        </div>
      ))}
    </Card>
  );
}

// ── Program limits and framing ────────────────────────────────────────────────

export function LimitsCard() {
  const tabs = frame.tabs.value;
  const sel = frame.selected.value;
  const linked = connection.connected.value;
  const refs = ['absolute', ...WCS_ENTRIES.filter(e => e.id).map(e => e.code)];
  const cell = (has: boolean, v: string) => <td class="fs-mono">{has ? v : '—'}</td>;
  return (
    <Card title="PROGRAM LIMITS">
      {!sel ? <div class="fs-empty-sm">No program loaded.</div> : <>
        {tabs.length > 1 && (
          <div role="tablist" class="fs-seg fs-seg-sm fs-self-start">
            {tabs.map(t => <button type="button" role="tab" class={t.id === sel.id ? 'is-on' : ''} aria-selected={t.id === sel.id ? 'true' : 'false'}
              onClick={() => { frame.picked.value = t.id; }}>{t.label}</button>)}
          </div>
        )}
        <table class="fs-table">
          <thead><tr><th /><th>MIN</th><th>MAX</th><th>SPAN</th></tr></thead>
          <tbody>
            {(['X', 'Y', 'Z'] as const).map(a => {
              const s = sel.stats, has = s['has' + a as 'hasX'];
              const lo = s[(a.toLowerCase() + 'Min') as 'xMin'], hi = s[(a.toLowerCase() + 'Max') as 'xMax'];
              return <tr><th class="fs-axis-name">{a}</th>{cell(has, fix3(lo))}{cell(has, fix3(hi))}{cell(has, fix3(hi - lo))}</tr>;
            })}
          </tbody>
        </table>
        <div class="fs-inline">
          <span class="fs-cap">SAFE Z</span>
          <NumIn value={frame.safeZ.value} step={1} label="Safe Z" set={v => { frame.safeZ.value = v; }} />
          <select class="fs-in" aria-label="Safe Z is measured from" value={frame.safeRef.value} onChange={e => { frame.safeRef.value = (e.target as HTMLSelectElement).value; }}>
            {refs.map(r => <option value={r}>{r === 'absolute' ? 'ABS' : r}</option>)}
          </select>
        </div>
        <button type="button" class="fs-btn" disabled={!linked || !sel.frameable} onClick={() => frame.frame()}
          title={sel.frameable ? `Lift to safe Z, then rapid round ${sel.id}'s X and Y limits` : 'Pick a work offset tab to frame that part of the program'}>
          {sel.frameable ? 'FRAME ' + sel.id : 'FRAME PROGRAM'}
        </button>
        {frame.refusal.value && <div class="fs-note is-warn">{frame.refusal.value}</div>}
        {!sel.frameable && <div class="fs-note">Overall is in machine coordinates. Pick a work offset to frame it.</div>}
      </>}
    </Card>
  );
}

// ── Surfacing ─────────────────────────────────────────────────────────────────

const sfCfg = signal<surfacing.SurfacingConfig>(surfacing.loadCfg());

function SurfacingCard() {
  const c = sfCfg.value;
  const set = <K extends keyof surfacing.SurfacingConfig>(k: K, v: surfacing.SurfacingConfig[K]) => {
    sfCfg.value = { ...sfCfg.value, [k]: v };
    surfacing.saveCfg(sfCfg.value);
  };
  const field = (k: keyof surfacing.SurfacingConfig, label: string, step: number, min?: number, max?: number) => (
    <label class="fs-field"><span>{label}</span><NumIn value={c[k] as number} step={step} min={min} max={max} label={label} set={v => set(k, v as any)} /></label>
  );
  const pick = <K extends 'pattern' | 'origin' | 'startPos'>(k: K, label: string, opts: [string, string][]) => (
    <label class="fs-field"><span>{label}</span>
      <select class="fs-in" value={c[k]} onChange={e => set(k, (e.target as HTMLSelectElement).value as surfacing.SurfacingConfig[K])}>
        {opts.map(([v, t]) => <option value={v}>{t}</option>)}
      </select>
    </label>
  );
  return (
    <Card title="SURFACING" class="fs-mcard-tall">
      <div class="fs-mcard-scroll">
        <div class="fs-cap">SIZE AND DEPTH, MM</div>
        <div class="fs-fields">
          {field('xSize', 'X size', 10, 1)}{field('ySize', 'Y size', 10, 1)}
          {field('targetDepth', 'Depth', 0.1, 0.1)}{field('depthPerPass', 'Per pass', 0.1, 0.1)}
          {field('overrun', 'Overrun', 1, 0)}
        </div>
        <div class="fs-cap">TOOL AND FEED</div>
        <div class="fs-fields">
          {field('bitDiameter', 'Bit dia., mm', 0.1, 0.1)}{field('stepoverPct', 'Stepover %', 5, 10, 100)}
          {field('feedRate', 'Feed, mm/min', 100, 1)}{field('plungeRate', 'Plunge, mm/min', 50, 1)}
          {field('spindleRpm', 'Spindle, rpm', 1000, 0)}{field('spindleDelay', 'Spin-up, s', 1, 0, 30)}
        </div>
        <div class="fs-cap">PATTERN</div>
        <div class="fs-fields">
          {pick('startPos', 'Start at', [['current', 'Current position'], ...WCS6.map(w => [w, w] as [string, string])])}
          {pick('pattern', 'Direction', [['zigzagY', 'Vertical'], ['zigzagX', 'Horizontal'], ['spiral', 'Spiral']])}
          {pick('origin', 'Origin', [['bottom-left', 'Bottom left'], ['bottom-right', 'Bottom right'], ['top-left', 'Top left'], ['top-right', 'Top right'], ['center', 'Centre']])}
        </div>
      </div>
      <div class="fs-grid2b">
        <button type="button" class="fs-btn" title="Show the passes in the 3D view" onClick={() => (window as any).loadPreview3D?.(surfacing.generateWaypoints(sfCfg.value))}>PREVIEW</button>
        <button type="button" class="fs-btn fs-btn-go" title="Load the surfacing program as the job" onClick={() => {
          const gcode = surfacing.generateGcode(sfCfg.value);
          processGcode(gcode, 'Surfacing.nc');
          log('info', `Surfacing G-code generated — ${gcode.split('\n').length} lines`);
        }}>GENERATE</button>
      </div>
    </Card>
  );
}

// ── SD card ───────────────────────────────────────────────────────────────────

function SdCard() {
  const linked = connection.connected.value;
  const list = sd.files.value;
  const picker = useRef<HTMLInputElement>(null);
  // Listed when the card opens on a link that's already up, and on REFRESH; never during the connect reads.
  useEffect(() => {
    if (linked && list === null && !sd.listing.value) sd.refresh();
  }, []);
  return (
    <Card title="SD CARD" class="fs-mcard-tall" end={
      <button type="button" class="fs-btn fs-btn-xs" disabled={sd.listing.value} onClick={() => sd.refresh()}>{sd.listing.value ? 'LISTING…' : 'REFRESH'}</button>
    }>
      <div class="fs-sdlist" role="listbox" aria-label="Files on the card">
        {list?.length ? list.map(f => (
          <button type="button" role="option" aria-selected={f.name === sd.selected.value ? 'true' : 'false'}
            class={'fs-sdrow' + (f.name === sd.selected.value ? ' is-on' : '')} onClick={() => { sd.selected.value = f.name; }}>
            <span class="fs-ellipsis">{f.name}</span><span class="fs-dim fs-mono">{f.size !== null ? fmtBytes(f.size) : ''}</span>
          </button>
        )) : <div class="fs-empty-sm">{list ? 'No G-code files on the card.' : linked ? 'Not listed yet: press REFRESH.' : 'Connect to list the card.'}</div>}
      </div>
      {sd.note.value && <div class="fs-note">{sd.note.value}</div>}
      <div class="fs-grid2b">
        <button type="button" class="fs-btn" disabled={!linked || !sd.selected.value} title={sd.selected.value ? 'Run ' + sd.selected.value + ' from the card ($F=)' : ''}
          onClick={() => sd.runSelected()}>RUN FROM SD</button>
        <button type="button" class="fs-btn" disabled={!!sd.uploading.value} title="Open a file here and upload it to the card"
          onClick={() => picker.current?.click()}>{sd.uploading.value ? (sd.uploading.value === 'uploading' ? 'UPLOADING…' : sd.uploading.value) : 'UPLOAD & OPEN'}</button>
      </div>
      <input ref={picker} type="file" hidden accept=".nc,.gcode,.g,.ngc,.tap"
        onChange={e => { const input = e.target as HTMLInputElement; const f = input.files?.[0]; if (f) sd.uploadAndOpen(f); input.value = ''; }} />
    </Card>
  );
}

// ── Work offsets ──────────────────────────────────────────────────────────────

type Edit = { x: string; y: string; z: string };

export function OffsetsTable() {
  const linked = connection.connected.value;
  const offsets = machine.offsets.value;
  const tlo = machine.tlo.value ?? 0;
  const active = machine.wcs.value;
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  // Read when it shows, as the old tab did.
  useEffect(() => { if (linked) loadOffsets(); }, [linked]);
  const rows = WCS_ENTRIES.filter(e => e.code === 'TLO' || offsets[e.code]);
  const edit = (code: string, axis: keyof Edit, v: string, base: machine.Vec3) => {
    const cur = edits[code] ?? { x: fix3(base.x), y: fix3(base.y), z: fix3(base.z) };
    setEdits({ ...edits, [code]: { ...cur, [axis]: v } });
  };
  const drop = (code: string) => { const { [code]: _, ...rest } = edits; setEdits(rest); };
  const write = (code: string, base: machine.Vec3) => {
    const e = edits[code];
    const val = (s: string | undefined, b: number) => { const v = parseFloat(s ?? ''); return Number.isFinite(v) ? v : b; };
    writeOffset(code, { x: val(e?.x, base.x), y: val(e?.y, base.y), z: val(e?.z, base.z) });
    drop(code);
  };
  return (
    <div class="fs-offsets">
      <div class="fs-card-head">
        <span class="fs-dim">{linked ? 'Typed values go when you press WRITE or Enter. POS takes where the machine is now.' : 'Connect and the offsets will load automatically.'}</span>
        <button type="button" class="fs-btn fs-btn-sm" disabled={!linked} onClick={() => loadOffsets()}>READ</button>
      </div>
      {rows.length > 1 || tlo ? (
        <div class="fs-offsets-scroll">
          <table class="fs-table fs-offtable">
            <thead><tr><th>SYSTEM</th><th>X</th><th>Y</th><th>Z</th><th /></tr></thead>
            <tbody>
              {rows.map(entry => {
                const code = entry.code;
                const isTlo = code === 'TLO', isHome = code === 'G28' || code === 'G30';
                const base = isTlo ? { x: 0, y: 0, z: tlo } : offsets[code];
                const e = edits[code];
                const dirty = !!e;
                const input = (axis: keyof Edit) => {
                  // G28/G30 are shown, not edited: grblHAL stores them only from where the machine is (G28.1/G30.1),
                  // they are usually left at home, and the console can still store them (owner, A6).
                  if (isHome || (isTlo && axis !== 'z')) return <td class="fs-mono fs-dim">{fix3(base[axis])}</td>;
                  if (isTlo) return <td class="fs-mono">{fix3(base.z)}</td>;
                  return (
                    <td><input type="number" step="0.001" class="fs-in fs-mono" aria-label={code + ' ' + axis.toUpperCase()}
                      value={e ? e[axis] : fix3(base[axis])}
                      onInput={ev => edit(code, axis, (ev.target as HTMLInputElement).value, base)}
                      onKeyDown={ev => { if (ev.key === 'Enter') write(code, base); }} /></td>
                  );
                };
                return (
                  <tr class={(code === active ? 'is-active' : '') + (dirty ? ' is-dirty' : '') + (isHome ? ' is-home' : '')}>
                    <th class="fs-offname">
                      {code === active ? <span class="fs-wcs fs-wcs-sm">{code}</span> : <span>{code}</span>}
                      <span class="fs-dim fs-small">{entry.label.includes('—') ? entry.label.split('— ')[1] : ''}</span>
                    </th>
                    {input('x')}{input('y')}{input('z')}
                    <td class="fs-offact">
                      {isTlo ? <button type="button" class="fs-btn fs-btn-xs" disabled={!linked} title="Cancel the tool length offset (G49)" onClick={() => cancelTlo()}>G49</button>
                        : isHome ? <span class="fs-dim fs-small">read only</span>
                        : <>
                          <button type="button" class="fs-btn fs-btn-xs" disabled={!linked} title="Set to where the machine is now" onClick={() => { drop(code); setToCurrentPos(code); }}>POS</button>
                          <button type="button" class={'fs-btn fs-btn-xs' + (dirty ? ' is-accent' : '')} disabled={!linked} title="Write these values to the controller" onClick={() => write(code, base)}>WRITE</button>
                          <button type="button" class="fs-btn fs-btn-xs" disabled={!linked} title="Zero all axes" onClick={() => { drop(code); zeroOffset(code); }}>ZERO</button>
                        </>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : <div class="fs-empty-sm">{linked ? 'No offsets read yet. The controller refuses $# until it is homed; press READ after homing.' : 'Not connected.'}</div>}
    </div>
  );
}

// ── The screen ────────────────────────────────────────────────────────────────

/** The window's width, for the number of columns. */
const width = signal(window.innerWidth);
window.addEventListener('resize', () => { width.value = window.innerWidth; });

const SETUP_TABS: [ui.SetupTab, string][] = [['machine', 'MACHINE'], ['offsets', 'OFFSETS']];

function MachineCards() {
  const w = width.value;
  // Columns by width; each column scrolls on its own, so the page never does.
  const cols: (() => ComponentChildren)[][] = w >= 1500
    ? [[PositionCard, SpindleCard], [JogCard, OverridesCard], [LimitsCard, SdCard], [SurfacingCard]]
    : w >= 1000
      ? [[PositionCard, SpindleCard, OverridesCard], [JogCard, LimitsCard], [SdCard, SurfacingCard]]
      : [[PositionCard, JogCard, SpindleCard, OverridesCard], [LimitsCard, SdCard, SurfacingCard]];
  return (
    <div class="fs-setup">
      {cols.map(col => <div class="fs-col">{col.map(C => <C />)}</div>)}
    </div>
  );
}

export function SetupScreen() {
  const tab = ui.setupTab.value;
  // Built only while it shows: the offsets are read and the card listed when it opens, as the old tabs did.
  if (ui.screen.value !== 'setup') return null;
  return (
    <section class="fs-screen">
      <div role="tablist" class="fs-subtabs">
        {SETUP_TABS.map(([id, label]) => (
          <button type="button" role="tab" aria-selected={tab === id ? 'true' : 'false'} class={tab === id ? 'is-on' : ''}
            onClick={() => { ui.setupTab.value = id; }}>{label}</button>
        ))}
      </div>
      {tab === 'machine' ? <MachineCards /> : <div class="fs-sub fs-pad"><OffsetsTable /></div>}
    </section>
  );
}

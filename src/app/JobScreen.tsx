// ═══════════════════════════════════════════════
// The job screen: Current Job strip, and two switchable panels: Jobs and Program on the left, the rest on the right
// ═══════════════════════════════════════════════

import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { computed, signal, type Signal } from '@preact/signals';
import * as connection from '../stores/connection';
import * as machine from '../stores/machine';
import * as job from '../stores/job';
import * as flight from '../stores/flight';
import * as camera from '../stores/camera';
import * as program from '../stores/program';
import type { ToolRow } from '../stores/program';
import * as queue from '../stores/queue';
import * as runtimes from '../stores/runtimes';
import * as options from '../stores/options';
import * as ui from './ui';
import { mode, panel, leftPanel, rows, atLine, sectionIndex, nextSection, awaitedSection, stoppedShort, toolLabel, toolChangeMode } from './mode';
import { plan, rowStarts, queuedMs } from './plan';
import { bellOn, toggleBell } from './sound';
import { measureAtToolChange } from '../streaming';
import { offsetsWaitForHoming } from '../offsets';
import { CameraPanel as Camera } from './CameraPanel';
import { ConsolePanel as Console } from './ConsolePanel';
import { MacrosPanel as Macros } from './MacrosPanel';
import { RunPanel } from './RunPanel';
import { Preview } from './Preview';
import { WarmupStrip } from './Warmup';
import { progress as warmupProgress } from '../warmup';
import { frOpenResume, frLoadEvents, frClearEvents, frReadRecord } from '../flight-recorder';
import { IconChevron, IconBell, IconCheck, IconTodo, IconWarn, IconArrow, IconClose } from './icons';

const num = (v: number) => v.toLocaleString('en-GB');
const mm = (v: number) => (Math.round(v * 1000) / 1000).toLocaleString('en-GB', { maximumFractionDigits: 3 });
const clock = (t: number) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const pad = (n: number) => String(n).padStart(2, '0');
/** h:mm:ss; an estimate gets a ~. */
const dur = (ms: number, measured: boolean) => (measured ? '' : '~') + job.fmtDuration(ms);
/** Time from the start: +40s, +12m, +1:05. */
function rel(ms: number): string {
  const m = Math.floor(ms / 60_000);
  return ms < 60_000 ? '+' + Math.round(ms / 1000) + 's' : m < 60 ? '+' + m + 'm' : '+' + Math.floor(m / 60) + ':' + pad(m % 60);
}
/** Time from now: in 45s, in 12m, in 1:05. */
function until(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return 'in ' + (s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm' : Math.floor(s / 3600) + ':' + pad(Math.floor(s / 60) % 60));
}

// One muted colour per tool, in the order the tools come up in the loaded job and then the queue,
// shared with the progress bar.
const TINTS = [
  { tint: '#5b7fa6', bar: '#26364a' }, { tint: '#a07c45', bar: '#42331f' }, { tint: '#5a9590', bar: '#29403e' },
  { tint: '#8a6aa0', bar: '#3a2d45' }, { tint: '#a0606c', bar: '#45282d' }, { tint: '#6f8f4e', bar: '#2e3a22' },
];
const NO_TINT = { tint: '#475569', bar: '#2a271e' };

const tintOrder = computed(() => [...new Set([...rows.value.map(r => r.tool), ...queue.entries.value.flatMap(e => e.summary.rows.map(r => r.tool))])]);

export function tintOf(tool: number | null): { tint: string; bar: string } {
  if (tool === null) return NO_TINT;
  return TINTS[Math.max(0, tintOrder.value.indexOf(tool)) % TINTS.length];
}

// ── Current Job strip ─────────────────────────────────────────────────────────

function jobNow(): string {
  const file = job.file.value;
  if (!file) return 'No job loaded';
  if (!program.view.value) return program.reading.value ? 'Reading the program…' : 'Loaded';
  const sections = rows.value;
  const section = sections[sectionIndex.value];
  const where = section ? [section.name, toolLabel(section.tool)].filter(Boolean).join(' · ') : '';
  const m = mode.value;
  if (m === 'running' || m === 'hold') return where || 'Running';
  if (m === 'change') { const s = awaitedSection.value; return 'Waiting for ' + (s ? toolLabel(s.tool) : 'the next tool'); }
  if (m === 'alarm' || stoppedShort.value) return 'Stopped' + (where ? ' in ' + where : '');
  if (job.result.value === 'completed') return 'Completed in ' + job.fmtDuration(job.elapsedMs.value);
  const tools = new Set(sections.map(s => s.tool).filter(t => t !== null)).size;
  const p = plan.value;
  const time = p.run ? ' · about ' + job.fmtDuration(p.totalMs) + ' from the last run' : p.totalMs ? ' · ~' + job.fmtDuration(p.totalMs) + ' estimated' : '';
  return 'Ready · ' + (tools ? tools + (tools === 1 ? ' tool' : ' tools') : 'no tool named') + ' · ' + num(job.lines.value.length) + ' lines' + time;
}

function CurrentJob() {
  const sections = rows.value;
  const p = plan.value;
  const done = job.result.value === 'completed';
  const at = done ? job.lines.value.length : atLine.value;
  const pct = p.rowsMs ? Math.min(100, p.doneMs / p.rowsMs * 100) : 0;
  const run = p.run;
  return (
    <section aria-labelledby="fs-cur" class="fs-card fs-current">
      <div class="fs-current-name">
        <h2 id="fs-cur" class="fs-h">CURRENT JOB</h2>
        <div class="fs-file">{job.file.value ?? '—'}</div>
        <div class="fs-now">{jobNow()}</div>
      </div>
      <div class="fs-current-bar">
        <div class="fs-bar">
          <div class="fs-bar-sections">
            {sections.length ? sections.map((s, k) => (
              <div style={{ flex: Math.max(1, Math.round(p.times[k].ms)) + ' 1 0', background: tintOf(s.tool).bar }}
                title={toolLabel(s.tool) + ', ' + dur(p.times[k].ms, p.times[k].measured)}>{s.tool !== null ? 'T' + s.tool : ''}</div>
            )) : <div style={{ flex: '1 1 0' }} />}
          </div>
          <div class="fs-bar-done" style={{ width: pct.toFixed(1) + '%' }} />
        </div>
        <div class="fs-note">
          {!sections.length ? 'Progress by time, once a program is loaded.'
            : p.allMeasured ? `Progress by time, measured on the last whole run of this file (${new Date(run!.at).toLocaleDateString('en-GB')}).`
            : 'Progress by time, estimated from the G-code: a lower bound, with no acceleration.'}
        </div>
      </div>
      <div class="fs-times">
        <div><div class="fs-cap">ELAPSED</div><div class="fs-time">{job.fmtDuration(job.elapsedMs.value)}</div></div>
        <div title={p.allMeasured ? 'The rest of this file\'s last whole run, tool changes not counted' : 'From the G-code: a lower bound'}>
          <div class="fs-cap">LEFT, EST.</div><div class="fs-time is-dim">{p.rowsMs ? dur(p.leftMs, p.allMeasured) : '—'}</div>
        </div>
        <div><div class="fs-cap">LINE</div><div class="fs-time is-dim">{at ? num(at) : '—'}</div></div>
      </div>
    </section>
  );
}

// ── Left panel: Jobs ──────────────────────────────────────────────────────────

const RESULT_WORDS: Record<job.JobResult, string> = { completed: 'Done', stopped: 'Stopped', error: 'Error', alarm: 'Alarm', 'link lost': 'Link lost' };

function programStatus(): string {
  const m = mode.value;
  if (m === 'running') return 'Running';
  if (m === 'hold') return 'Paused';
  if (m === 'change') return 'Waiting';
  if (m === 'alarm' && job.result.value) return RESULT_WORDS[job.result.value];
  if (job.result.value) return RESULT_WORDS[job.result.value];
  return 'Ready';
}

const live = () => mode.value === 'running' || mode.value === 'hold' || mode.value === 'change';

function toolStatus(k: number, s: ToolRow): { text: string; live: boolean; dim: boolean } {
  const m = mode.value;
  const p = plan.value;
  const current = sectionIndex.value;
  const plain = { text: '', live: false, dim: false };
  if (m === 'change') {
    const awaited = p.waiting ?? rows.value.indexOf(awaitedSection.value!);
    if (k === awaited) return { text: 'Load now', live: true, dim: false };
    return k < awaited ? { text: 'Done', live: false, dim: true } : plain;
  }
  if (m === 'running' || m === 'hold') {
    if (k < current) return { text: 'Done', live: false, dim: true };
    if (k === current) return { text: 'Cutting', live: true, dim: false };
    // The next tool change: how long until it is due.
    if (k === current + 1 && job.running.value) return { text: until(rowStarts.value.rows[k]), live: false, dim: false };
    return plain;
  }
  if (job.result.value === 'completed') return { text: 'Done', live: false, dim: true };
  if (job.result.value && atLine.value) {
    if (k < current) return { text: 'Done', live: false, dim: true };
    if (k === current) return { text: 'Stopped', live: true, dim: false };
    return plain;
  }
  if (k === 0 && s.tool !== null && machine.tool.value === s.tool) return { text: 'In spindle', live: false, dim: false };
  return plain;
}

/** A tool's sound toggle: on every tool that comes in with an M6, where the job holds. */
function Bell({ id, line, tool }: { id: string; line: number; tool: number | null }) {
  if (!line) return <span class="fs-c-bell" />;
  const on = bellOn(id, line);
  const name = tool !== null ? 'T' + tool : 'this tool';
  return (
    <span class="fs-c-bell">
      <button type="button" class={'fs-bell' + (on ? ' is-on' : '')} aria-pressed={on ? 'true' : 'false'} aria-label={'Sound when ' + name + ' is due'}
        title={(on ? 'Sound on' : 'Sound off') + ' for the tool change at line ' + num(line)} onClick={() => toggleBell(id, line)}><IconBell on={on} /></button>
    </span>
  );
}

function ToolCells({ tool, desc, missing }: { tool: number | null; desc: string; missing: boolean }) {
  return (
    <span class="fs-c-name fs-tool-name">
      <span class="fs-tint" style={{ background: tintOf(tool).tint }} />
      <span class="fs-mono fs-tool-num">{tool !== null ? 'T' + tool : '—'}</span>
      <span class="fs-ellipsis">{desc}</span>
      {missing && <span class="fs-warn" aria-label="not in tool table" title="Not in the tool table"><IconWarn size={13} /></span>}
    </span>
  );
}

const inTable = (tool: number | null) => {
  const table = machine.toolTable.value;
  return tool === null || table === null || table.some(e => e.tool === tool);
};

/** Queued jobs shown with their tools. */
const queueOpen = signal<Record<string, boolean>>({});

function QueueRows({ startMs }: { startMs: number | null }) {
  const list = queue.entries.value;
  const open = queueOpen.value;
  const now = job.now.value;
  let at = startMs;
  return (
    <>
      {list.map((e, k) => {
        const time = queuedMs(e);
        const ran = runtimes.forFile(e.summary.id);
        const rowMs = ran && ran.rowMs.length === e.summary.rows.length ? ran.rowMs : null;
        const begins = at;
        if (at !== null) at += time.ms;
        const isOpen = !!open[e.key];
        const missing = e.summary.rows.filter(r => !inTable(r.tool));
        const when = (ms: number | null) => ms === null ? '—' : live() ? clock(now + ms) : rel(ms);
        let toolAt = begins;
        return (
          <>
            <div class="fs-jobs-row is-program is-queued">
              <span class="fs-c-name">
                {e.summary.rows.length ? (
                  <button type="button" class="fs-chev" aria-expanded={isOpen ? 'true' : 'false'} aria-label={(isOpen ? 'Hide tools for ' : 'Show tools for ') + e.name}
                    onClick={() => { queueOpen.value = { ...open, [e.key]: !isOpen }; }}><IconChevron open={isOpen} /></button>
                ) : <span class="fs-chev-gap" />}
                <span class="fs-prog-name" title={e.summary.stopped ? 'Read up to ' + e.summary.stopped : `${num(e.summary.lines)} lines`}>{e.name}</span>
                <span class="fs-q-acts">
                  <button type="button" class="fs-q-btn" disabled={k === 0} aria-label={'Move ' + e.name + ' up the queue'} onClick={() => queue.move(e.key, -1)}><IconArrow up /></button>
                  <button type="button" class="fs-q-btn" disabled={k === list.length - 1} aria-label={'Move ' + e.name + ' down the queue'} onClick={() => queue.move(e.key, 1)}><IconArrow up={false} /></button>
                  <button type="button" class="fs-q-btn" aria-label={'Take ' + e.name + ' off the queue'} onClick={() => queue.remove(e.key)}><IconClose /></button>
                </span>
              </span>
              <span class="fs-c-status">
                {k === 0 ? 'Next' : 'Queued'}
                {missing.length > 0 && <span class="fs-warn fs-warn-word" title="Not in the tool table"><IconWarn size={13} />{missing.map(r => 'T' + r.tool).join(' ')}</span>}
              </span>
              <span class="fs-c-at fs-mono">{when(begins)}</span>
              <span class="fs-c-run fs-mono" title={time.measured ? 'Measured on the last whole run of this file' : 'Estimated from the G-code: a lower bound'}>{dur(time.ms, time.measured)}</span>
              <span class="fs-c-bell" />
            </div>
            {isOpen && e.summary.rows.map((r, j) => {
              const ms = rowMs?.[j] ?? null;
              const starts = toolAt;
              if (toolAt !== null) toolAt += ms ?? r.estSeconds * 1000;
              const label = toolLabel(r.tool).replace(/^T\d+( · )?/, '') || r.desc;
              return (
                <div class="fs-jobs-row is-tool">
                  <ToolCells tool={r.tool} desc={label} missing={!inTable(r.tool)} />
                  <span class="fs-c-status">{!inTable(r.tool) ? 'Not in table' : ''}</span>
                  <span class="fs-c-at fs-mono">{when(starts)}</span>
                  <span class="fs-c-run fs-mono">{ms !== null ? dur(ms, true) : dur(r.estSeconds * 1000, false)}</span>
                  <Bell id={e.summary.id} line={r.changeLine} tool={r.tool} />
                </div>
              );
            })}
          </>
        );
      })}
    </>
  );
}

function JobsList() {
  const file = job.file.value;
  const last = job.lastJob.value;
  const sections = rows.value;
  const open = ui.toolsOpen.value;
  const status = programStatus();
  const p = plan.value;
  const starts = rowStarts.value;
  const now = job.now.value;
  const isLive = live();
  const ran = job.startedAt.value !== null;
  const id = job.fileId.value;
  const progRun = job.result.value === 'completed' ? job.fmtDuration(job.elapsedMs.value)
    : p.times.length ? dur(p.totalMs, !!p.run) : program.reading.value ? '…' : '—';
  // Where the queue starts: after the loaded job, from the start (ready) or from now (running).
  const queueStart = !file ? 0 : isLive ? starts.endMs : ran ? null : p.totalMs;
  return (
    <div>
      <div class="fs-jobs-scroll">
        <div class="fs-jobs-table">
          <div class="fs-jobs-row is-head">
            <span class="fs-c-name" style={{ paddingLeft: '26px' }}>PROGRAM / TOOL</span>
            <span class="fs-c-status">STATUS</span>
            <span class="fs-c-at">AT</span>
            <span class="fs-c-run">RUNTIME</span>
            <span class="fs-c-bell" />
          </div>
          {last && job.result.value === null && (
            <div class="fs-jobs-row is-program is-dim">
              <span class="fs-c-name"><span class="fs-chev-gap" /><span class="fs-prog-name">{last.name}</span></span>
              <span class="fs-c-status">{RESULT_WORDS[last.result]}</span>
              <span class="fs-c-at fs-mono">{clock(last.endedAt)}</span>
              <span class="fs-c-run fs-mono">{job.fmtDuration(last.runtimeMs)}</span>
              <span class="fs-c-bell" />
            </div>
          )}
          {file && (
            <div class="fs-jobs-row is-program">
              <span class="fs-c-name">
                {sections.length ? (
                  <button type="button" class="fs-chev" aria-expanded={open ? 'true' : 'false'} aria-label={(open ? 'Hide tools for ' : 'Show tools for ') + file}
                    onClick={() => { ui.toolsOpen.value = !open; }}><IconChevron open={open} /></button>
                ) : <span class="fs-chev-gap" />}
                <span class="fs-prog-name">{file}</span>
              </span>
              <span class={'fs-c-status' + (status === 'Running' ? ' is-go' : '')}>{status}</span>
              <span class="fs-c-at fs-mono">{ran ? clock(job.startedAt.value!) : 'start'}</span>
              <span class="fs-c-run fs-mono" title={p.run ? `Measured on the last whole run of this file, tool changes included (${p.run.runs} run${p.run.runs === 1 ? '' : 's'})` : 'Estimated from the G-code: a lower bound'}>{progRun}</span>
              <span class="fs-c-bell" />
            </div>
          )}
          {file && open && sections.map((s, k) => {
            const st = toolStatus(k, s);
            const t = p.times[k];
            const missing = !inTable(s.tool);
            const at = isLive ? (k === p.waiting ? 'now' : t.start !== null ? clock(t.start) : k > p.current ? clock(now + starts.rows[k]) : '—')
              : ran ? (t.start !== null ? clock(t.start) : '—')
              : k === 0 ? 'start' : rel(starts.rows[k]);
            // This run's time for a tool it has finished; otherwise the last whole run's, or the estimate.
            const runtime = t.start !== null && t.end !== null ? job.fmtDuration(t.end - t.start) : dur(t.ms, t.measured);
            return (
              <div class={'fs-jobs-row is-tool' + (st.live ? ' is-live' : '') + (st.dim ? ' is-dim' : '')}>
                <ToolCells tool={s.tool} desc={toolLabel(s.tool).replace(/^T\d+( · )?/, '') || s.name} missing={missing} />
                <span class={'fs-c-status' + (st.text === 'Cutting' ? ' is-go' : '')}>{missing && !st.text ? 'Not in table' : st.text}</span>
                <span class="fs-c-at fs-mono" title={s.changeLine ? 'Tool change at line ' + num(s.changeLine) : 'From the start of the program'}>{at}</span>
                <span class="fs-c-run fs-mono">{runtime}</span>
                <Bell id={id} line={s.changeLine} tool={s.tool} />
              </div>
            );
          })}
          <QueueRows startMs={queueStart} />
          {!file && !last && !queue.entries.value.length && <div class="fs-empty">No job loaded yet.</div>}
        </div>
      </div>
      <div class="fs-note">
        AT: {isLive ? 'clock times; those still to come are projected, without the tool changes' : ran ? 'when each tool started' : 'time from the start'}.
        {' '}~ marks an estimate from the G-code, a lower bound; a file's measured times come from its last whole run.
      </div>
    </div>
  );
}

function JobsButtons() {
  const m = mode.value;
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" class="fs-btn fs-btn-sm" disabled={m === 'running' || m === 'hold' || m === 'change'}
        onClick={() => document.getElementById('fileInput')?.click()}>LOAD JOB</button>
      <button type="button" class="fs-btn fs-btn-sm fs-queue-btn" onClick={() => input.current?.click()}>ADD TO QUEUE</button>
      <input ref={input} type="file" multiple accept=".nc,.gcode,.g,.ngc,.tap,.txt" hidden
        onChange={e => { const el = e.currentTarget; const files = [...(el.files ?? [])]; el.value = ''; queue.add(files); }} />
    </>
  );
}

// ── Right panel: Setup ────────────────────────────────────────────────────────
//
// The job's setup, and the way into the setup tools. Every line reads its own state, says what's done
// and what's left, takes a tick from the operator, and opens the tool for it. Informational only:
// nothing here stops Start or anything else.

/** done = green, todo = yellow, fail = red. */
type Tone = 'done' | 'todo' | 'fail';

interface Check {
  key: string;
  tone: Tone;
  text: string;
  detail?: string;
  /** A button: a popup to open, or something to do. */
  actions?: [string, ui.Popup | (() => void)][];
  /** What the tick means on this line, when it isn't just "confirmed". */
  tickWord?: string;
  noTick?: boolean;
}

const vec = (o: machine.Vec3) => `X ${mm(o.x)} Y ${mm(o.y)} Z ${mm(o.z)}`;
const same = (a: machine.Vec3, b: machine.Vec3) => Math.abs(a.x - b.x) < 1e-4 && Math.abs(a.y - b.y) < 1e-4 && Math.abs(a.z - b.z) < 1e-4;

function offsetCheck(): Check {
  const wcs = machine.wcs.value;
  const key = 'offset:' + wcs;
  const actions: [string, ui.Popup][] = [['PROBE', 'probe'], ['SET ZERO', 'jog']];
  if (!connection.connected.value) return { key, tone: 'todo', text: `Work offset ${wcs}`, detail: 'read when the controller connects', actions };
  if (!machine.offsetsRead.value) return offsetsWaitForHoming()
    ? { key, tone: 'todo', text: `Work offset ${wcs}`, detail: 'read after homing', actions }
    : { key, tone: 'todo', text: `Reading work offset ${wcs}…`, actions };
  const off = machine.offsets.value[wcs] ?? { x: 0, y: 0, z: 0 };
  const before = machine.offsetsAtConnect.value?.[wcs];
  const how = machine.offsetWrites.value[wcs];
  // Set this session: written by a command, or different from what the controller held when FlexiSender connected.
  if (how || (before && !same(before, off))) {
    return { key, tone: 'done', text: how === 'zeroed' ? `${wcs} set: zeroed this session.` : `${wcs} set, probed.`, detail: vec(off), actions };
  }
  // All zeros is taken as not set.
  if (!off.x && !off.y && !off.z) return { key, tone: 'todo', text: `${wcs} is not set. Probe or set up the workpiece.`, detail: 'all zeros', actions };
  return { key, tone: 'todo', text: `${wcs} set. Probe or set up the workpiece.`, detail: vec(off) + ', from before this session', actions };
}

function tloCheck(): Check {
  const key = 'tlo';
  const actions: [string, ui.Popup][] = [['MEASURE', 'measure']];
  const tlo = machine.tlo.value;
  if (!connection.connected.value) return { key, tone: 'todo', text: 'Tool length offset', detail: 'read when the controller connects', actions };
  if (tlo === null) return offsetsWaitForHoming()
    ? { key, tone: 'todo', text: 'Tool length offset', detail: 'read after homing', actions }
    : { key, tone: 'todo', text: 'Reading the tool length offset…', actions };
  if (tlo === 0) return { key, tone: 'todo', text: 'Set TLO: measure the tool.', detail: 'the offset is 0', actions };
  const tool = machine.tool.value;
  return { key, tone: 'done', text: `TLO set: ${tool ? 'T' + tool + ', ' : ''}${mm(tlo)} mm`, actions };
}

function toolCheck(): Check {
  const key = 'tool';
  const first = rows.value[0];
  if (!job.file.value) return { key, tone: 'todo', text: 'Tool in the spindle', detail: 'load a program to see its first tool' };
  if (!program.view.value) return { key, tone: 'todo', text: 'Tool in the spindle', detail: 'reading the program…' };
  if (!first || first.tool === null) return { key, tone: 'todo', text: 'Check the tool in the spindle', detail: 'the program names no tool' };
  const label = toolLabel(first.tool);
  const tool = machine.tool.value;
  if (tool === first.tool) return { key, tone: 'done', text: label + ' is in the spindle' };
  if (tool === null) return { key, tone: 'todo', text: 'Load ' + label, detail: connection.connected.value ? 'reading the tool in the spindle…' : 'connect to read the tool in the spindle' };
  return { key, tone: 'todo', text: 'Load ' + label, detail: tool === 0 ? 'the controller reports no tool (T0)' : `the spindle has T${tool}` };
}

function toolTableCheck(): Check {
  const key = 'tooltable';
  const tools = [...new Set(rows.value.map(s => s.tool).filter((t): t is number => t !== null))];
  const table = machine.toolTable.value;
  if (machine.toolTableError.value) {
    return { key, tone: 'todo', text: 'No tool table on this controller', detail: `$TTLIST isn't supported (${machine.toolTableError.value}); check the tools by hand` };
  }
  const actions: [string, ui.Popup][] = [['TOOLS', 'tools']];
  if (table === null) return { key, tone: 'todo', text: 'Tool table', detail: connection.connected.value ? 'reading it…' : 'read when the controller connects', actions };
  if (!tools.length) return { key, tone: 'todo', text: 'Tool table read', detail: job.file.value ? 'the program names no tools' : 'load a program to check its tools', actions };
  const missing = tools.filter(t => !table.some(e => e.tool === t));
  return missing.length
    ? { key, tone: 'fail', text: `${missing.length} of ${tools.length} tools are not in the tool table`, detail: missing.map(t => 'T' + t).join(', '), actions }
    : { key, tone: 'done', text: `All ${tools.length} tools are in the tool table`, detail: tools.map(t => 'T' + t).join(', '), actions };
}

function travelCheck(): Check {
  const key = 'travel';
  const actions: [string, ui.Popup][] = [['FRAME', 'frame']];
  const tickWord = 'framed';
  const v = program.view.value;
  const travel = [130, 131, 132].map(id => parseFloat(machine.settings.value[id] ?? ''));
  const todo = (detail: string): Check => ({ key, tone: 'todo', text: 'Program fits the machine travel', detail, actions, tickWord });
  if (!job.file.value) return todo('load a program to check it');
  if (!v) return todo('reading the program…');
  if (travel.some(isNaN)) return todo(connection.connected.value ? 'reading the travel ($130–$132)…' : 'connect to read the travel');
  if (!machine.offsetsRead.value) return todo(offsetsWaitForHoming() ? 'the work offsets are read after homing' : 'reading the work offsets…');
  // The travel as grblHAL sets it once homed (machine_limits.c): −$13x to 0; or, with "set machine origin
  // to 0" ($22 bit 3), 0 to +$13x for an axis that homes negative ($23). With hard limits on ($21) the
  // pull-off ($27) comes off both ends. Not known until those are read; until then −$13x to 0.
  const setting = (id: number) => parseInt(machine.settings.value[id] ?? '');
  const originAtHome = (setting(22) & 8) !== 0;
  const pulloff = (setting(21) & 1) ? parseFloat(machine.settings.value[27] ?? '') || 0 : 0;
  const ends = (bit: number, len: number): [number, number] =>
    originAtHome ? ((setting(23) & bit) ? [0, len - pulloff] : [-len + pulloff, 0]) : [-len + pulloff, -pulloff];
  // The interpreter's machine bounds: every move, rapids, G53 and stored returns included, arcs at their
  // extremes, with the controller's offsets, G92 and tool length offset.
  const b = v.program.bounds.machine;
  const over: string[] = [];
  (['x', 'y', 'z'] as const).forEach((a, i) => {
    const [min, max] = ends(1 << i, travel[i]), lo = b.min[a], hi = b.max[a], axis = a.toUpperCase();
    if (lo !== null && lo < min - 0.001) over.push(`${axis} goes ${mm(min - lo)} mm past the ${min < 0 ? 'end of the travel' : 'machine zero'} (machine ${axis} ${mm(lo)})`);
    if (hi !== null && hi > max + 0.001) over.push(`${axis} goes ${mm(hi - max)} mm past ${max > 0 ? 'the end of the travel' : 'machine zero'} (machine ${axis} ${mm(hi)})`);
  });
  // The words say where the program itself works; the check above takes all its motion.
  const wcs = Object.keys(v.extent.perWorkOffset)[0] as keyof typeof v.extent.perWorkOffset | undefined;
  const w = wcs ? v.extent.perWorkOffset[wcs]! : v.program.bounds.work;
  const span = (a: 'x' | 'y' | 'z') => w.min[a] === null ? '' : `${a.toUpperCase()} ${mm(w.min[a]!)} to ${mm(w.max[a]!)}`;
  const work = [span('x'), span('y'), span('z')].filter(Boolean).join(', ') + (wcs ? ' in ' + wcs : '');
  if (over.length) return { key, tone: 'fail', text: 'Program goes outside the machine travel', detail: over.join('; ') + (b.complete ? '' : '; and some moves aren\'t known'), actions, tickWord };
  if (v.stopped) return todo(`checked up to line ${num(v.stopped.line)}, where BearSender stops reading the program`);
  if (!b.complete) {
    // A controller command it doesn't follow says most; then any other unknown.
    const why = v.program.issues.find(i => i.code === 'unknown-system-line' || i.code === 'unknown-home') ?? v.program.issues.find(i => i.code.startsWith('unknown-'));
    return todo('some moves aren\'t known' + (why ? ` (line ${num(why.line)}: ${why.message})` : '') + '; ' + work);
  }
  return { key, tone: 'done', text: 'Program fits the machine travel', detail: work, actions, tickWord };
}

/** Shown only when the interpreter stops part way: the times, tools, preview and travel are of the part before. */
function programCheck(): Check | null {
  const v = program.view.value;
  if (!job.file.value || !v?.stopped) return null;
  const s = v.stopped;
  return { key: 'program:' + s.line, tone: 'todo', text: `BearSender reads the program only up to line ${num(s.line)}`,
    detail: `${s.message.replace(/ Interpretation stops here.*$/, '')} Times, tools, preview and travel are of the lines before it; the job still sends whole.` };
}

/** Yellow notes on lines the reading can't follow (controller commands) and on the program end, for the
 *  Setup list and the Program panel. For information: the job sends as it says. */
function programNotes(): Check[] {
  const v = program.view.value;
  if (!job.file.value || !v) return [];
  const notes: Check[] = [];
  const issues = v.program.issues;
  const system = issues.filter(i => i.code === 'unknown-system-line' || i.code === 'unknown-home');
  if (system.length) {
    const first = system[0];
    notes.push({ key: 'program-system:' + first.line, tone: 'todo',
      text: `Line ${num(first.line)} is a controller command BearSender doesn't follow` + (system.length > 1 ? `, and ${system.length - 1} more` : ''),
      detail: `${first.message} The travel check and the preview leave out what it does; it is still sent.` });
  }
  const after = issues.filter(i => i.code === 'after-program-end');
  if (after.length) {
    const end = v.program.lines.find(l => l.stateAfter.programEnd !== null)?.line ?? 0;
    notes.push(options.runAfterM30.value
      ? { key: 'program-after-end:' + after[0].line, tone: 'todo', text: `Lines run after the program end${end ? ' on line ' + num(end) : ''}`,
          detail: `${after[0].message} The travel check and the preview take them in (Options: Run lines after M30 is on).` }
      : { key: 'program-ends:' + end, tone: 'todo', text: `The job ends at the program end on line ${num(end)}`,
          detail: `the ${after.length} line${after.length === 1 ? '' : 's'} after it with something to run ${after.length === 1 ? 'isn\'t' : 'aren\'t'} sent (Options: Run lines after M30 is off)` });
  }
  return notes;
}

function recorderCheck(): Check {
  const key = 'recorder';
  const actions: [string, ui.Popup][] = [['SETTINGS', 'recorder']];
  const fr = flight.plugin.value;
  if (!connection.connected.value) return { key, tone: 'todo', text: 'Flight recorder', detail: 'checked when the controller connects', actions };
  if (!fr) return { key, tone: 'todo', text: 'No flight recorder on this controller', detail: 'jobs run without a record', actions };
  if (!fr.storage) return { key, tone: 'fail', text: 'Flight recorder has no FRAM', detail: `plugin v${fr.version} found, but no storage for the record`, actions };
  if (!flight.enabled.value) return { key, tone: 'todo', text: 'Flight recorder is off', detail: `plugin v${fr.version} found; turn it on in its settings`, actions };
  return { key, tone: 'done', text: 'Flight recorder ready', detail: `plugin v${fr.version}, FRAM found`, actions };
}

// At a tool change grblHAL refuses every move but jogging, so the Probing tab can't measure there.
// The controller measures itself: $TPW with $341 1 or 2, on its own after Resume with 3.
function measureCheck(key: string, tlo: number | null): Check {
  const detail = tlo ? `TLO now ${mm(tlo)} mm` : '';
  const m = toolChangeMode();
  if (m === 1) return { key, tone: 'todo', text: 'Measure the tool length: jog over the touch plate, then MEASURE ($TPW)', detail, actions: [['MEASURE', measureAtToolChange]] };
  if (m === 2) return { key, tone: 'todo', text: 'Measure the tool length on the toolsetter: MEASURE ($TPW)', detail, actions: [['MEASURE', measureAtToolChange]] };
  if (m === 3) return { key, tone: 'todo', text: 'The controller measures the tool after Resume', detail: '$341=3, semi-automatic', noTick: true };
  return { key, tone: 'todo', text: 'The controller can\'t measure the tool at a tool change', detail: m === null ? '$341 not read yet' : `$341=${m}; 1 or 2 measure with $TPW, 3 on its own`, noTick: true };
}

function changeChecks(): Check[] {
  const s = awaitedSection.value;
  const sections = rows.value;
  const entry = s && machine.toolTable.value?.find(e => e.tool === s.tool);
  const key = 'change:' + (s ? s.tool + ':' + s.changeLine : '?') + ':';
  const spinning = machine.spindle.value > 0;
  const tlo = machine.tlo.value;
  return [
    { key: key + 'spindle', tone: spinning ? 'fail' : 'done', text: spinning ? `Spindle still turning at ${num(machine.spindle.value)} rpm` : 'Spindle stopped',
      detail: 'tool at machine Z ' + machine.mpos.value.z.toFixed(3) },
    { key: key + 'load', tone: 'todo', text: 'Load ' + (s ? toolLabel(s.tool) : 'the next tool'), detail: entry && entry.pocket ? 'pocket ' + entry.pocket : '' },
    // Held by BearSender (Hold at every M6): the controller is idle, so the Probing tab can measure.
    job.heldAtM6.value
      ? { key: key + 'measure', tone: 'todo', text: 'Measure the tool length if it changed: the controller is idle, so MEASURE probes it',
          detail: [tlo ? `TLO now ${mm(tlo)} mm` : '', 'held by BearSender at this M6 (Options: Hold at every M6)'].filter(Boolean).join(' · '), actions: [['MEASURE', 'measure']] }
      : measureCheck(key + 'measure', tlo),
    { key: key + 'resume', tone: 'todo', text: 'Press Resume', detail: s && sections[sections.indexOf(s)]?.name ? sections[sections.indexOf(s)].name + ' starts' : '', noTick: true },
  ];
}

function setupChecks(): Check[] {
  if (mode.value === 'change') return changeChecks();
  const read = programCheck();
  return [offsetCheck(), tloCheck(), toolCheck(), toolTableCheck(), travelCheck(), ...(read ? [read] : []), ...programNotes(), recorderCheck()];
}

const TONE_WORD: Record<Tone, string> = { done: 'done', todo: 'to do', fail: 'failed' };

function SetupPanel() {
  const checks = setupChecks();
  const ticks = ui.ticks.value;
  // A tick confirms a line: it turns green whatever the reading said, and keeps the reading's words.
  const tones = checks.map(c => (!c.noTick && ticks[c.key]) ? 'done' as Tone : c.tone);
  const count = (t: Tone) => tones.filter(x => x === t).length;
  return (
    <div>
      <div class="fs-panel-title">
        {mode.value === 'change' ? 'Tool change' : 'Before you start'} · {count('done')} done, {count('todo')} to do{count('fail') ? ', ' + count('fail') + ' failed' : ''}
      </div>
      {checks.map((c, i) => {
        const tone = tones[i];
        const ticked = !c.noTick && !!ticks[c.key];
        return (
          <div class={'fs-check is-' + tone}>
            <span class="fs-check-icon" role="img" aria-label={TONE_WORD[tone]} title={TONE_WORD[tone]}>
              {tone === 'done' ? <IconCheck /> : tone === 'fail' ? <IconWarn size={15} /> : <IconTodo />}
            </span>
            <span class="fs-check-text">
              <span class="fs-check-main">{c.text}</span>{' '}
              <span class="fs-check-detail">{[c.detail, ticked ? (c.tickWord ?? 'confirmed') : ''].filter(Boolean).join(' · ')}</span>
            </span>
            {c.actions?.map(([label, act]) => (
              <button type="button" class="fs-btn fs-btn-xs" onClick={() => { if (typeof act === 'function') act(); else ui.popup.value = act; }}>{label}</button>
            ))}
            {!c.noTick && (
              <button type="button" class={'fs-tick' + (ticked ? ' is-on' : '')} aria-pressed={ticked ? 'true' : 'false'}
                title={ticked ? 'Ticked: ' + (c.tickWord ?? 'confirmed') : 'Tick to confirm this line'} aria-label={'Confirm: ' + c.text}
                onClick={() => ui.toggleTick(c.key)}>{ticked ? <IconCheck /> : null}</button>
            )}
          </div>
        );
      })}
      <div class="fs-note-sm">For your information: none of these stops Start. A tick is yours, and stays until a new file is loaded or the link drops.</div>
    </div>
  );
}

// ── Left panel: Program ───────────────────────────────────────────────────────

function ProgramPanel() {
  const lines = job.lines.value;
  const m = mode.value;
  const at = atLine.value;
  const sections = rows.value;
  const section = sections[sectionIndex.value];
  const where = section ? [section.name, section.tool !== null ? 'T' + section.tool : ''].filter(Boolean).join(' · ') || (job.file.value ?? '') : (job.file.value ?? 'No job loaded');
  const title = m === 'change' ? `${awaitedSection.value?.name || 'T' + (awaitedSection.value?.tool ?? '?')}, waiting at the tool change`
    : (m === 'alarm' || stoppedShort.value) && at ? where + ', stopped' : where;
  const centre = at || 1;
  const first = Math.max(1, Math.min(centre - 3, lines.length - 6));
  const shown = lines.slice(first - 1, first + 6);
  const next = nextSection.value ?? (at === 0 && sections[1] ? sections[1] : null);
  const notes = programNotes();
  return (
    <div>
      <div class="fs-panel-title">{title}</div>
      <div class="fs-code">
        {shown.length ? shown.map((code, i) => {
          const n = first + i;
          return <div class={'fs-code-line' + (n === at ? ' is-now' : '')}><span class="fs-code-n">{num(n)}</span><span>{code}</span></div>;
        }) : <div class="fs-code-line"><span class="fs-code-n" /><span>No job loaded.</span></div>}
      </div>
      {notes.map(n => (
        <div class="fs-check is-todo">
          <span class="fs-check-icon" role="img" aria-label="note" title="For your information"><IconTodo /></span>
          <span class="fs-check-text"><span class="fs-check-main">{n.text}</span>{' '}<span class="fs-check-detail">{n.detail}</span></span>
        </div>
      ))}
      <div class="fs-note-sm">
        {next ? <>Next tool change at line {num(next.changeLine)}: <span class="fs-mono fs-soft">T{next.tool} M6</span>. </> : sections.length > 1 && at ? <>No more tool changes. </> : null}
        {job.numbered.value ? 'The line is the one the controller reports executing (flight recorder N numbers).'
          : 'Without the flight recorder this is the last line the controller accepted; the cutter can be a few lines behind.'}
      </div>
    </div>
  );
}

// ── Right panel: Recorder ─────────────────────────────────────────────────────

const REASONS: Record<string, string> = {
  timeout: 'the sender went quiet', usb: 'the USB link was lost', network: 'the network link was lost',
  alarm: 'an alarm', reset: 'a reset', reboot: 'the controller restarted', none: '',
};

/** Why the event log can't be read now, or null if it can. */
function eventsBlocked(): string | null {
  if (!connection.connected.value) return 'Not connected, so the event log can\'t be read.';
  const fr = flight.plugin.value;
  if (!fr) return 'This controller has no Flight Recorder plugin, so there is no event log.';
  if (!fr.storage) return 'The plugin found no FRAM on the board, so there is no event log.';
  // After a lost link the controller reads nothing until it has settled; wait for its $I+ answer,
  // and with the recorder on for its start-up queries too ($HELP COMMANDS would swallow the events).
  if (!connection.firmware.value || (flight.enabled.value && flight.watchdog.value === null)) return 'Waiting for the controller to answer.';
  if (job.running.value) return 'The event log is read when no job is running.';
  return null;
}

function eventRow(line: string): { time: string; type: string; text: string; warn: boolean } {
  // [EVENT:812|boot=7|t=1523.410|LIMIT|min=X|max=-|n=1]
  const fields = line.slice(1, -1).split('|');
  const field = (key: string) => (fields.find(f => f.startsWith(key + '=')) || '').slice(key.length + 1);
  const type = fields[3] || '?';
  const count = parseInt(field('n')) || 1;
  const t = parseFloat(field('t'));
  const time = 'boot ' + field('boot') + ' · ' + (isNaN(t) ? '?' : (t >= 3600 ? Math.floor(t / 3600) + ':' : '') + pad(Math.floor(t / 60) % 60) + ':' + pad(Math.floor(t % 60)));
  return { time, type, text: fields.slice(4).filter(f => !f.startsWith('n=')).join('  ') + (count > 1 ? '  ×' + count : ''),
    warn: /ALARM|LINK|LOST|ERROR|RESET|LIMIT|WATCHDOG/i.test(type) };
}

function RecorderPanel() {
  const record = flight.record.value;
  const fr = flight.plugin.value;
  const settings = machine.settings.value;
  const blocked = eventsBlocked();
  const events = flight.events.value.slice().reverse();
  const shown = ui.allEvents.value ? events : events.slice(0, 4);

  // Read the record and the events each time the panel opens, and again once the controller can answer.
  const canRead = blocked === null;
  useEffect(() => { if (canRead) { frReadRecord(); frLoadEvents(); } }, [canRead]);

  const resumable = record && (record.state === 'Stopped' || record.state === 'Retracted') && record.ln > 0 && flight.enabled.value;
  const fileMatches = record && job.lines.value.length > 0 && job.fileId.value === record.job;
  const lineSection = record ? rows.value.find(s => record.ln >= s.start && record.ln <= s.end) : undefined;

  const recordText = !flight.enabled.value ? 'the flight recorder is off (Settings, Flight recorder)'
    : !connection.connected.value ? 'connect to read it'
    : !fr ? 'this controller has no Flight Recorder plugin'
    : !fr.storage ? 'no FRAM on the board'
    : !record ? 'no job recorded yet'
    : record.state === 'Running' ? 'recording'
    : record.state === 'Completed' ? 'kept after the job completed'
    : record.state === 'Idle' ? 'starts with the job'
    : `${record.state.toLowerCase()}${REASONS[record.why] ? ', ' + REASONS[record.why] : ''}`;
  const on = settings[790];
  const linkDrop = on === undefined ? '—' : on === '1'
    ? `after ${settings[791] ?? '?'} s, lift to machine Z −${settings[792] ?? '?'} and stop the spindle`
    : 'nothing: the retract is off ($790 = 0)';
  const wd = flight.watchdog.value;
  return (
    <div class="fs-recorder">
      {resumable && (
        <div class="fs-resume">
          <div class="fs-strong">Stopped at line {num(record!.ln)}{lineSection?.name ? ' in ' + lineSection.name : ''}, with T{record!.tool}.</div>
          <div class="fs-soft fs-small">
            {fileMatches
              ? 'Resume plan: BearSender lifts to the retract height, moves over the start of the line, starts the spindle and comes straight down, then carries on with the file. The dialog shows each move.'
              : 'Load the file it was running to resume it.'}
          </div>
          <button type="button" class="fs-btn-light" onClick={() => frOpenResume()}>{fileMatches ? 'RESUME FROM LINE ' + num(record!.ln) : 'RESUME…'}</button>
        </div>
      )}
      <div class="fs-grid2">
        <span class="fs-dim">Record</span><span>{recordText}</span>
        <span class="fs-dim">Last saved</span><span class="fs-mono">{record && record.ln ? `line ${num(record.ln)} · T${record.tool} · ${record.wcs}` : '—'}</span>
        <span class="fs-dim">Job</span><span>{record && record.job !== '00000000' ? `${fileMatches ? job.file.value + ' · ' : ''}id ${record.job.toLowerCase()}${fileMatches ? '' : ' (not the loaded file)'}` : '—'}</span>
        <span class="fs-dim">If the link drops</span><span>{linkDrop}</span>
        <span class="fs-dim">Undercut tools</span><span>{flight.undercut.value ? 'yes: the controller won\'t lift the tool if the link drops' : 'no, this job lifts straight up'}</span>
        <span class="fs-dim">Watchdog</span><span>{wd === null ? '—' : !wd ? 'not in this firmware' : settings[793] === undefined ? '—' : settings[793] === '0' ? 'off' : settings[793] + ' s'}</span>
        <span class="fs-dim">Controller</span><span>{fr ? `Flight Recorder v${fr.version} · ${fr.storage ? 'FRAM found' : 'no FRAM'}` : connection.connected.value ? 'no Flight Recorder plugin' : 'not connected'}</span>
      </div>
      <div>
        <div class="fs-cap">RECENT EVENTS{flight.eventsReadAt.value ? ' · read ' + clock(flight.eventsReadAt.value) : ''}</div>
        {flight.eventsLoading.value ? <div class="fs-event-empty">Reading the event log…</div>
          : shown.length ? shown.map(line => {
            const e = eventRow(line);
            return (
              <div class="fs-event">
                <span class="fs-event-time fs-mono">{e.time}</span>
                <span class={'fs-event-type fs-mono' + (e.warn ? ' is-warn' : '')}>{e.type}</span>
                <span class="fs-event-text">{e.text}</span>
              </div>
            );
          }) : <div class="fs-event-empty">{blocked ?? 'No events read yet.'}</div>}
        {blocked && shown.length > 0 && <div class="fs-note-sm">{blocked} These are from the last read.</div>}
      </div>
      <div class="fs-row-gap">
        <button type="button" class="fs-btn fs-btn-sm" disabled={!events.length && !!blocked}
          onClick={() => { ui.allEvents.value = !ui.allEvents.value; if (!blocked) frLoadEvents(); }}>{ui.allEvents.value ? 'RECENT EVENTS' : 'FULL EVENT LOG'}</button>
        <button type="button" class="fs-btn fs-btn-sm" onClick={() => ui.openSettings('flight')}>RECORDER SETTINGS</button>
        {ui.allEvents.value && <button type="button" class="fs-btn fs-btn-sm" disabled={!!blocked} onClick={() => frClearEvents()}>CLEAR LOG</button>}
      </div>
    </div>
  );
}

// ── Right panel: Preview, Camera, Console, Macros ─────────────────────────────
//
// These stay mounted, hidden while another tab shows, so the console keeps its place and the 3D view its
// scene. Each fills the panel's height (fs-fill).

function PreviewPanel({ hidden }: { hidden: boolean }) {
  const full = ui.fullView.value;
  return (
    <div class="fs-fill" hidden={hidden && !full}>
      <div class={'fs-view-wrap' + (full ? ' is-full' : '')}>
        <Preview />
        {full && <button type="button" class="fs-btn fs-view-close" onClick={() => { ui.fullView.value = false; }}>CLOSE FULL VIEW</button>}
      </div>
      {!full && <button type="button" class="fs-btn fs-btn-sm fs-mt8 fs-self-start" onClick={() => { ui.fullView.value = true; }}>OPEN FULL 3D VIEW</button>}
    </div>
  );
}

function CameraPanel({ hidden }: { hidden: boolean }) {
  return (
    <div class="fs-fill" hidden={hidden}>
      <div class="fs-panel-box"><Camera /></div>
      <div class="fs-note-sm">
        {camera.device.value === null
          ? 'No camera set up: pick one and press START. BearSender remembers it, and starts it whenever this tab shows.'
          : 'The camera runs only while this tab shows.'}
      </div>
    </div>
  );
}

function ConsolePanel({ hidden }: { hidden: boolean }) {
  return (
    <div class="fs-fill" hidden={hidden}>
      <div class="fs-panel-box"><Console /></div>
    </div>
  );
}

function MacrosPanel({ hidden }: { hidden: boolean }) {
  return (
    <div class="fs-fill" hidden={hidden}>
      <Macros />
    </div>
  );
}

// ── The switchable panels ─────────────────────────────────────────────────────

/** Tabs, and AUTO: while it's on the panel follows the job; picking a tab turns it off and keeps that tab. */
function PanelHead<T extends string>({ label, tabs, current, pick, auto, picked, autoTitle, children }: {
  label: string; tabs: [T, string][]; current: T; pick: (id: T) => void; auto: Signal<boolean>; picked: Signal<T>; autoTitle: string; children?: ComponentChildren;
}) {
  const autoOn = auto.value;
  return (
    <div class="fs-card-head">
      <div role="tablist" aria-label={label} class="fs-tabs">
        {tabs.map(([id, text]) => (
          <button type="button" role="tab" aria-selected={current === id ? 'true' : 'false'} class={current === id ? 'is-on' : ''}
            onClick={() => pick(id)}>{text}</button>
        ))}
      </div>
      <div class="fs-head-end">
        {children}
        <button type="button" class={'fs-auto' + (autoOn ? ' is-on' : '')} aria-pressed={autoOn ? 'true' : 'false'} title={autoTitle}
          onClick={() => { if (autoOn) picked.value = current; auto.value = !autoOn; }}>AUTO</button>
      </div>
    </div>
  );
}

const LEFT_TABS: [ui.LeftPanel, string][] = [['jobs', 'JOBS'], ['program', 'PROGRAM']];

function LeftPanel() {
  const current = leftPanel.value;
  return (
    <section aria-label="Jobs and program" class="fs-card fs-jobs">
      <PanelHead label="Left panel" tabs={LEFT_TABS} current={current} pick={ui.pickLeft} auto={ui.leftAuto} picked={ui.pickedLeft}
        autoTitle="Follow the job: the Program while running, the Jobs list otherwise">
        {current === 'jobs' && <JobsButtons />}
      </PanelHead>
      <div class="fs-card-body">{current === 'jobs' ? <JobsList /> : <ProgramPanel />}</div>
    </section>
  );
}

const TABS: [ui.Panel, string][] = [['setup', 'SETUP'], ['run', 'RUN'], ['recorder', 'RECORDER'], ['preview', 'PREVIEW'], ['camera', 'CAMERA'], ['console', 'CONSOLE'], ['macros', 'MACROS']];

function JobPanel() {
  const current = panel.value;
  return (
    <section aria-label="Job panel" class="fs-card fs-panel">
      <PanelHead label="Panel" tabs={TABS} current={current} pick={ui.pickPanel} auto={ui.auto} picked={ui.pickedPanel}
        autoTitle="Follow the job: Setup before the start and at tool changes; Run while it runs; the Recorder after a stop" />
      <div class="fs-card-body">
        {current === 'setup' && <SetupPanel />}
        {current === 'run' && <RunPanel />}
        {current === 'recorder' && <RecorderPanel />}
        <PreviewPanel hidden={current !== 'preview'} />
        <CameraPanel hidden={current !== 'camera'} />
        <ConsolePanel hidden={current !== 'console'} />
        <MacrosPanel hidden={current !== 'macros'} />
      </div>
    </section>
  );
}

export function JobScreen({ hidden }: { hidden: boolean }) {
  return (
    <main class="fs-screen fs-job" hidden={hidden}>
      {warmupProgress.value ? <WarmupStrip /> : <CurrentJob />}
      <div class="fs-job-row">
        <LeftPanel />
        <JobPanel />
      </div>
    </main>
  );
}

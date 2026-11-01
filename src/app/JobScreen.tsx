// ═══════════════════════════════════════════════
// The job screen: Current Job strip, and two switchable panels: Jobs and Program on the left, the rest on the right
// ═══════════════════════════════════════════════

import type { ComponentChildren } from 'preact';
import { useEffect } from 'preact/hooks';
import type { Signal } from '@preact/signals';
import * as connection from '../stores/connection';
import * as machine from '../stores/machine';
import * as job from '../stores/job';
import * as flight from '../stores/flight';
import * as camera from '../stores/camera';
import * as ui from './ui';
import { mode, panel, leftPanel, scan, atLine, sectionIndex, nextSection, awaitedSection, stoppedShort, toolLabel } from './mode';
import type { ToolSection } from './toolscan';
import { Legacy } from './Legacy';
import { frOpenResume, frLoadEvents, frClearEvents, frReadRecord } from '../flight-recorder';
import { jobId } from '../flight-recorder-resume';
import { IconChevron, IconBell, IconCheck, IconTodo, IconWarn } from './icons';

const num = (v: number) => v.toLocaleString('en-GB');
const mm = (v: number) => (Math.round(v * 1000) / 1000).toLocaleString('en-GB', { maximumFractionDigits: 3 });
const clock = (t: number) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const pad = (n: number) => String(n).padStart(2, '0');

// One muted colour per tool, in the order the tools come up, shared with the progress bar.
const TINTS = [
  { tint: '#5b7fa6', bar: '#26364a' }, { tint: '#a07c45', bar: '#42331f' }, { tint: '#5a9590', bar: '#29403e' },
  { tint: '#8a6aa0', bar: '#3a2d45' }, { tint: '#a0606c', bar: '#45282d' }, { tint: '#6f8f4e', bar: '#2e3a22' },
];

function tintOf(tool: number): { tint: string; bar: string } {
  const order = [...new Set(scan.value.sections.map(s => s.tool))];
  return TINTS[Math.max(0, order.indexOf(tool)) % TINTS.length];
}

// ── Current Job strip ─────────────────────────────────────────────────────────

function jobNow(): string {
  const file = job.file.value;
  if (!file) return 'No job loaded';
  const sections = scan.value.sections;
  const section = sections[sectionIndex.value];
  const where = section ? [section.name, toolLabel(section.tool)].filter(Boolean).join(' · ') : '';
  const m = mode.value;
  if (m === 'running' || m === 'hold') return where || 'Running';
  if (m === 'change') { const s = awaitedSection.value; return 'Waiting for ' + (s ? toolLabel(s.tool) : 'the next tool'); }
  if (m === 'alarm' || stoppedShort.value) return 'Stopped' + (where ? ' in ' + where : '');
  if (job.result.value === 'completed') return 'Completed in ' + job.fmtDuration(job.elapsedMs.value);
  const tools = new Set(sections.map(s => s.tool)).size;
  const last = job.lastJob.value;
  const lastRun = last && last.name === file && last.result === 'completed' ? ' · about ' + job.fmtDuration(last.runtimeMs).slice(0, -3) + ' from the last run' : '';
  return 'Ready · ' + (tools ? tools + (tools === 1 ? ' tool' : ' tools') : 'no tool changes') + ' · ' + num(job.lines.value.length) + ' lines' + lastRun;
}

function CurrentJob() {
  const total = job.lines.value.length;
  const sections = scan.value.sections;
  const done = job.result.value === 'completed';
  const at = done ? total : atLine.value;
  const pct = total ? Math.min(100, at / total * 100) : 0;
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
            {sections.length ? sections.map(s => (
              <div style={{ flex: (s.end - s.start + 1) + ' 1 0', background: tintOf(s.tool).bar }}>T{s.tool}</div>
            )) : <div style={{ flex: '1 1 0' }} />}
          </div>
          <div class="fs-bar-done" style={{ width: pct.toFixed(1) + '%' }} />
        </div>
        <div class="fs-note">Progress by line count. Tool sections from a quick scan for T…M6 (temporary, until the G-code interpreter).</div>
      </div>
      <div class="fs-times">
        <div><div class="fs-cap">ELAPSED</div><div class="fs-time">{job.fmtDuration(job.elapsedMs.value)}</div></div>
        <div title="Time estimates come with run history, in a later step"><div class="fs-cap">LEFT, EST.</div><div class="fs-time is-dim">—</div></div>
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

function toolStatus(k: number, s: ToolSection): { text: string; live: boolean; dim: boolean } {
  const m = mode.value;
  const current = sectionIndex.value;
  if (m === 'change') {
    const awaited = awaitedSection.value;
    if (awaited === s) return { text: 'Load now', live: true, dim: false };
    return k < scan.value.sections.indexOf(awaited!) ? { text: 'Done', live: false, dim: true } : { text: '', live: false, dim: false };
  }
  if (m === 'running' || m === 'hold') {
    if (k < current) return { text: 'Done', live: false, dim: true };
    if (k === current) return { text: 'Cutting', live: true, dim: false };
    return { text: '', live: false, dim: false };
  }
  if (job.result.value === 'completed') return { text: 'Done', live: false, dim: true };
  if (job.result.value && atLine.value) {
    if (k < current) return { text: 'Done', live: false, dim: true };
    if (k === current) return { text: 'Stopped', live: true, dim: false };
    return { text: '', live: false, dim: false };
  }
  if (k === 0 && machine.tool.value === s.tool) return { text: 'In spindle', live: false, dim: false };
  return { text: '', live: false, dim: false };
}

function JobsList() {
  const file = job.file.value;
  const last = job.lastJob.value;
  const sections = scan.value.sections;
  const table = machine.toolTable.value;
  const open = ui.toolsOpen.value;
  const m = mode.value;
  const status = programStatus();
  const lastSame = last && last.name === file && last.result === 'completed';
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
              <span class="fs-c-at fs-mono">{job.startedAt.value !== null && (m === 'running' || m === 'hold' || m === 'change') ? clock(job.startedAt.value) : job.startedAt.value === null ? 'start' : '—'}</span>
              <span class="fs-c-run fs-mono" title={lastSame ? 'Measured on the last run of this file' : 'Measured once the file has run'}>{lastSame ? job.fmtDuration(last!.runtimeMs) : '—'}</span>
              <span class="fs-c-bell" />
            </div>
          )}
          {file && open && sections.map((s, k) => {
            const st = toolStatus(k, s);
            const missing = table !== null && !table.some(e => e.tool === s.tool);
            return (
              <div class={'fs-jobs-row is-tool' + (st.live ? ' is-live' : '') + (st.dim ? ' is-dim' : '')}>
                <span class="fs-c-name fs-tool-name">
                  <span class="fs-tint" style={{ background: tintOf(s.tool).tint }} />
                  <span class="fs-mono fs-tool-num">T{s.tool}</span>
                  <span class="fs-ellipsis">{toolLabel(s.tool).replace(/^T\d+( · )?/, '') || s.name}</span>
                  {missing && <span class="fs-warn" aria-label="not in tool table" title="Not in the tool table"><IconWarn size={13} /></span>}
                </span>
                <span class={'fs-c-status' + (st.text === 'Cutting' ? ' is-go' : '')}>{missing && !st.text ? 'Not in table' : st.text}</span>
                <span class="fs-c-at fs-mono" title={s.changeLine ? 'Tool change at line ' + num(s.changeLine) : ''}>{s.changeLine ? 'L' + num(s.changeLine) : 'start'}</span>
                <span class="fs-c-run fs-mono">—</span>
                <span class="fs-c-bell">
                  {k > 0 && <button type="button" class="fs-bell" disabled title="Sounds at tool changes come in a later step" aria-label={'Sound when T' + s.tool + ' is due'}><IconBell on={false} /></button>}
                </span>
              </div>
            );
          })}
          {!file && !last && <div class="fs-empty">No job loaded yet.</div>}
        </div>
      </div>
      <div class="fs-note">AT is the line each tool starts on, for now. RUNTIME is measured from the last run of the file. Per-tool times, sounds and the queue come in a later step.</div>
    </div>
  );
}

function JobsButtons() {
  const m = mode.value;
  return (
    <>
      <button type="button" class="fs-btn fs-btn-sm" disabled={m === 'running' || m === 'hold' || m === 'change'}
        onClick={() => document.getElementById('fileInput')?.click()}>LOAD JOB</button>
      <button type="button" class="fs-btn fs-btn-sm" disabled title="The queue comes in a later step">ADD TO QUEUE</button>
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
  actions?: [string, ui.Popup][];
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
  if (!machine.offsetsRead.value) return { key, tone: 'todo', text: `Reading work offset ${wcs}…`, actions };
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
  if (tlo === null) return { key, tone: 'todo', text: 'Reading the tool length offset…', actions };
  if (tlo === 0) return { key, tone: 'todo', text: 'Set TLO: measure the tool.', detail: 'the offset is 0', actions };
  const tool = machine.tool.value;
  return { key, tone: 'done', text: `TLO set: ${tool ? 'T' + tool + ', ' : ''}${mm(tlo)} mm`, actions };
}

function toolCheck(): Check {
  const key = 'tool';
  const first = scan.value.sections[0];
  if (!job.file.value) return { key, tone: 'todo', text: 'Tool in the spindle', detail: 'load a program to see its first tool' };
  if (!first) return { key, tone: 'todo', text: 'Check the tool in the spindle', detail: 'the program names no tool' };
  const label = toolLabel(first.tool);
  const tool = machine.tool.value;
  if (tool === first.tool) return { key, tone: 'done', text: label + ' is in the spindle' };
  if (tool === null) return { key, tone: 'todo', text: 'Load ' + label, detail: connection.connected.value ? 'reading the tool in the spindle…' : 'connect to read the tool in the spindle' };
  return { key, tone: 'todo', text: 'Load ' + label, detail: tool === 0 ? 'the controller reports no tool (T0)' : `the spindle has T${tool}` };
}

function toolTableCheck(): Check {
  const key = 'tooltable';
  const tools = [...new Set(scan.value.sections.map(s => s.tool))];
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
  const limits = job.limits.value;
  const travel = [130, 131, 132].map(id => parseFloat(machine.settings.value[id] ?? ''));
  if (!job.file.value || !limits) return { key, tone: 'todo', text: 'Program fits the machine travel', detail: 'load a program to check it', actions, tickWord };
  if (travel.some(isNaN)) {
    return { key, tone: 'todo', text: 'Program fits the machine travel', detail: connection.connected.value ? 'reading the travel ($130–$132)…' : 'connect to read the travel', actions, tickWord };
  }
  if (!machine.offsetsRead.value) return { key, tone: 'todo', text: 'Program fits the machine travel', detail: 'reading the work offsets…', actions, tickWord };
  // Machine travel taken as −$13x to 0, grblHAL's default with homing to the top of each axis.
  const over: string[] = [];
  for (const code of limits.order) {
    const r = limits.perWcs[code], o = machine.offsets.value[code];
    if (!r || !o) continue;
    const axes: [string, boolean, number, number, number][] = [
      ['X', r.hasX, r.xMin + o.x, r.xMax + o.x, travel[0]], ['Y', r.hasY, r.yMin + o.y, r.yMax + o.y, travel[1]], ['Z', r.hasZ, r.zMin + o.z, r.zMax + o.z, travel[2]],
    ];
    for (const [axis, has, lo, hi, len] of axes) {
      if (!has) continue;
      if (lo < -len - 0.001) over.push(`${axis} goes ${mm(-len - lo)} mm past the end of the travel (${code})`);
      if (hi > 0.001) over.push(`${axis} goes ${mm(hi)} mm past machine zero (${code})`);
    }
  }
  const first = limits.order[0];
  const range = first ? limits.perWcs[first] : limits.overall;
  const work = range ? `X ${mm(range.xMin)} to ${mm(range.xMax)}, Y ${mm(range.yMin)} to ${mm(range.yMax)}, Z ${mm(range.zMin)} to ${mm(range.zMax)}` : '';
  return over.length
    ? { key, tone: 'fail', text: 'Program goes outside the machine travel', detail: over.join('; '), actions, tickWord }
    : { key, tone: 'done', text: 'Program fits the machine travel', detail: work, actions, tickWord };
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

function changeChecks(): Check[] {
  const s = awaitedSection.value;
  const sections = scan.value.sections;
  const entry = s && machine.toolTable.value?.find(e => e.tool === s.tool);
  const key = 'change:' + (s ? s.tool + ':' + s.changeLine : '?') + ':';
  const spinning = machine.spindle.value > 0;
  const tlo = machine.tlo.value;
  return [
    { key: key + 'spindle', tone: spinning ? 'fail' : 'done', text: spinning ? `Spindle still turning at ${num(machine.spindle.value)} rpm` : 'Spindle stopped',
      detail: 'tool at machine Z ' + machine.mpos.value.z.toFixed(3) },
    { key: key + 'load', tone: 'todo', text: 'Load ' + (s ? toolLabel(s.tool) : 'the next tool'), detail: entry && entry.pocket ? 'pocket ' + entry.pocket : '' },
    { key: key + 'measure', tone: 'todo', text: 'Measure the tool length', detail: tlo ? `TLO now ${mm(tlo)} mm` : '', actions: [['MEASURE', 'measure']] },
    { key: key + 'resume', tone: 'todo', text: 'Press Resume', detail: s && sections[sections.indexOf(s)]?.name ? sections[sections.indexOf(s)].name + ' starts' : '', noTick: true },
  ];
}

function setupChecks(): Check[] {
  if (mode.value === 'change') return changeChecks();
  return [offsetCheck(), tloCheck(), toolCheck(), toolTableCheck(), travelCheck(), recorderCheck()];
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
            {c.actions?.map(([label, popup]) => (
              <button type="button" class="fs-btn fs-btn-xs" onClick={() => { ui.popup.value = popup; }}>{label}</button>
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
  const sections = scan.value.sections;
  const section = sections[sectionIndex.value];
  const where = section ? [section.name, 'T' + section.tool].filter(Boolean).join(' · ') : (job.file.value ?? 'No job loaded');
  const title = m === 'change' ? `${awaitedSection.value?.name || 'T' + (awaitedSection.value?.tool ?? '?')}, waiting at the tool change`
    : (m === 'alarm' || stoppedShort.value) && at ? where + ', stopped' : where;
  const centre = at || 1;
  const first = Math.max(1, Math.min(centre - 3, lines.length - 6));
  const shown = lines.slice(first - 1, first + 6);
  const next = nextSection.value ?? (at === 0 && sections[1] ? sections[1] : null);
  return (
    <div>
      <div class="fs-panel-title">{title}</div>
      <div class="fs-code">
        {shown.length ? shown.map((code, i) => {
          const n = first + i;
          return <div class={'fs-code-line' + (n === at ? ' is-now' : '')}><span class="fs-code-n">{num(n)}</span><span>{code}</span></div>;
        }) : <div class="fs-code-line"><span class="fs-code-n" /><span>No job loaded.</span></div>}
      </div>
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
  const fileMatches = record && job.lines.value.length > 0 && jobId(job.lines.value) === record.job;
  const lineSection = record ? scan.value.sections.find(s => record.ln >= s.start && record.ln <= s.end) : undefined;

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
// The carried-over panels stay mounted, hidden while another tab shows.

function PreviewPanel({ hidden }: { hidden: boolean }) {
  const full = ui.fullView.value;
  return (
    <div hidden={hidden && !full}>
      <div class={'fs-view-wrap' + (full ? ' is-full' : '')}>
        <Legacy class="fs-view" ids={['vpPanel']} />
        {full && <button type="button" class="fs-btn fs-view-close" onClick={() => { ui.fullView.value = false; }}>CLOSE FULL VIEW</button>}
      </div>
      <button type="button" class="fs-btn fs-btn-sm fs-mt8" onClick={() => { ui.fullView.value = true; }}>OPEN FULL 3D VIEW</button>
      <div class="fs-note-sm">The 3D view from before the rework. Arcs still draw as straight lines until the G-code interpreter lands.</div>
    </div>
  );
}

function CameraPanel({ hidden }: { hidden: boolean }) {
  return (
    <div hidden={hidden}>
      <Legacy class="fs-legacy fs-panel-box fs-cam" ids={['tabpanel-camera']} />
      <div class="fs-note-sm">
        {camera.device.value === null
          ? 'No camera set up: pick one and press START. BearSender remembers it, starts it whenever this tab shows, and AUTO shows it while a job runs.'
          : 'The camera runs only while this tab shows.'}
      </div>
    </div>
  );
}

function ConsolePanel({ hidden }: { hidden: boolean }) {
  return (
    <div hidden={hidden}>
      <Legacy class="fs-legacy fs-panel-box fs-console" ids={['mod-console', 'touchKbdOverlay']} />
    </div>
  );
}

function MacrosPanel({ hidden }: { hidden: boolean }) {
  return (
    <div hidden={hidden}>
      <Legacy class="fs-macros" ids={['mod-macros']} />
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
      {current === 'jobs' ? <JobsList /> : <ProgramPanel />}
    </section>
  );
}

const TABS: [ui.Panel, string][] = [['setup', 'SETUP'], ['recorder', 'RECORDER'], ['preview', 'PREVIEW'], ['camera', 'CAMERA'], ['console', 'CONSOLE'], ['macros', 'MACROS']];

function JobPanel() {
  const current = panel.value;
  return (
    <section aria-label="Job panel" class="fs-card fs-panel">
      <PanelHead label="Panel" tabs={TABS} current={current} pick={ui.pickPanel} auto={ui.auto} picked={ui.pickedPanel}
        autoTitle="Follow the job: Setup before the start and at tool changes; while running the Camera if one is set up, otherwise the Recorder; the Recorder after a stop" />
      {current === 'setup' && <SetupPanel />}
      {current === 'recorder' && <RecorderPanel />}
      <PreviewPanel hidden={current !== 'preview'} />
      <CameraPanel hidden={current !== 'camera'} />
      <ConsolePanel hidden={current !== 'console'} />
      <MacrosPanel hidden={current !== 'macros'} />
    </section>
  );
}

export function JobScreen({ hidden }: { hidden: boolean }) {
  return (
    <main class="fs-screen fs-job" hidden={hidden}>
      <CurrentJob />
      <div class="fs-job-row">
        <LeftPanel />
        <JobPanel />
      </div>
    </main>
  );
}

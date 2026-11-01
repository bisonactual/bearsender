// ═══════════════════════════════════════════════
// The job screen: Current Job strip, Jobs list, and the switchable panel
// ═══════════════════════════════════════════════

import type { ComponentChildren } from 'preact';
import { useEffect } from 'preact/hooks';
import * as connection from '../stores/connection';
import * as machine from '../stores/machine';
import * as job from '../stores/job';
import * as messages from '../stores/messages';
import * as flight from '../stores/flight';
import * as ui from './ui';
import { mode, panel, scan, atLine, sectionIndex, nextSection, awaitedSection, stoppedShort, toolLabel } from './mode';
import type { ToolSection } from './toolscan';
import { Legacy } from './Legacy';
import { sendCmd } from '../connection';
import { sendHome } from '../streaming';
import { frameProgram } from '../gcode';
import { loadToolTable } from '../tooltable';
import { loadOffsets } from '../offsets';
import { frOpenResume, frLoadEvents, frClearEvents, frReadRecord } from '../flight-recorder';
import { jobId } from '../flight-recorder-resume';
import { IconChevron, IconBell, IconCheck, IconTodo, IconUnknown, IconWarn } from './icons';

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

// ── Jobs list ─────────────────────────────────────────────────────────────────

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
    <section aria-labelledby="fs-jobs" class="fs-card fs-jobs">
      <div class="fs-card-head">
        <h2 id="fs-jobs" class="fs-h">JOBS</h2>
        <div class="fs-row-gap">
          <button type="button" class="fs-btn fs-btn-sm" disabled={m === 'running' || m === 'hold' || m === 'change'}
            onClick={() => document.getElementById('fileInput')?.click()}>LOAD JOB</button>
          <button type="button" class="fs-btn fs-btn-sm" disabled title="The queue comes in a later step">ADD TO QUEUE</button>
        </div>
      </div>
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
    </section>
  );
}

// ── Panel: Setup ──────────────────────────────────────────────────────────────

type CheckState = 'ok' | 'todo' | 'unknown';
interface Check { state: CheckState; text: string; detail?: string; action?: string; onAction?: () => void; disabled?: boolean; }

function travelCheck(): Check {
  const limits = job.limits.value;
  const settings = machine.settings.value;
  const travel = [130, 131, 132].map(id => parseFloat(settings[id] ?? ''));
  const text = 'Program fits the machine travel';
  if (!job.file.value || !limits) return { state: 'unknown', text, detail: 'not checked yet: no program loaded' };
  const first = limits.order[0];
  const range = first ? limits.perWcs[first] : limits.overall;
  const work = range ? `X ${mm(range.xMin)} to ${mm(range.xMax)}, Y ${mm(range.yMin)} to ${mm(range.yMax)}, Z ${mm(range.zMin)} to ${mm(range.zMax)}` : '';
  if (travel.some(isNaN)) {
    return { state: 'unknown', text, detail: 'not checked yet: travel $130–$132 not read', action: 'READ', disabled: !connection.connected.value,
      onAction: () => { for (const id of [130, 131, 132]) sendCmd('$' + id); } };
  }
  if (!machine.offsetsRead.value) return { state: 'unknown', text, detail: 'not checked yet: offsets not read', action: 'READ', disabled: !connection.connected.value, onAction: () => loadOffsets() };
  // Machine travel taken as −$13x to 0, grblHAL's default with homing to the top of each axis.
  const over: string[] = [];
  for (const code of limits.order) {
    const r = limits.perWcs[code], o = machine.offsets.value[code];
    if (!r || !o) continue;
    const axes: [string, boolean, number, number, number, number][] = [
      ['X', r.hasX, r.xMin + o.x, r.xMax + o.x, travel[0], 0], ['Y', r.hasY, r.yMin + o.y, r.yMax + o.y, travel[1], 0], ['Z', r.hasZ, r.zMin + o.z, r.zMax + o.z, travel[2], 0],
    ];
    for (const [axis, has, lo, hi, len] of axes) {
      if (!has) continue;
      if (lo < -len - 0.001) over.push(`${axis} ${mm(-len - lo)} mm below the travel (${code})`);
      if (hi > 0.001) over.push(`${axis} ${mm(hi)} mm above machine zero (${code})`);
    }
  }
  return over.length ? { state: 'todo', text: 'Program does not fit the machine travel', detail: over.join(', ') } : { state: 'ok', text, detail: work };
}

function setupChecks(): Check[] {
  const linked = connection.connected.value;
  const sections = scan.value.sections;
  if (mode.value === 'change') {
    const s = awaitedSection.value;
    const entry = s && machine.toolTable.value?.find(e => e.tool === s.tool);
    const next = s ? sections[sections.indexOf(s)] : null;
    return [
      { state: machine.spindle.value === 0 ? 'ok' : 'todo', text: machine.spindle.value === 0 ? 'Spindle stopped' : 'Spindle still turning', detail: 'tool at machine Z ' + machine.mpos.value.z.toFixed(3) },
      { state: 'todo', text: 'Load ' + (s ? toolLabel(s.tool) : 'the next tool'), detail: entry && entry.pocket ? 'pocket ' + entry.pocket : '' },
      { state: 'unknown', text: 'Measure the tool length', detail: 'not checked yet', action: 'MEASURE', onAction: () => { ui.screen.value = 'probing'; } },
      { state: 'todo', text: 'Press Resume', detail: next?.name ? next.name + ' starts' : '' },
    ];
  }
  const wcs = machine.wcs.value;
  const off = machine.offsets.value[wcs];
  const tools = [...new Set(sections.map(s => s.tool))];
  const table = machine.toolTable.value;
  const missing = table ? tools.filter(t => !table.some(e => e.tool === t)) : [];
  const first = sections[0];
  const fr = flight.plugin.value;
  const checks: Check[] = [
    { state: linked ? 'ok' : 'todo', text: linked ? 'Connected' : 'Not connected', detail: linked ? connection.address.value : 'press CONNECT in the top bar' },
    machine.homed.value
      ? { state: 'ok', text: 'Machine homed' }
      : { state: 'todo', text: 'Machine homed', detail: linked ? 'not homed this session' : '', action: 'HOME', disabled: !linked || mode.value !== 'ready' && mode.value !== 'alarm', onAction: () => sendHome() },
    !machine.offsetsRead.value
      ? { state: 'unknown', text: `Work offset ${wcs} set`, detail: 'not checked yet: $# not read', action: 'READ', disabled: !linked, onAction: () => loadOffsets() }
      : off && (off.x || off.y || off.z)
        ? { state: 'ok', text: `Work offset ${wcs} set`, detail: `X ${mm(off.x)} Y ${mm(off.y)} Z ${mm(off.z)}`, action: 'PROBE', onAction: () => { ui.screen.value = 'probing'; } }
        : { state: 'todo', text: `Work offset ${wcs} set`, detail: `${wcs} is all zeros`, action: 'PROBE', onAction: () => { ui.screen.value = 'probing'; } },
    first
      ? machine.tool.value === first.tool
        ? { state: 'ok', text: toolLabel(first.tool) + ' in the spindle', detail: 'length not checked yet', action: 'MEASURE', onAction: () => { ui.screen.value = 'probing'; } }
        : { state: 'todo', text: 'Load ' + toolLabel(first.tool), detail: machine.tool.value === null ? 'the controller has not said which tool is in' : 'T' + machine.tool.value + ' is in the spindle', action: 'MEASURE', onAction: () => { ui.screen.value = 'probing'; } }
      : { state: 'unknown', text: 'Tool in the spindle', detail: 'not checked yet: no T…M6 in the program' },
    table === null
      ? { state: 'unknown', text: tools.length ? `All ${tools.length} tools are in the tool table` : 'Tools are in the tool table', detail: 'not checked yet: $TTLIST not answered', action: 'READ', disabled: !linked, onAction: () => loadToolTable() }
      : missing.length
        ? { state: 'todo', text: `${missing.length} of ${tools.length} tools missing from the tool table`, detail: missing.map(t => 'T' + t).join(', ') }
        : { state: 'ok', text: `All ${tools.length} tools are in the tool table`, detail: tools.map(t => 'T' + t).join(', ') },
    travelCheck(),
    { state: 'todo', text: 'Frame the program', detail: 'optional, traces the outline at Safe Z (set on Setup, Program Limits)', action: 'FRAME', disabled: !linked || !job.file.value || mode.value !== 'ready', onAction: () => frameProgram() },
    fr && fr.storage && flight.enabled.value
      ? { state: 'ok', text: 'Flight recorder ready', detail: `plugin v${fr.version}, FRAM found` }
      : { state: 'todo', text: 'Flight recorder ready', detail: !linked ? 'not connected' : !fr ? 'no Flight Recorder plugin on this controller' : !fr.storage ? 'the plugin found no FRAM' : 'switched off in Settings, Flight recorder' },
  ];
  return checks;
}

function SetupPanel() {
  const checks = setupChecks();
  return (
    <div>
      <div class="fs-panel-title">{mode.value === 'change' ? 'Tool change' : 'Before you start'}</div>
      {checks.map(c => (
        <div class={'fs-check is-' + c.state}>
          <span class="fs-check-icon">{c.state === 'ok' ? <IconCheck /> : c.state === 'todo' ? <IconTodo /> : <IconUnknown />}</span>
          <span class="fs-check-text"><span class="fs-check-main">{c.text}</span> <span class="fs-check-detail">{c.detail}</span></span>
          {c.action && <button type="button" class="fs-btn fs-btn-xs" disabled={c.disabled} onClick={c.onAction}>{c.action}</button>}
        </div>
      ))}
    </div>
  );
}

// ── Panel: Program ────────────────────────────────────────────────────────────

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

// ── Panel: Recorder ───────────────────────────────────────────────────────────

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
              ? 'Resume plan: FlexiSender lifts to the retract height, moves over the start of the line, starts the spindle and comes straight down, then carries on with the file. The dialog shows each move.'
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

// ── Panel: Preview and Messages ───────────────────────────────────────────────

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

function MessagesPanel() {
  const list = messages.list.value;
  return (
    <div>
      {list.length ? list.map(m => (
        <div class="fs-message">
          <span class="fs-message-time fs-mono">{clock(m.at)}</span>
          <span class={'fs-message-text' + (m.kind === 'alarm' || m.kind === 'error' ? ' is-warn' : '')}>{m.text}</span>
        </div>
      )) : <div class="fs-event-empty">No messages yet.</div>}
      <div class="fs-note-sm">Controller messages, alarms, errors and job events. The raw console is in Settings, Console.</div>
    </div>
  );
}

// ── The switchable panel ──────────────────────────────────────────────────────

const TABS: [ui.Panel, string][] = [['setup', 'SETUP'], ['program', 'PROGRAM'], ['recorder', 'RECORDER'], ['preview', 'PREVIEW'], ['messages', 'MESSAGES']];

function JobPanel() {
  const current = panel.value;
  const autoOn = ui.auto.value;
  let body: ComponentChildren = null;
  if (current === 'setup') body = <SetupPanel />;
  if (current === 'program') body = <ProgramPanel />;
  if (current === 'recorder') body = <RecorderPanel />;
  if (current === 'messages') body = <MessagesPanel />;
  return (
    <section aria-label="Job panel" class="fs-card fs-panel">
      <div class="fs-card-head">
        <div role="tablist" aria-label="Panel" class="fs-tabs">
          {TABS.map(([id, label]) => (
            <button type="button" role="tab" aria-selected={current === id ? 'true' : 'false'} class={current === id ? 'is-on' : ''}
              onClick={() => ui.pickPanel(id)}>{label}</button>
          ))}
        </div>
        <button type="button" class={'fs-auto' + (autoOn ? ' is-on' : '')} aria-pressed={autoOn ? 'true' : 'false'}
          title="Follow the job: Setup before the start and at tool changes, Program while running, Recorder after a stop"
          onClick={() => { if (!autoOn) ui.pickedPanel.value = current; ui.auto.value = !autoOn; }}>AUTO</button>
      </div>
      {body}
      <PreviewPanel hidden={current !== 'preview'} />
    </section>
  );
}

export function JobScreen({ hidden }: { hidden: boolean }) {
  return (
    <main class="fs-screen fs-job" hidden={hidden}>
      <CurrentJob />
      <div class="fs-job-row">
        <JobsList />
        <JobPanel />
      </div>
    </main>
  );
}

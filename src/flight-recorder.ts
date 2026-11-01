// ═══════════════════════════════════════════════
// Flight recorder — job record, resume after a lost connection, event log
// ═══════════════════════════════════════════════
//
// Works with the Flight Recorder plugin for grblHAL (github.com/bisonactual/Flight-Recorder).
// With it switched on (Options, or the FLIGHT RECORDER tab) FlexiSender:
//   - stamps each job with $FLIGHT=<job id> and numbers every line N<line>, so the
//     controller keeps a record of the line it is executing
//   - doesn't reset the controller when it connects, and waits for it to answer, since
//     after a lost connection it may still be retracting the tool
//   - offers to resume when it finds a job that was cut short by a lost connection or
//     a controller restart, once the same file is loaded

import { state } from './state';
import { log } from './console';
import { cmdSend, sendCmd } from './connection';
import { lsGet, lsSet, esc } from './ui';
import { streamLines, type SendLine } from './streaming';
import { on as onBus } from './bus';
import { jobId, numberedLine, programLines, modalScan, resumePreamble, resumeStart, ResumeRefused } from './flight-recorder-resume';
import { batch } from '@preact/signals';
import * as flight from './stores/flight';
import * as job from './stores/job';

export interface FlightRecord {
  state: string;      // Idle, Running, Stopped, Retracted, Completed
  why: string;        // none, timeout, usb, network, alarm, reset, reboot
  job: string;
  ln: number;
  boot: number;
  alarm: number;
  tool: number;
  wcs: string;
  flags: number;
}

const FLAG_NO_RETRACT = 0x08;

const REASONS: Record<string, string> = {
  timeout: 'the sender stopped sending while the spindle was on',
  usb: 'the USB connection to the sender was lost',
  network: 'the network connection to the sender was lost',
  alarm: 'an alarm',
  reset: 'a reset',
  reboot: 'the controller restarted (a power cut or a crash)',
  none: 'nothing',
};

// The reasons a job stops on its own, as opposed to the operator stopping it.
const UNEXPECTED = new Set(['timeout', 'usb', 'network', 'reboot']);

let _pluginDetected = false;
let _noStorage = false;
let _version = '';
let _record: FlightRecord | null = null;
let _events: string[] = [];
let _eventsLoading = false;
let _watchdogSupported: boolean | null = null;
let _helpLoading = false;
let _watchdogListed = false;
let _undercut = false;
let _promptedFor = '';
let _toolChecked = false;

let _handshakeTimer: ReturnType<typeof setTimeout> | null = null;
let _handshakeThen: (() => void) | null = null;
let _handshakeStarted = 0;
let _handshakeWaitLogged = false;
let _handshakeAnswered = false;     // the [VER:] line of a $I+ reply has arrived

const HANDSHAKE_RETRY = 2500;   // ms between attempts while the controller doesn't answer
const HANDSHAKE_LIMIT = 90000;  // ms before we give up waiting

/** Copies what this module knows into the flight recorder store, for the job screen. */
function publish(): void {
  batch(() => {
    flight.enabled.value = frEnabled();
    flight.plugin.value = _pluginDetected ? { version: _version, storage: !_noStorage } : null;
    flight.record.value = _record;
    flight.events.value = _events;
    flight.eventsLoading.value = _eventsLoading;
    flight.watchdog.value = _watchdogSupported;
    flight.undercut.value = _undercut;
  });
}

// ── Switching it on ───────────────────────────────────────────────────────────

export function frEnabled(): boolean { return lsGet('fs-fr-enabled', false); }

/** On, and the controller has the plugin with working storage. */
export function frActive(): boolean { return frEnabled() && _pluginDetected && !_noStorage; }

export function frSetEnabled(enabled: boolean): void {
  lsSet('fs-fr-enabled', enabled);
  log('info', enabled ? '✈ Flight recorder on' : '✈ Flight recorder off');
  if (enabled && state.connected && _pluginDetected) queryController();
  renderFlightTab();
}

// ── Connecting ────────────────────────────────────────────────────────────────

// While the controller is settling a lost job it reads no input at all, so a $I+ sent then
// gets no answer. Keep sending it (starting the byte count afresh each time) until one is
// answered, then carry on with the usual start-up. It has to be a real answer, with the
// [VER:] line: the controller empties its input while it settles, and a $I+ cut in half
// there can leave just its newline, which comes back as an ok of its own.
export function frConnectHandshake(then: () => void): void {
  frCancelHandshake();
  _handshakeThen = then;
  _handshakeStarted = Date.now();
  _handshakeWaitLogged = false;
  _handshakeAnswered = false;

  const ask = () => {
    if (!state.connected || !_handshakeThen) return;
    if (Date.now() - _handshakeStarted > HANDSHAKE_LIMIT) {
      log('err', 'Flight recorder: the controller never answered. Carrying on anyway.');
      finishHandshake();
      return;
    }
    if (Date.now() - _handshakeStarted > HANDSHAKE_RETRY && !_handshakeWaitLogged) {
      _handshakeWaitLogged = true;
      log('info', '✈ Waiting for the controller to answer. It may be finishing a retract after the lost connection.');
    }
    state.sentQueue.length = 0;
    state.rxInFlight = 0;
    cmdSend('$I+');
    _handshakeTimer = setTimeout(ask, HANDSHAKE_RETRY);
  };

  _handshakeTimer = setTimeout(ask, 600);
}

function frCancelHandshake(): void {
  if (_handshakeTimer) clearTimeout(_handshakeTimer);
  _handshakeTimer = null;
  _handshakeThen = null;
}

function finishHandshake(): void {
  const then = _handshakeThen;
  frCancelHandshake();
  if (then) then();
  if (frActive()) queryController();
}

/** Reads the record again ($FLIGHT), unless the controller can't answer now. */
export function frReadRecord(): void {
  if (state.connected && _pluginDetected && !_noStorage && !state.running && !_helpLoading && !_handshakeThen) cmdSend('$FLIGHT');
}

/** Clears the event log on the controller ($EVENTSCLEAR). */
export function frClearEvents(): void {
  if (state.connected && _pluginDetected) { sendCmd('$EVENTSCLEAR'); _events = []; renderEvents(); }
}

export function frDisconnected(): void {
  frCancelHandshake();
  flight.eventsReadAt.value = null;
  _pluginDetected = false;
  _noStorage = false;
  _watchdogSupported = null;
  _helpLoading = false;
  _eventsLoading = false;
  renderFlightTab();
}

function queryController(): void {
  cmdSend('$FLIGHT');
  for (const id of [790, 791, 792]) cmdSend('$' + id);
  // Asking for $793 on a build without the watchdog is an error, and the plugin's event
  // log records every error. So look for its test command in the command list first.
  if (_watchdogSupported === null) {
    _helpLoading = true;
    _watchdogListed = false;
    cmdSend('$HELP COMMANDS');
  } else if (_watchdogSupported) cmdSend('$793');
}

// ── Responses ─────────────────────────────────────────────────────────────────

export function frCheckPlugin(line: string): void {
  const match = line.match(/^\[PLUGIN:Flight Recorder( \(no storage\))? v?([\d.]+)\]/);
  if (!match || _pluginDetected) return;
  _pluginDetected = true;
  _noStorage = !!match[1];
  _version = match[2];
  log('info', _noStorage
    ? '✈ Flight Recorder plugin found, but the controller has no FRAM for it, so it is off'
    : '✈ Flight Recorder plugin v' + _version + ' detected');
  renderFlightTab();
}

/** Returns true if the line was used up here and shouldn't go any further. */
export function frIntercept(raw: string, sent?: { line: string }): boolean {
  if (raw === 'ok' || raw.startsWith('error:')) {
    const command = sent ? sent.line : '';
    if (command === '$I+' && _handshakeThen && _handshakeAnswered) finishHandshake();
    if (command.startsWith('$EVENTS') && _eventsLoading) { _eventsLoading = false; renderEvents(); }
    if (command === '$HELP COMMANDS' && _helpLoading) {
      _helpLoading = false;
      _watchdogSupported = _watchdogListed;
      if (_watchdogSupported) cmdSend('$793');
      setTimeout(renderSettings, 0);
    }
    if (/^\$79[0-3]$/.test(command)) setTimeout(renderSettings, 0);
    return false;
  }

  // The command list, only read to see whether the watchdog is there.
  if (_helpLoading && !raw.startsWith('ALARM') && !raw.startsWith('[MSG')) {
    if (raw.startsWith('$WATCHDOGTEST')) _watchdogListed = true;
    return true;
  }

  if (raw.startsWith('[VER:') && _handshakeThen) _handshakeAnswered = true;

  if (raw.startsWith('[FLIGHT:')) {
    _record = parseRecord(raw);
    renderRecord();
    if (_record) maybeOfferResume();
    return false;
  }

  if (raw.startsWith('[EVENT:') && _eventsLoading) { _events.push(raw); return true; }

  // A retract after the sender went quiet: ask for the record so the resume can be offered.
  if ((raw === 'ALARM:80' || raw === 'ALARM:81') && _pluginDetected) setTimeout(() => cmdSend('$FLIGHT'), 300);

  return false;
}

function parseRecord(line: string): FlightRecord | null {
  const fields = line.slice('[FLIGHT:'.length, -1).split('|');
  const values: Record<string, string> = {};
  for (const field of fields.slice(1)) {
    const eq = field.indexOf('=');
    if (eq > 0) values[field.slice(0, eq)] = field.slice(eq + 1);
  }
  if (!values.job) return null;
  return {
    state: fields[0],
    why: values.why || 'none',
    job: values.job.toUpperCase(),
    ln: parseInt(values.ln) || 0,
    boot: parseInt(values.boot) || 0,
    alarm: parseInt(values.alarm) || 0,
    tool: parseInt(values.tool) || 0,
    wcs: values.wcs || 'G54',
    flags: parseInt(values.flags, 16) || 0,
  };
}

// ── Jobs ──────────────────────────────────────────────────────────────────────

/** The loaded file as sent with the recorder on: the job stamp, then every line numbered. */
export function frJobLines(): SendLine[] {
  const lines: SendLine[] = [{ text: '$FLIGHT=' + jobId(state.gcodeLines) + (_undercut ? ',1' : ''), line: 0 }];
  state.gcodeLines.forEach((raw, i) => {
    const text = numberedLine(raw, i + 1);
    if (text) lines.push({ text, line: i + 1 });
  });
  return lines;
}

export function frFileLoaded(_name: string): void {
  _undercut = false;
  const box = document.getElementById('frUndercut') as HTMLInputElement | null;
  if (box) box.checked = false;
  renderRecord();
  // Loading the file a cut short job came from is the cue to offer the resume again.
  if (_record && loadedFileMatches(_record)) {
    _promptedFor = '';
    maybeOfferResume();
  }
}

function recordKey(record: FlightRecord): string {
  return [record.job, record.ln, record.boot, record.state, record.why].join(':');
}

function resumable(record: FlightRecord | null): boolean {
  return !!record && (record.state === 'Stopped' || record.state === 'Retracted') && record.ln > 0;
}

function loadedFileMatches(record: FlightRecord): boolean {
  return state.gcodeLines.length > 0 && jobId(state.gcodeLines) === record.job;
}

function maybeOfferResume(): void {
  if (!frEnabled() || !_record || !resumable(_record) || !UNEXPECTED.has(_record.why) || state.running) return;
  const key = recordKey(_record);
  if (key === _promptedFor) return;
  _promptedFor = key;
  frOpenResume();
}

// ── Resume ────────────────────────────────────────────────────────────────────

interface ResumePlan { preamble: string[]; index: number; first: string; }

function retractZ(): number {
  const depth = parseFloat(state.settingsValues[792] ?? '');
  return isNaN(depth) ? -20 : -depth;
}

function buildPlan(record: FlightRecord): ResumePlan | string {
  try {
    const modes = modalScan(programLines(state.gcodeLines), record.ln);
    const start = resumeStart(state.gcodeLines, record.ln, modes);
    const preamble = resumePreamble(record.job, !!(record.flags & FLAG_NO_RETRACT), modes, retractZ());
    return { preamble, index: start.index, first: start.first };
  } catch (e: any) {
    if (e instanceof ResumeRefused) return e.message;
    throw e;
  }
}

function startResume(record: FlightRecord, plan: ResumePlan): void {
  const line = plan.index + 1;
  const lines: SendLine[] = plan.preamble.map(text => ({ text, line }));
  lines.push({ text: plan.first, line });
  for (let i = plan.index + 1; i < state.gcodeLines.length; i++) {
    const text = numberedLine(state.gcodeLines[i], i + 1);
    if (text) lines.push({ text, line: i + 1 });
  }
  log('info', `✈ Resuming job ${record.job} from line ${line}`);
  closeModal();
  job.started(true, line);
  streamLines(lines, true);
}

function machineState(): string { return (state._prevMachineStateSl || '').toLowerCase(); }

export function frOpenResume(): void {
  const modal = document.getElementById('frModal');
  const body = document.getElementById('frModalBody');
  if (!modal || !body || !_record) return;
  const record = _record;
  _toolChecked = false;

  const how = record.state === 'Retracted'
    ? `The tool was lifted to machine Z ${retractZ().toFixed(1)} and the spindle stopped.`
    : 'The tool was <b>not</b> lifted clear. Make sure it is clear of the work before going on.';
  const summary =
    `<div class="fr-summary">Job <b>${esc(record.job)}</b> stopped at line <b>${record.ln}</b> because ` +
    `${esc(REASONS[record.why] || record.why)}${record.why === 'alarm' ? ' (ALARM:' + record.alarm + ')' : ''}. ${how}</div>`;

  if (!loadedFileMatches(record)) {
    body.innerHTML = summary +
      `<div class="fr-step"><div class="fr-step-title">Open the file it was running</div>` +
      `<div class="fr-step-text">${state.gcodeLines.length ? 'The file that is loaded is a different one. ' : ''}` +
      `Open the same G-code file and this will carry on from there.</div>` +
      `<div class="fr-step-actions"><button class="tb-btn primary" data-fr="open">📂 OPEN FILE</button></div></div>` +
      `<div class="fr-modal-actions"><button class="tb-btn danger" data-fr="discard">DISCARD RECORD</button>` +
      `<div style="flex:1"></div><button class="tb-btn" data-fr="close">NOT NOW</button></div>`;
    wireModal(record, null);
    modal.style.display = '';
    return;
  }

  const plan = buildPlan(record);
  const file = document.getElementById('fileName')?.textContent || 'the loaded file';
  const toolText = record.tool
    ? `The job was using <b>T${record.tool}</b>. Check that tool is in the spindle, with its length offset set.`
    : 'Check the right tool is in the spindle, with its length offset set.';
  const planHtml = typeof plan === 'string'
    ? `<div class="fr-refused">This job can't be resumed automatically: ${esc(plan)}.</div>`
    : `<pre class="fr-plan">${plan.preamble.map(esc).join('\n')}\n<span class="fr-plan-first">${esc(plan.first)}</span>   ← then on from here</pre>`;

  body.innerHTML = summary +
    `<div class="fr-step"><div class="fr-step-title">1. Clear the alarm</div>` +
    `<div class="fr-step-text">Unlock, or home if it needs it (always after a power cut). ` +
    `Machine: <span id="frWizMachine" class="fr-machine-state"></span></div>` +
    `<div class="fr-step-actions"><button class="tb-btn" data-fr="unlock">🔓 UNLOCK</button>` +
    `<button class="tb-btn" data-fr="home">⌂ HOME</button></div></div>` +
    `<div class="fr-step"><div class="fr-step-title">2. Check the tool</div>` +
    `<div class="fr-step-text">${toolText}</div>` +
    `<label class="fr-toggle fr-check"><input type="checkbox" data-fr="tool"> Tool checked</label></div>` +
    `<div class="fr-step"><div class="fr-step-title">3. Resume ${esc(file)} from line ${record.ln}</div>` +
    `<div class="fr-step-text">FlexiSender goes up to the retract height, over the start of the line, ` +
    `starts the spindle and comes straight down, then carries on with the file:</div>${planHtml}</div>` +
    `<div class="fr-modal-actions"><button class="tb-btn danger" data-fr="discard">DISCARD RECORD</button>` +
    `<div style="flex:1"></div><button class="tb-btn" data-fr="close">NOT NOW</button>` +
    `<button class="tb-btn success" data-fr="start" disabled>▶ RESUME</button></div>`;
  wireModal(record, typeof plan === 'string' ? null : plan);
  updateResumeDialog();
  modal.style.display = '';
}

function wireModal(record: FlightRecord, plan: ResumePlan | null): void {
  const body = document.getElementById('frModalBody')!;
  const on = (name: string, fn: (el: HTMLElement) => void) => {
    const el = body.querySelector<HTMLElement>(`[data-fr="${name}"]`);
    if (el) el.addEventListener(el.tagName === 'INPUT' ? 'change' : 'click', () => fn(el));
  };
  on('open', () => document.getElementById('fileInput')?.click());
  on('discard', () => { sendCmd('$FLIGHTCLEAR'); closeModal(); });
  on('close', () => closeModal());
  on('unlock', () => sendCmd('$X'));
  on('home', () => sendCmd('$H'));
  on('tool', el => { _toolChecked = (el as HTMLInputElement).checked; updateResumeDialog(); });
  on('start', () => { if (plan && readyToResume()) startResume(record, plan); });
}

function readyToResume(): boolean {
  return state.connected && !state.running && machineState() === 'idle' && _toolChecked;
}

/** Keeps the machine state and the RESUME button up to date while the dialog is open. */
function updateResumeDialog(): void {
  const modal = document.getElementById('frModal');
  if (!modal || modal.style.display === 'none') return;
  const machine = document.getElementById('frWizMachine');
  if (machine) {
    const s = machineState() || '—';
    machine.textContent = s.toUpperCase() + (s === 'idle' ? ' ✓' : '');
    machine.className = 'fr-machine-state ' + (s === 'idle' ? 'ok' : s === 'alarm' ? 'bad' : '');
  }
  const start = document.querySelector<HTMLButtonElement>('#frModalBody [data-fr="start"]');
  if (start) start.disabled = !readyToResume();
}

function closeModal(): void {
  const modal = document.getElementById('frModal');
  if (modal) modal.style.display = 'none';
}

// ── The FLIGHT RECORDER tab ───────────────────────────────────────────────────

export function renderFlightTab(): void {
  const enabled = frEnabled();
  for (const id of ['frTabToggleBtn']) {
    const btn = document.getElementById(id);
    if (btn) { btn.textContent = enabled ? 'ON' : 'OFF'; btn.classList.toggle('success', enabled); }
  }
  const option = document.getElementById('optFlightRecorder') as HTMLInputElement | null;
  if (option) option.checked = enabled;

  const badge = document.getElementById('frTabStatusBadge');
  if (badge) {
    let text = 'NOT CONNECTED', cls = '';
    if (state.connected && _pluginDetected && !_noStorage) { text = 'PLUGIN v' + _version; cls = 'active'; }
    else if (state.connected && _noStorage) text = 'NO FRAM ON THE BOARD';
    else if (state.connected) text = 'NO PLUGIN FOUND';
    badge.textContent = text;
    badge.className = 'ez-status-badge ' + cls;
  }
  const notice = document.getElementById('frPluginNotice');
  if (notice) notice.style.display = _pluginDetected && !_noStorage ? 'none' : '';

  renderRecord();
  renderSettings();
  renderEvents();
}

function renderRecord(): void {
  publish();
  const el = document.getElementById('frRecord');
  if (!el) return;
  if (!_record) {
    el.innerHTML = `<div class="fr-empty">${state.connected && _pluginDetected ? 'No job recorded yet.' : 'Connect to read the record.'}</div>`;
    return;
  }
  const record = _record;
  const matches = loadedFileMatches(record);
  const rows: [string, string][] = [
    ['State', `<b>${esc(record.state)}</b>`],
    ['Why', esc(record.state === 'Running' || record.state === 'Completed' || record.state === 'Idle' ? '—' : REASONS[record.why] || record.why)],
    ['Job', record.job === '00000000' ? '—' : esc(record.job) + (state.gcodeLines.length
      ? (matches ? ' <span class="fr-good">(the loaded file)</span>' : ' <span class="fr-dim">(not the loaded file)</span>') : '')],
    ['Line', String(record.ln || '—')],
    ['Tool / offset', 'T' + record.tool + ' / ' + esc(record.wcs)],
    ['Boot', String(record.boot)],
  ];
  el.innerHTML = `<table class="fr-table">${rows.map(([k, v]) => `<tr><td class="fr-key">${k}</td><td>${v}</td></tr>`).join('')}</table>` +
    `<div class="fr-row-actions">` +
    `<button class="tb-btn success" id="frResumeBtn" ${resumable(record) ? '' : 'disabled'}>▶ RESUME…</button>` +
    `<button class="tb-btn danger" id="frClearBtn">DISCARD</button></div>`;
  document.getElementById('frResumeBtn')?.addEventListener('click', () => { _promptedFor = recordKey(record); frOpenResume(); });
  document.getElementById('frClearBtn')?.addEventListener('click', () => sendCmd('$FLIGHTCLEAR'));
}

interface SettingRow { id: number; name: string; unit: string; help: string; kind: 'bool' | 'number'; }

const SETTINGS: SettingRow[] = [
  { id: 790, name: 'Retract when the sender is lost', unit: '', kind: 'bool',
    help: 'Lift the tool straight up and stop the spindle if the sender goes quiet with the spindle on.' },
  { id: 791, name: 'Sender lost after', unit: 's', kind: 'number',
    help: 'How long the machine can sit with nothing to do and the spindle on before it retracts. Dwells don\'t count.' },
  { id: 792, name: 'Retract to', unit: 'mm below machine zero', kind: 'number',
    help: 'Machine Z, measured down from the top of the axis (never from work zero).' },
  { id: 793, name: 'Watchdog', unit: 's', kind: 'number',
    help: 'Resets the controller, which stops the spindle, if it hangs for this long. 3 to 10, 0 is off. Takes effect at the next restart.' },
];

function renderSettings(): void {
  publish();
  const el = document.getElementById('frSettings');
  if (!el) return;
  if (!state.connected || !_pluginDetected || _noStorage) {
    el.innerHTML = '<div class="fr-empty">Connect to a controller with the plugin to change these.</div>';
    return;
  }
  el.innerHTML = SETTINGS.filter(s => s.id !== 793 || _watchdogSupported).map(s => {
    const value = state.settingsValues[s.id] ?? '';
    const input = s.kind === 'bool'
      ? `<label class="fr-toggle"><input type="checkbox" data-fr-setting="${s.id}" ${value === '1' ? 'checked' : ''}> On</label>`
      : `<input class="limits-safe-input fr-number" type="number" step="any" data-fr-setting="${s.id}" value="${esc(value)}">` +
        `<span class="fr-unit">${esc(s.unit)}</span><button class="tb-btn" data-fr-write="${s.id}">WRITE</button>`;
    return `<div class="fr-setting"><div class="fr-setting-name">${esc(s.name)} <span class="fr-dim">$${s.id}</span></div>` +
      `<div class="fr-setting-help">${esc(s.help)}</div><div class="fr-setting-input">${input}</div></div>`;
  }).join('') + (_watchdogSupported === false
    ? '<div class="fr-dim" style="margin-top:6px">This firmware has no watchdog. The _FR_WD builds have it.</div>' : '');

  const write = (id: number, value: string) => { sendCmd('$' + id + '=' + value); cmdSend('$' + id); };
  el.querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-fr-setting]').forEach(box =>
    box.addEventListener('change', () => write(parseInt(box.dataset.frSetting!), box.checked ? '1' : '0')));
  el.querySelectorAll<HTMLButtonElement>('[data-fr-write]').forEach(btn => btn.addEventListener('click', () => {
    const id = parseInt(btn.dataset.frWrite!);
    const input = el.querySelector<HTMLInputElement>(`input[data-fr-setting="${id}"]`);
    if (input && input.value.trim() !== '') write(id, input.value.trim());
  }));
}

function renderEvents(): void {
  publish();
  if (!_eventsLoading && _events.length) flight.eventsReadAt.value = Date.now();
  const el = document.getElementById('frEvents');
  if (!el) return;
  if (_eventsLoading) { el.innerHTML = '<div class="fr-empty">Reading…</div>'; return; }
  if (!_events.length) {
    el.innerHTML = '<div class="fr-empty">Press ↻ to read the last 100 events from the controller.</div>';
    return;
  }
  const rows = _events.slice().reverse().map(line => {
    // [EVENT:812|boot=7|t=1523.410|LIMIT|min=X|max=-|n=1]
    const fields = line.slice(1, -1).split('|');
    const field = (key: string) => (fields.find(f => f.startsWith(key + '=')) || '').slice(key.length + 1);
    const type = fields[3] || '?';
    const details = fields.slice(4).filter(f => !f.startsWith('n=')).join('  ');
    const count = parseInt(field('n')) || 1;
    return `<tr><td>${esc(field('boot'))}</td><td>${esc(field('t'))}</td><td class="fr-event-${esc(type.toLowerCase())}">${esc(type)}</td>` +
      `<td>${esc(details)}</td><td>${count > 1 ? '×' + count : ''}</td></tr>`;
  }).join('');
  el.innerHTML = `<table class="fr-table fr-events"><tr><th>Boot</th><th>Time (s)</th><th>Event</th><th></th><th></th></tr>${rows}</table>`;
}

/** Reads the last 100 events from the controller, unless it can't answer now. */
export function frLoadEvents(): void {
  if (!state.connected || !_pluginDetected || _noStorage || _eventsLoading || state.running) return;
  _events = [];
  _eventsLoading = true;
  renderEvents();
  sendCmd('$EVENTS=100');
}

export function initFlightRecorderTab(): void {
  const on = (id: string, fn: () => void) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
  on('frTabToggleBtn', () => frSetEnabled(!frEnabled()));
  on('frTabRefreshBtn', () => { if (state.connected && _pluginDetected) queryController(); });
  on('frEventsRefreshBtn', () => frLoadEvents());
  on('frEventsClearBtn', () => { if (state.connected && _pluginDetected) { sendCmd('$EVENTSCLEAR'); _events = []; renderEvents(); } });
  on('frModalClose', () => closeModal());

  const option = document.getElementById('optFlightRecorder') as HTMLInputElement | null;
  if (option) option.addEventListener('change', () => frSetEnabled(option.checked));
  const undercut = document.getElementById('frUndercut') as HTMLInputElement | null;
  if (undercut) undercut.addEventListener('change', () => { _undercut = undercut.checked; publish(); });

  onBus('status', ['state'], () => updateResumeDialog());
  renderFlightTab();
}

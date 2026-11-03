// ═══════════════════════════════════════════════
// Flight recorder — job record, resume after a lost connection, event log
// ═══════════════════════════════════════════════
//
// Works with the Flight Recorder plugin for grblHAL (github.com/bisonactual/Flight-Recorder).
// With it switched on (Options, or the FLIGHT RECORDER tab) FlexiSender:
//   - stamps each job with $FLIGHT=<job id> and numbers every line N<line>, so the
//     controller keeps a record of the line it is executing. The stamp goes on its own, and the
//     lines only once it is accepted; a refused stamp sends none of them.
//   - doesn't reset the controller when it connects; the command layer waits for it to
//     answer, since after a lost connection it may still be retracting the tool
//   - offers to resume when it finds a job that was cut short by a lost connection or
//     a controller restart, once the same file is loaded

import { log } from './console';
import { sendCmd } from './connection';
import * as command from './command';
import { lsGet, lsSet, esc } from './ui';
import { streamLines, type SendLine } from './streaming';
import { errorText } from './errors';
import { jobId, numberedLine, resumeState, describeState, resumePreamble, resumeStart, ResumeRefused, type Lift } from './flight-recorder-resume';
import type { ModalState } from './gcode/index';
import { batch, effect, untracked } from '@preact/signals';
import * as flight from './stores/flight';
import * as messages from './stores/messages';
import * as job from './stores/job';
import * as machine from './stores/machine';
import * as connection from './stores/connection';
import * as options from './stores/options';
import * as starts from './stores/starts';
import { context, programText, modesFromWords, wcsFromWords } from './stores/program';
import { loadOffsets } from './offsets';
import { loadToolTable } from './tooltable';
import { untilProgramEnd } from './streaming';

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
let _undercut = false;
let _promptedFor = '';
let _toolChecked = false;

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
  if (enabled && connection.connected.peek() && _pluginDetected) queryController().catch(ignoreFailed);
  renderFlightTab();
}

function ignoreFailed(e: unknown): void { if (!(e instanceof command.CommandFailed)) throw e; }

// ── Connecting ────────────────────────────────────────────────────────────────

/** After $I+ on connecting: the record and the settings, when the plugin is there and on. */
export async function frConnected(): Promise<void> {
  if (frActive()) await queryController();
}

/** Reads the record again ($FLIGHT), unless a job is running. */
export function frReadRecord(): void {
  if (connection.connected.peek() && _pluginDetected && !_noStorage && !job.running.peek()) command.send('$FLIGHT').catch(ignoreFailed);
}

/** Clears the event log on the controller ($EVENTSCLEAR). */
export function frClearEvents(): void {
  if (connection.connected.peek() && _pluginDetected) { sendCmd('$EVENTSCLEAR'); _events = []; renderEvents(); }
}

export function frDisconnected(): void {
  flight.eventsReadAt.value = null;
  _pluginDetected = false;
  _noStorage = false;
  _watchdogSupported = null;
  _eventsLoading = false;
  renderFlightTab();
}

/** The record, the retract settings and, where the firmware has it, the watchdog. */
async function queryController(): Promise<void> {
  // All in flight at once; each reply comes back to its own command. Asking for $793 on a build
  // without the watchdog is an error, and the plugin's event log records every error. So look for
  // its test command in the command list first.
  const replies = await Promise.all([
    command.send('$FLIGHT'),
    ...[790, 791, 792].map(id => command.send('$' + id)),
    _watchdogSupported === null ? command.send('$HELP COMMANDS') : Promise.resolve(null),
  ]);
  const listing = replies[replies.length - 1];
  if (listing) _watchdogSupported = listing.lines.some(line => line.startsWith('$WATCHDOGTEST'));
  if (_watchdogSupported) await command.send('$793');
  renderSettings();
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

// The record comes back in the reply to every $FLIGHT command: the read, the job stamp
// ($FLIGHT=<job id>, a line of the job) and $FLIGHTCLEAR.
command.onReply(reply => {
  if (!reply.command.toUpperCase().startsWith('$FLIGHT')) return;
  const line = reply.lines.find(l => l.startsWith('[FLIGHT:'));
  if (!line) return;
  _record = parseRecord(line);
  renderRecord();
  if (_record) maybeOfferResume();
});

// A retract after the sender went quiet: ask for the record so the resume can be offered. The
// plugin emptied the controller's input when it started the retract, so the command layer gets
// the line in step again first, and this goes after that.
command.on('alarm', raw => {
  if ((raw === 'ALARM:80' || raw === 'ALARM:81') && _pluginDetected) command.send('$FLIGHT').catch(ignoreFailed);
});

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

/** The job stamp, sent and answered before any line of the job (streaming.ts). */
export function frJobStamp(): string {
  return '$FLIGHT=' + jobId(job.lines.peek()) + (_undercut ? ',1' : '');
}

/** The loaded file as sent with the recorder on, after the stamp: every line numbered. */
export function frJobLines(): SendLine[] {
  const lines: SendLine[] = [];
  job.lines.peek().forEach((raw, i) => {
    const text = numberedLine(raw, i + 1);
    if (text) lines.push({ text, line: i + 1 });
  });
  return lines;
}

export function frFileLoaded(_name: string): void {
  _undercut = false;
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
  return job.lines.peek().length > 0 && jobId(job.lines.peek()) === record.job;
}

function maybeOfferResume(): void {
  if (!frEnabled() || !_record || !resumable(_record) || !UNEXPECTED.has(_record.why) || job.running.peek()) return;
  const key = recordKey(_record);
  if (key === _promptedFor) return;
  _promptedFor = key;
  frOpenResume();
}

// ── Resume ────────────────────────────────────────────────────────────────────

interface ResumePlan { preamble: string[]; index: number; first: string; modes: string; lift: string; liftNote: string | null; }
/** A plan; or why there's none yet (waiting), or none built on what is known now (held: yellow, with the
 *  way to fresh data), or none at all (refused). */
type PlanResult = ResumePlan | { waiting: string } | { held: string } | { refused: string };

/** The recorder's own retract height, $792 mm below machine zero. */
function retractZ(): number {
  const depth = parseFloat(machine.settings.peek()[792] ?? '');
  return isNaN(depth) ? -20 : -depth;
}

/** The resume's lift height in machine Z: the option's mm below the top of Z travel, no higher than the
 *  travel goes (stores/machine.ts zTravel: machine zero is the top, unless Z homes down to an origin at
 *  home, when the top is the far end). With the travel settings not read, machine zero is taken as the top. */
function lift(): { z: number; note: string | null } {
  const t = machine.zTravel.value, mm = options.resumeLiftMm.value;
  if (!t) return { z: -mm, note: 'The Z travel settings ($21 $22 $23 $27 $132) aren\'t read yet, so the lift takes machine zero as the top of Z.' };
  return { z: Math.min(t.top - mm, t.max), note: null };
}

/** The modes the job started from, kept at its Start in this browser, and what the dialog says of them.
 *  The kept $G words give the modes, the spindle, the coolant and the feed; the offsets, G92 and the tool
 *  length aren't in them, and come from the controller as it is now. */
function jobStart(record: FlightRecord): { words: string[] | null; note: string; known: boolean } {
  const kept = starts.forJob(record.job);
  if (kept?.modes?.length) {
    const used = kept.modes.filter(w => /^(G(17|18|19|20|21|90|91|91\.1|93|94|98|99|5[4-9](\.\d)?)|M[3-5789]|[FS][\d.]+)$/.test(w) && !/^[FS]0\.?$/.test(w)).join(' ');
    return { words: kept.modes, known: true,
      note: `Read from what the job started in, ${used}, kept when it was started at ${new Date(kept.at).toLocaleTimeString('en-GB')} on ${new Date(kept.at).toLocaleDateString('en-GB')}. ` +
        'The work offsets, G92 and the tool length aren\'t kept with it: they are the controller\'s as read now.' };
  }
  return { words: null, known: false, note: kept
    ? 'When this job was started the controller didn\'t answer $G, so the modes it started in aren\'t known: the plan assumes G21 G90 G17 G94. Check them against the file\'s first lines.'
    : 'This browser has no record of the modes this job started in (it was started from another PC or browser, or before BearSender kept them): the plan assumes G21 G90 G17 G94. Check them against the file\'s first lines.' };
}

// The interpreter's state at the resume line, for the context it was read with: the plan is shown and
// rebuilt as the offsets, the tool length and the machine's Z change, and reading 28,000 moves again for
// each would be slow.
let _stateCache: { key: string; s: ModalState | string } | null = null;

function resumeModal(record: FlightRecord): ModalState | string {
  // The lines as they were sent, read with the controller's offsets and tool length as they are now,
  // from the modes the job started in, and not from where the machine is now: the job started from
  // somewhere else, so the start stays unknown.
  const ctx = context(false);
  delete ctx.initialModes;
  const start = jobStart(record);
  const modes = modesFromWords(start.words), wcs = wcsFromWords(start.words);
  if (modes) ctx.initialModes = modes;
  if (wcs) ctx.activeWorkOffset = wcs;
  const key = record.job + ':' + record.ln + ':' + JSON.stringify(ctx);
  if (_stateCache?.key === key) return _stateCache.s;
  let s: ModalState | string;
  try { s = resumeState(programText(job.lines.peek()), record.ln, ctx); }
  catch (e) { if (!(e instanceof ResumeRefused)) throw e; s = e.message; }
  _stateCache = { key, s };
  return s;
}

let _offsetsAsked = false;
let _pressing = false;   // RESUME is reading $# and $TTLIST again

/** The plan from what is known now. `tableRead` is how RESUME's fresh $TTLIST went: null when it came
 *  in, why not when it didn't, undefined before RESUME. */
function buildPlan(record: FlightRecord, tableRead?: string | null): PlanResult {
  if (!connection.connected.peek()) return { waiting: 'Connect to the controller: the moves back in show here once its offsets and tool length are read.' };
  // The moves back in go to machine positions, which take the work offsets and the tool length: the plan
  // waits for this connection's $# (the record can come first).
  if (!machine.offsetsRead.value || !machine.offsets.value[record.wcs]) {
    if (!_offsetsAsked) { _offsetsAsked = true; loadOffsets(); }
    return { waiting: machine.stateName.value === 'alarm'
      ? 'The work offsets and the tool length are read after homing or UNLOCK (the controller refuses $# in an alarm); the moves back in show here once they are in.'
      : 'Reading the work offsets and the tool length from the controller ($#); the moves back in show here once they are in.' };
  }
  const s = resumeModal(record);
  if (typeof s === 'string') return { refused: s };
  // Where the file has a G43 H in force, the way back in is worked out from that tool's length in the
  // table: a table that didn't read again leaves it on the old one, which may have changed.
  if (tableRead && s.lengthOffset.mode === 'G43' && s.lengthOffset.h !== null)
    return { held: `The tool table didn't read ($TTLIST: ${tableRead}), and the way back in uses T${s.lengthOffset.h}'s length from it (G43 H${s.lengthOffset.h} at this line), so nothing was sent: with an old length it would come down to the wrong height. Press RESUME to read it again.` };
  try {
    const start = resumeStart(job.lines.peek(), record.ln, s.motion);
    const l = lift();
    const way: Lift = { liftZ: l.z, currentZ: machine.mpos.value.z };
    const preamble = resumePreamble(record.job, !!(record.flags & FLAG_NO_RETRACT), s, way);
    const across = Math.max(way.liftZ, way.currentZ).toFixed(3);
    const liftText = way.currentZ < way.liftZ - 0.0005
      ? `up from machine Z ${way.currentZ.toFixed(3)} to ${way.liftZ.toFixed(3)}, then across there`
      : `Z stays at machine Z ${way.currentZ.toFixed(3)}, above the lift height ${way.liftZ.toFixed(3)}, and crosses at ${across}`;
    return { preamble, index: start.index, first: start.first, modes: describeState(s), lift: liftText, liftNote: l.note };
  } catch (e) {
    if (e instanceof ResumeRefused) return { refused: e.message };
    throw e;
  }
}

function isPlan(p: PlanResult): p is ResumePlan { return 'preamble' in p; }

const yellow = (text: string) => `<div class="fr-step-text" style="color:var(--yellow)">${esc(text)}</div>`;

function planHtml(record: FlightRecord, plan: PlanResult): string {
  const start = jobStart(record);
  const modesNote = start.known ? `<div class="fr-step-text">${esc(start.note)}</div>` : yellow(start.note);
  if ('waiting' in plan) return `<div class="fr-step-text">${esc(plan.waiting)}</div>`;
  if ('held' in plan) return yellow(plan.held) + modesNote;
  if ('refused' in plan) return `<div class="fr-refused">This job can't be resumed automatically: ${esc(plan.refused)}.</div>` + modesNote;
  return modesNote + (plan.liftNote ? yellow(plan.liftNote) : '') +
    `<div class="fr-step-text">The program's state before line ${record.ln}, read by the interpreter: ${esc(plan.modes)}. The first move: ${esc(plan.lift)}.</div>` +
    `<pre class="fr-plan">${plan.preamble.map(esc).join('\n')}\n<span class="fr-plan-first">${esc(plan.first)}</span>   ← then on from here</pre>`;
}

/** Puts the plan as it would be sent now into the open dialog. */
function renderPlan(plan?: PlanResult): void {
  const modal = document.getElementById('frModal'), el = document.getElementById('frPlan');
  const record = _record;
  if (!modal || modal.style.display === 'none' || !el || !record || !loadedFileMatches(record)) return;
  if (_pressing) return;
  el.innerHTML = planHtml(record, plan ?? buildPlan(record));
}

// While the dialog is open the plan follows what it is built from, so what it shows is what Resume sends.
effect(() => {
  void machine.offsets.value; void machine.offsetsRead.value; void machine.tlo.value; void machine.tloVector.value;
  void machine.toolTable.value; void machine.settings.value; void machine.mpos.value.z; void machine.modal.value;
  void connection.connected.value; void options.resumeLiftMm.value; void options.runAfterM30.value; void starts.kept.value;
  untracked(() => renderPlan());
});

// RESUME's request, while it reads $# and $TTLIST: NOT NOW (closing the dialog) withdraws it, and Stop,
// RESET, a reset or the link going revoke it (command.intent). A withdrawn request sends nothing.
let _request: object | null = null;

/** RESUME: the offsets, the tool length and the tool table are read again ($#, $TTLIST), the plan is
 *  built from them and shown, and that is what goes, if the request still stands. */
async function pressResume(record: FlightRecord): Promise<void> {
  if (_pressing || !readyToResume()) return;
  _pressing = true;
  const request = _request = {}, live = command.intent(), lines = job.lines.peek();
  updateResumeDialog();
  const el = document.getElementById('frPlan');
  if (el) el.insertAdjacentHTML('afterbegin', '<div class="fr-step-text">Reading the offsets, the tool length and the tool table again ($#, $TTLIST)…</div>');
  const read = await loadOffsets();
  const tableRead = await loadToolTable();
  _pressing = false;
  if (_request !== request || !live() || _record !== record || job.lines.peek() !== lines) {
    log('info', '✈ Resume: nothing was sent. ' + (_request !== request ? 'NOT NOW closed the dialog' : !live() ? 'Stop, RESET, a reset or the link going came' : 'the record or the loaded file changed') + ' while $# and $TTLIST were read.');
    updateResumeDialog();
    return;
  }
  _request = null;
  _stateCache = null;
  const plan: PlanResult = read ? buildPlan(record, tableRead) : { held: 'The controller didn\'t answer $#, so the offsets and the tool length aren\'t known now, and nothing was sent. Press RESUME to read them again.' };
  renderPlan(plan);
  updateResumeDialog();
  if (!isPlan(plan) || !readyToResume()) return;
  log('info', `✈ Resume plan from line ${record.ln}, built now: ${plan.modes}; the first move: ${plan.lift}; ` +
    `sending ${plan.preamble.join(' | ')} | ${plan.first}`);
  startResume(record, plan);
}

function startResume(record: FlightRecord, plan: ResumePlan): void {
  const line = plan.index + 1;
  // The preamble starts with the job stamp, which goes on its own and must be accepted first.
  const [stamp, ...moves] = plan.preamble;
  const lines: SendLine[] = moves.map(text => ({ text, line }));
  lines.push({ text: plan.first, line });
  for (let i = plan.index + 1; i < job.lines.peek().length; i++) {
    const text = numberedLine(job.lines.peek()[i], i + 1);
    if (text) lines.push({ text, line: i + 1 });
  }
  log('info', `✈ Resuming job ${record.job} from line ${line}`);
  closeModal();
  streamLines(untilProgramEnd(lines), true, { stamp, resumedAt: line });
}

/** DISCARD RECORD: says so only once the controller has accepted $FLIGHTCLEAR. */
async function discardRecord(fromDialog: boolean): Promise<void> {
  let reply: command.Reply;
  try { reply = await command.send('$FLIGHTCLEAR', { log: true, quiet: true }); }
  catch (e) { ignoreFailed(e); return; }
  if (reply.result === 'ok') {
    if (fromDialog) closeModal();
    log('info', '✈ Flight record discarded');
    messages.push('job', 'Flight record discarded.');
    return;
  }
  const text = `The controller refused to discard the flight record: error:${reply.code}${errorText(reply.code) ? ' (' + errorText(reply.code) + ')' : ''}. The record is unchanged.`;
  log('err', text);
  messages.push('error', text);
  const body = document.getElementById('frModalBody');
  if (fromDialog && body && !body.querySelector('.fr-refused-discard')) {
    body.insertAdjacentHTML('afterbegin', `<div class="fr-refused fr-refused-discard">${esc(text)}</div>`);
  }
}

function machineState(): string { return machine.stateName.peek(); }

export function frOpenResume(): void {
  const modal = document.getElementById('frModal');
  const body = document.getElementById('frModalBody');
  if (!modal || !body || !_record) return;
  const record = _record;
  _toolChecked = false;

  // The plugin lifts only from below its retract height (flight_recorder.c), so the tool may be higher.
  const how = record.state === 'Retracted'
    ? `The tool was lifted to machine Z ${retractZ().toFixed(1)}, or left where it was if it was higher, and the spindle stopped.`
    : 'The tool was <b>not</b> lifted clear. Make sure it is clear of the work before going on.';
  const summary =
    `<div class="fr-summary">Job <b>${esc(record.job)}</b> stopped at line <b>${record.ln}</b> because ` +
    `${esc(REASONS[record.why] || record.why)}${record.why === 'alarm' ? ' (ALARM:' + record.alarm + ')' : ''}. ${how}</div>`;

  if (!loadedFileMatches(record)) {
    body.innerHTML = summary +
      `<div class="fr-step"><div class="fr-step-title">Open the file it was running</div>` +
      `<div class="fr-step-text">${job.lines.peek().length ? 'The file that is loaded is a different one. ' : ''}` +
      `Open the same G-code file and this will carry on from there.</div>` +
      `<div class="fr-step-actions"><button class="tb-btn primary" data-fr="open">📂 OPEN FILE</button></div></div>` +
      `<div class="fr-modal-actions"><button class="tb-btn danger" data-fr="discard">DISCARD RECORD</button>` +
      `<div style="flex:1"></div><button class="tb-btn" data-fr="close">NOT NOW</button></div>`;
    wireModal(record);
    modal.style.display = '';
    return;
  }

  _offsetsAsked = false;
  _stateCache = null;
  const file = job.file.value || 'the loaded file';
  const toolText = record.tool
    ? `The job was using <b>T${record.tool}</b>. Check that tool is in the spindle, with its length offset set.`
    : 'Check the right tool is in the spindle, with its length offset set.';

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
    `<div class="fr-step-text">BearSender puts the file's tool length offset back, stops the spindle and coolant where the file has them off, goes up to machine Z ${lift().z.toFixed(1)} ` +
    `unless the tool is higher (Options: Resume lift), over the start of the line, starts the spindle and coolant as the file has them and comes straight ` +
    `down, then carries on with the file. RESUME reads the offsets and the tool length again first, and sends the plan ` +
    `as it is then:</div><div id="frPlan"></div></div>` +
    `<div class="fr-modal-actions"><button class="tb-btn danger" data-fr="discard">DISCARD RECORD</button>` +
    `<div style="flex:1"></div><button class="tb-btn" data-fr="close">NOT NOW</button>` +
    `<button class="tb-btn success" data-fr="start" disabled>▶ RESUME</button></div>`;
  wireModal(record);
  modal.style.display = '';
  renderPlan();
  updateResumeDialog();
}

function wireModal(record: FlightRecord): void {
  const body = document.getElementById('frModalBody')!;
  const on = (name: string, fn: (el: HTMLElement) => void) => {
    const el = body.querySelector<HTMLElement>(`[data-fr="${name}"]`);
    if (el) el.addEventListener(el.tagName === 'INPUT' ? 'change' : 'click', () => fn(el));
  };
  on('open', () => document.getElementById('fileInput')?.click());
  on('discard', () => { discardRecord(true); });
  on('close', () => closeModal());
  on('unlock', () => sendCmd('$X'));
  on('home', () => sendCmd('$H'));
  on('tool', el => { _toolChecked = (el as HTMLInputElement).checked; updateResumeDialog(); });
  on('start', () => { pressResume(record); });
}

function readyToResume(): boolean {
  return connection.connected.peek() && !job.running.peek() && !_pressing && machineState() === 'idle' && _toolChecked;
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
  _request = null;   // a RESUME still reading $# and $TTLIST is withdrawn
  const modal = document.getElementById('frModal');
  if (modal) modal.style.display = 'none';
}

// ── The Settings screen's RECORDER tab (src/app/RecorderTab.tsx) ──────────────

/** Copies the state into the flight recorder store; the screens show that. */
export function renderFlightTab(): void { publish(); }

function renderRecord(): void { publish(); }

function renderSettings(): void { publish(); }

function renderEvents(): void {
  publish();
  if (!_eventsLoading && _events.length) flight.eventsReadAt.value = Date.now();
}

/** Reads the record and the recorder's settings again. */
export function frRefresh(): void {
  if (connection.connected.peek() && _pluginDetected) queryController().catch(ignoreFailed);
}

/** "Uses undercut tools", for the loaded job. */
export function frSetUndercut(on: boolean): void { _undercut = on; publish(); }

/** Writes one of the recorder's settings ($790-$793), then reads it back. */
export function frWriteSetting(id: number, value: string): void {
  sendCmd('$' + id + '=' + value);
  command.send('$' + id).then(renderSettings, ignoreFailed);
}

/** Reads the last 100 events from the controller, unless a job is running. */
export async function frLoadEvents(): Promise<void> {
  if (!connection.connected.peek() || !_pluginDetected || _noStorage || _eventsLoading || job.running.peek()) return;
  _events = [];
  _eventsLoading = true;
  renderEvents();
  try {
    const reply = await command.send('$EVENTS=100');
    _events = reply.lines.filter(line => line.startsWith('[EVENT:'));
  } catch (e) { ignoreFailed(e); }
  _eventsLoading = false;
  renderEvents();
}

export function initFlightRecorderTab(): void {
  const on = (id: string, fn: () => void) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
  on('frModalClose', () => closeModal());

  // The dialog's machine line and RESUME follow the machine's state, the link and the job.
  effect(() => { void machine.stateName.value; void connection.connected.value; void job.running.value; untracked(() => updateResumeDialog()); });
  renderFlightTab();
}

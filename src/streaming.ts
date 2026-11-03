// ═══════════════════════════════════════════════
// JOB CONTROL — character-counting pump
// ═══════════════════════════════════════════════
//
// The job is a source for the command layer, which pulls its lines while they fit in the
// controller's RX buffer, through the same queue as every other command.
//
// Each run is a source of its own, so a late reply to an earlier run's line goes to that run, which
// has ended, and never counts for the new one. A run ends:
//   - completed, when the G4 P0 sent after its last line is answered. An ok only says a line was
//     accepted; the ok of G4 P0 comes when the planner is empty, that is, when the machine has stopped.
//   - on an error: nothing more is sent, the machine is held, and the message line says which line
//     was refused and why. grblHAL refuses every G-code line after an error until a $ command or an
//     empty line, and the command layer sends neither in between job lines, so the lines after the
//     refused one don't run. Resume finishes what was accepted before it; Stop ends it there.
//     A $ or [ line of the file itself clears the error too, so it goes only once every line before
//     it is answered, and nothing goes after it until it is.
//   - on Stop, or dropped (a reset, an alarm, a lost link).
// At an M6 nothing more is sent until the tool change is over, so no job line waits in the
// controller behind it: the tool change can be acknowledged (jogging works), and Resume sends the
// cycle start once every reply is in (command.ts). An M6 the controller passes without a tool change
// (the same tool, $341=4) carries on, unless "Hold at every M6" is on: then the job waits for Resume
// with the controller idle.
//
// Start reads the modes first ($G): the program is read from them, and they are kept with the job
// (stores/starts.ts) for a resume. With "Run lines after M30" off, the job ends at its first M2/M30.

import { state } from './state';
import { byteLen } from './ui';
import { log } from './console';
import { rtSend } from './connection';
import * as command from './command';
import { updateProgress } from './gcode';
import { frActive, frEnabled, frJobLines, frJobStamp } from './flight-recorder';
import { cleanLine } from './flight-recorder-resume';
import { errorText } from './errors';
import { rereadAfterReset } from './offsets';
import * as job from './stores/job';
import * as messages from './stores/messages';
import * as machine from './stores/machine';
import * as jobOptions from './stores/options';
import * as program from './stores/program';
import * as starts from './stores/starts';

export interface SendLine { text: string; line: number; }

// The planner barrier after the last line, the M6 of a tool change (not M61, M6.x), and the program end.
const BARRIER = 'G4P0';
const TOOL_CHANGE = /(?<![A-Z])M0*6(?![\d.])/;
const PROGRAM_END = /(?<![A-Z])M0*(2|30)(?![\d.])/;

interface Run {
  source: command.JobSource;
  lines: SendLine[];
  head: number;
  inFlight: number;    // this run's lines sent and not yet answered
  ended: boolean;      // nothing more is pulled; replies still to come are only counted
  // An M6 went: 'sent' until the controller is at the tool change, 'change' until it has left it;
  // 'held' when the controller made none and BearSender holds for Resume (Hold at every M6).
  atM6: 'no' | 'sent' | 'change' | 'held';
  m6Line: number;      // the line of that M6, for the job's tool change timeline
  lastSystem: boolean; // the line sent last was a $ or [ line
}

let run: Run | null = null;
let starting = false;   // waiting for Start's $G, or the recorder's answer to the job stamp
// After an error: the hold is sent again while the controller reports Run, until it has taken, for
// HOLD_AGAIN ms. grblHAL ignores a feed hold that comes before the cycle has started (seen on the sim:
// an error answered as the first move began, the controller still Idle, and the hold was lost).
const HOLD_AGAIN = 3_000;
let holdUntilHeld = 0;   // a time, or 0

function newRun(lines: SendLine[]): Run {
  const r: Run = { lines, head: 0, inFlight: 0, ended: false, atM6: 'no', m6Line: 0, lastSystem: false, source: null! };
  r.source = {
    next(room) {
      if (r.ended || !state.running || state.paused || r.atM6 !== 'no' || r.head >= r.lines.length) return null;
      const next = r.lines[r.head];
      const system = /^[$[]/.test(next.text);
      if (r.inFlight && (system || r.lastSystem)) return null;
      const bytes = byteLen(next.text + '\n');
      if (bytes > command.rxBufferSize() - 1) { tooLong(r, next, bytes); return null; }
      if (bytes > room) return null;
      r.lastSystem = system;
      r.head++;
      state.lineHead = r.head;
      r.inFlight++;
      if (next.line > 0) job.sentLine.value = next.line;
      updateProgress(next.line, state.gcodeLines.length);
      // The sending keeps its own M6 check, so the hold doesn't depend on the interpreter having read this far.
      if (TOOL_CHANGE.test(cleanLine(next.text))) { r.atM6 = 'sent'; r.m6Line = next.line; }
      return next;
    },
    // One-offs wait from an M6 until the tool change is acknowledged: one sent before that would sit
    // unread in the controller and run after the cycle start.
    // At an M6 BearSender holds, the controller is idle and reads them at once.
    holdsOneOffs() { return !r.ended && r.atM6 !== 'no' && r.atM6 !== 'held' && !command.toolChangeAcknowledged(); },
    replied(line, reply) {
      r.inFlight = Math.max(0, r.inFlight - 1);
      if (r.ended) return;
      if (line.line > 0) job.ackedLine.value = line.line;
      if (reply.result === 'error') { halt(r, `Line ${line.line} was refused: error:${reply.code}${errorText(reply.code) ? ' (' + errorText(reply.code) + ')' : ''}`, line.line, reply.code); return; }
      if (r.head >= r.lines.length && r.inFlight === 0) {
        end(r);
        log('info', '✓ Job complete');
        job.finished('completed');
        const early = job.endsEarly.value;
        if (early) {
          const text = `The job ended at the program end on line ${early.line}: the ${early.left} line${early.left === 1 ? '' : 's'} after it ${early.left === 1 ? 'wasn\'t' : 'weren\'t'} sent (Options: Run lines after M30).`;
          log('info', text);
          messages.push('job', text);
        }
      }
    },
    dropped(why) {
      r.inFlight = 0;
      if (r.ended) return;
      end(r);
      job.finished(why === 'alarm' ? 'alarm' : why === 'disconnected' ? 'link lost' : 'stopped');
    },
  };
  return r;
}

/** Nothing more is pulled from the run. */
function end(r: Run): void {
  r.ended = true;
  command.endStream(r.source);
  if (run === r) { state.running = false; state.paused = false; job.heldAtM6.value = false; }
  updateRunButtons();
}

/** An error: stop sending, hold, and say why. */
function halt(r: Run, why: string, line: number, code: number): void {
  end(r);
  rtSend('!');
  holdUntilHeld = Date.now() + HOLD_AGAIN;
  job.halt.value = { line, code, why };
  log('alarm', why + '. Nothing more was sent and the machine is held: Resume finishes the lines accepted before it, Stop ends the job here.');
  job.finished('error');
}

/** ALARM: the run is over, whatever was in flight (the command layer drops what it had). */
export function endRunOnAlarm(): void {
  if (run && !run.ended) { end(run); job.finished('alarm'); }
  if (stopping) { clearTimeout(stopping.timer); stopping = null; job.stopping.value = false; }
}

function tooLong(r: Run, line: SendLine, bytes: number): void {
  halt(r, `Line ${line.line} is ${bytes} bytes, longer than the controller's ${command.rxBufferSize()}-byte input`, line.line, 0);
}

// The status reports: the tool change at an M6, and Stop's wait for the hold.
command.on('status', line => {
  const field = line.slice(1).split(/[|>]/)[0];
  const s = field.split(':')[0].toLowerCase();
  if (stopping) stopStatus(field.toLowerCase());
  if (holdUntilHeld) {
    // Held, or an alarm: from here the operator decides (Resume, Stop).
    if (s === 'hold' || s === 'alarm' || s === 'door' || Date.now() > holdUntilHeld) holdUntilHeld = 0;
    else if (s === 'run') rtSend('!');
  }
  const r = run;
  if (!r || r.ended || r.atM6 === 'no') return;
  // Held by BearSender: only a late tool change state takes it over.
  if (r.atM6 === 'held' && s !== 'tool') return;
  if (s === 'tool') {
    if (r.atM6 === 'sent') job.changeStarted(r.m6Line, true);
    r.atM6 = 'change';
    job.heldAtM6.value = false;
    // It goes once the M6's ok is in: by then grblHAL has stopped reading its input.
    command.acknowledgeToolChange();
  } else if (s === 'jog' || s === 'hold') {
    // Jogging at a tool change reports Jog; the tool change goes on.
  } else if (r.atM6 === 'change' || (r.inFlight === 0 && s === 'idle')) {
    // The tool change is over, or the M6 (answered, the machine idle) made none. With "Hold at every
    // M6" on, one that made none holds the job here until Resume.
    if (r.atM6 === 'sent' && jobOptions.holdEveryM6.value) {
      r.atM6 = 'held';
      job.changeStarted(r.m6Line, true);
      job.heldAtM6.value = true;
      log('info', `Held at the M6 on line ${r.m6Line}: the controller made no tool change (the same tool, or $341=4), and Hold at every M6 is on. Resume goes on.`);
      return;
    }
    if (r.atM6 === 'change') job.changeEnded(); else job.changeStarted(r.m6Line, false);
    r.atM6 = 'no';
    command.pump();
  }
});

/** With "Run lines after M30" off the job ends at its first M2/M30: the lines after it aren't sent,
 *  and the message line says so when the job completes. */
export function untilProgramEnd(lines: SendLine[]): SendLine[] {
  job.endsEarly.value = null;
  if (jobOptions.runAfterM30.value) return lines;
  const k = lines.findIndex(l => !/^[$[]/.test(l.text) && PROGRAM_END.test(cleanLine(l.text)));
  const left = k < 0 ? 0 : lines.slice(k + 1).filter(l => l.text !== '%').length;
  if (!left) return lines;
  job.endsEarly.value = { line: lines[k].line, left };
  log('info', `The job ends at the program end on line ${lines[k].line}; the ${left} line${left === 1 ? '' : 's'} after it won't be sent (Options: Run lines after M30 is off).`);
  return lines.slice(0, k + 1);
}

export function startJob(): void {
  if (!state.connected) { log('err', 'Not connected'); return; }
  if (state.gcodeLines.length === 0) { log('err', 'No file loaded'); return; }
  if (state.running && !state.paused) return;
  if (state.paused) {
    state.paused = false;
    rtSend('~');
    log('info', 'Resumed');
    updateRunButtons();
    command.pump();
    return;
  }
  if (starting) return;
  // The modes first: the program is read from them, and they are kept with the job for a resume. The
  // sim refused the first $ command after homing (error:71) and took the next, so a refusal gets one more try.
  // Stop, RESET or a lost link while $G is pending revokes this Start, as does another file loaded.
  starting = true;
  const live = command.intent(), lines = state.gcodeLines;
  const modes = () => command.send('$G', { quiet: true }).catch(e => { if (e instanceof command.CommandFailed) return null; throw e; });
  modes().then(r => r?.result === 'error' && live() ? modes() : r).then(reply => {
    starting = false;
    if (!live() || state.gcodeLines !== lines) {
      log('info', 'Start: nothing was sent. ' + (live() ? 'Another file was loaded' : 'Stop, RESET, a reset or the link going') + ' came while $G was answered; press Start again.');
      return;
    }
    if (!state.connected || state.running) return;
    const words = reply?.result === 'ok' ? [...machine.modal.value] : null;
    if (!words) log('err', 'Start: $G got no answer, so the modes the job starts from aren\'t known: the program was read from the last known, and a resume will assume G21 G90 G17 G94.');
    program.readNow();
    starts.keep(state.gcodeLines, job.file.value ?? '—', words);
    const recorded = frActive();
    if (frEnabled() && !recorded) log('info', '✈ The flight recorder is on, but this controller has no Flight Recorder plugin. Running without a record.');
    log('info', 'Starting job: ' + state.gcodeLines.length + ' lines  (RX buffer: ' + state.RX_BUFFER_SIZE + ' bytes)' +
        (recorded ? '  flight recorder on' : '') + (words ? '  modes ' + words.filter(w => w.startsWith('G')).join(' ') : ''));
    if (recorded) streamLines(untilProgramEnd(frJobLines()), true, { stamp: frJobStamp() });
    else streamLines(untilProgramEnd(plainLines()), false, {});
  });
}

/** Start streaming prepared lines, either a whole job or a resume (the moves back in, then the rest of the file).
 *  With a recorder stamp ($FLIGHT=<job>) it goes first, and the lines only if the recorder accepts it. */
export function streamLines(lines: SendLine[], numbered: boolean, opts: { stamp?: string; resumedAt?: number }): void {
  if (starting) return;
  // The machine warmup streams on its own (warmup.ts): a job doesn't start over it.
  if (command.streaming() && !(run && !run.ended)) { log('err', 'Nothing was started: the machine warmup is running. Stop it, or let it end.'); return; }
  if (!opts.stamp) { begin(lines, numbered, opts.resumedAt); return; }
  const stamp = opts.stamp;
  starting = true;
  const live = command.intent();
  command.send(stamp, { log: true, quiet: true }).then(reply => {
    starting = false;
    // Stop or RESET while the stamp was answered: the job doesn't start (the record may show it Running at line 0).
    if (!live()) { log('info', `The job stamp ${stamp} was answered after Stop, RESET or a reset: nothing of the job was sent.`); return; }
    if (reply.result === 'ok') { begin(lines, numbered, opts.resumedAt); return; }
    const text = `The flight recorder refused the job stamp ${stamp}: error:${reply.code}${errorText(reply.code) ? ' (' + errorText(reply.code) + ')' : ''}. ` +
      'Nothing of the job was sent, and the record it holds is unchanged (Recorder panel). Press Start to try again, or discard the record first.';
    log('err', text);
    messages.push('error', text);
    job.notice.value = text;
  }, e => {
    starting = false;
    if (!(e instanceof command.CommandFailed)) throw e;
    log('err', 'The job stamp got no answer (' + e.why + '); nothing of the job was sent.');
  });
}

function begin(lines: SendLine[], numbered: boolean, resumedAt?: number): void {
  if (!state.connected) return;
  if (run && !run.ended) end(run);
  holdUntilHeld = 0;
  job.started(numbered, resumedAt);
  job.halt.value = null;
  state.running = true; state.paused = false;
  state.sendLines = lines; state.jobNumbered = numbered;
  state.lineHead = 0; state.segmentIndex = 0;
  run = newRun([...lines, { text: BARRIER, line: 0 }]);
  updateRunButtons();
  command.stream(run.source);
}

function stripComment(line: string): string {
  return line.replace(/\(.*?\)/g, '').replace(/;.*/, '').trim();
}

function plainLines(): SendLine[] {
  const lines: SendLine[] = [];
  state.gcodeLines.forEach((raw, i) => {
    const text = stripComment(raw).trim().toUpperCase();
    if (text) lines.push({ text, line: i + 1 });
  });
  return lines;
}

/** HOLD: the job's own pause, or a feed hold of whatever the machine is doing. */
export function pauseJob(): void {
  if (!state.running) { rtSend('!'); log('info', 'Feed hold sent'); return; }
  state.paused = !state.paused;
  rtSend(state.paused ? '!' : '~');
  log('info', state.paused ? 'Feed hold sent' : 'Cycle resume sent');
  updateRunButtons();
  if (!state.paused) command.pump();
}

/** RESUME at a tool change: the cycle start, once every reply is in (command.ts). At an M6 BearSender
 *  holds (Hold at every M6) the controller is idle, so the job just goes on. */
export function resumeToolChange(): void {
  const r = run;
  if (r && !r.ended && r.atM6 === 'held') {
    r.atM6 = 'no';
    job.heldAtM6.value = false;
    job.changeEnded();
    log('info', 'Resume: the job goes on after the M6 on line ' + r.m6Line);
    command.pump();
    return;
  }
  command.resumeToolChange();
}

/** MEASURE at a tool change with $341 1 or 2: the controller probes the new tool where it is and
 *  sets its length ($TPW). With 1 that is over the touch plate the operator jogged to; with 2 the
 *  machine is already at the toolsetter (G59.3). It needs the tool change acknowledged. */
export function measureAtToolChange(): void {
  if (!command.toolChangeAcknowledged()) {
    log('err', 'The tool change isn\'t acknowledged yet, so the controller can\'t take $TPW. Try again in a moment.');
    return;
  }
  log('info', 'MEASURE: $TPW, the controller probes the tool and sets its length');
  command.send('$TPW', { log: true, quiet: true }).then(reply => {
    // $TPW answers error:47 when the probe found nothing (grblHAL's tc_probe_workpiece).
    const why = reply.code === 47 ? 'the probe found nothing' : errorText(reply.code);
    const text = reply.result === 'ok'
      ? 'Tool measured ($TPW): the controller has set its length. Take away any touch plate, then press Resume.'
      : `The controller didn't measure the tool: error:${reply.code}${why ? ' (' + why + ')' : ''}. Check the probe and its position, then MEASURE again.`;
    log(reply.result === 'ok' ? 'info' : 'err', text);
    messages.push(reply.result === 'ok' ? 'job' : 'error', text);
  }, e => { if (!(e instanceof command.CommandFailed)) throw e; });
}

// ── Stop ─────────────────────────────────────────────────────────────────────
//
// A feed hold, then the reset once a status report says the machine has stopped. A reset while it
// is still moving loses the position (grblHAL raises ALARM 3). Homing can't be held, so a Stop
// while homing resets at once. If the hold hasn't finished after HOLD_LIMIT, the reset goes anyway
// and the operator is told the position may be lost.

const HOLD_LIMIT = 10_000;
let stopping: { timer: ReturnType<typeof setTimeout> } | null = null;

/** STOP: ends the job, whether or not BearSender is sending one, and stops the machine. */
export function stopJob(): void {
  if (!state.connected) return;
  // A Start, stamp, warmup or Resume waiting on a reply doesn't go ahead after this.
  command.revokePending('Stop');
  if (run && !run.ended) {
    end(run);
    log('info', 'Job stopped');
    job.finished('stopped');
  }
  state.lineHead = 0;
  holdUntilHeld = 0;
  updateRunButtons();
  stopMachine();
}

/** The hold, then the reset when the machine has stopped. Also for Cancel in probing. */
export function stopMachine(): void {
  if (stopping || !command.isConnected()) return;
  rtSend('!');
  rtSend('?');
  stopping = { timer: setTimeout(() => finishStop(true), HOLD_LIMIT) };
  job.stopping.value = true;
  log('info', 'Stop: feed hold sent; the reset goes when the machine has stopped');
}

export function isStopping(): boolean { return !!stopping; }

function stopStatus(field: string): void {
  const s = field.split(':')[0];
  // Still decelerating: running, jogging, a hold or a door in progress.
  if (s === 'run' || s === 'jog' || field === 'hold:1' || field === 'door:2' || field === 'door:3') return;
  finishStop(false);
}

function finishStop(timedOut: boolean): void {
  if (!stopping) return;
  clearTimeout(stopping.timer);
  stopping = null;
  job.stopping.value = false;
  if (!command.isConnected()) return;
  rtSend('\x18');
  rereadAfterReset();
  if (timedOut) {
    const text = `The machine hadn't stopped ${HOLD_LIMIT / 1000} s after Stop, so the reset went anyway. The position may be lost: home again.`;
    log('err', text);
    messages.push('error', text);
  } else log('info', 'Stopped: soft reset sent');
}

export function updateRunButtons(): void {
  job.running.value = state.running;
  job.paused.value = state.paused;
}

/** RESET: at once, moving or not. */
export function sendReset(): void {
  if (!state.connected) return;
  command.revokePending('RESET');
  if (stopping) { clearTimeout(stopping.timer); stopping = null; job.stopping.value = false; }
  if (run && !run.ended) { end(run); job.finished('stopped'); }
  holdUntilHeld = 0;
  state.running = false; state.paused = false;
  rtSend('\x18');
  rereadAfterReset();
  state.lineHead = 0;
  log('info', 'Soft reset');
  updateRunButtons();
}

export function unlockAlarm(): void { import('./connection').then(c => c.sendCmd('$X')); }
export function sendHome(): void { import('./connection').then(c => c.sendCmd('$H')); }
// Absolute and in millimetres whatever the modal state (a probe can leave G91, a job G20).
export function goToXY0(): void { import('./jog').then(j => j.goToXY0()); }

export function setWCS(code: string): void {
  state.activeWcs = code;
  import('./connection').then(c => {
    c.sendCmd(code);
    log('info', 'WCS set to ' + code);
  });
}

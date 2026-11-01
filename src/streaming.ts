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
// cycle start once every reply is in (command.ts).

import { state } from './state';
import { byteLen } from './ui';
import { log } from './console';
import { rtSend } from './connection';
import * as command from './command';
import { updateProgress } from './gcode';
import { frActive, frEnabled, frJobLines, frJobStamp } from './flight-recorder';
import { cleanLine } from './flight-recorder-resume';
import { errorText } from './errors';
import * as job from './stores/job';
import * as messages from './stores/messages';

export interface SendLine { text: string; line: number; }

// The planner barrier after the last line, and the M6 of a tool change (not M61, M6.x).
const BARRIER = 'G4P0';
const TOOL_CHANGE = /(?<![A-Z])M0*6(?![\d.])/;

interface Run {
  source: command.JobSource;
  lines: SendLine[];
  head: number;
  inFlight: number;    // this run's lines sent and not yet answered
  ended: boolean;      // nothing more is pulled; replies still to come are only counted
  // An M6 went: 'sent' until the controller is at the tool change, 'change' until it has left it.
  atM6: 'no' | 'sent' | 'change';
  lastSystem: boolean; // the line sent last was a $ or [ line
}

let run: Run | null = null;
let starting = false;   // waiting for the recorder's answer to the job stamp
// After an error: the hold is sent again while the controller reports Run, until it has taken, for
// HOLD_AGAIN ms. grblHAL ignores a feed hold that comes before the cycle has started (seen on the sim:
// an error answered as the first move began, the controller still Idle, and the hold was lost).
const HOLD_AGAIN = 3_000;
let holdUntilHeld = 0;   // a time, or 0

function newRun(lines: SendLine[]): Run {
  const r: Run = { lines, head: 0, inFlight: 0, ended: false, atM6: 'no', lastSystem: false, source: null! };
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
      if (TOOL_CHANGE.test(cleanLine(next.text))) r.atM6 = 'sent';
      return next;
    },
    // One-offs wait from an M6 until the tool change is acknowledged: one sent before that would sit
    // unread in the controller and run after the cycle start.
    holdsOneOffs() { return !r.ended && r.atM6 !== 'no' && !command.toolChangeAcknowledged(); },
    replied(line, reply) {
      r.inFlight = Math.max(0, r.inFlight - 1);
      if (r.ended) return;
      if (line.line > 0) job.ackedLine.value = line.line;
      if (reply.result === 'error') { halt(r, `Line ${line.line} was refused: error:${reply.code}${errorText(reply.code) ? ' (' + errorText(reply.code) + ')' : ''}`, line.line, reply.code); return; }
      if (r.head >= r.lines.length && r.inFlight === 0) {
        end(r);
        log('info', '✓ Job complete');
        job.finished('completed');
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
  if (run === r) { state.running = false; state.paused = false; }
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
  if (s === 'tool') {
    r.atM6 = 'change';
    // It goes once the M6's ok is in: by then grblHAL has stopped reading its input.
    command.acknowledgeToolChange();
  } else if (s === 'jog' || s === 'hold') {
    // Jogging at a tool change reports Jog; the tool change goes on.
  } else if (r.atM6 === 'change' || (r.inFlight === 0 && s === 'idle')) {
    // The tool change is over, or the M6 (answered, the machine idle) made none.
    r.atM6 = 'no';
    command.pump();
  }
});

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
  const recorded = frActive();
  if (frEnabled() && !recorded) log('info', '✈ The flight recorder is on, but this controller has no Flight Recorder plugin. Running without a record.');
  log('info', 'Starting job: ' + state.gcodeLines.length + ' lines  (RX buffer: ' + state.RX_BUFFER_SIZE + ' bytes)' +
      (recorded ? '  flight recorder on' : ''));
  if (recorded) streamLines(frJobLines(), true, { stamp: frJobStamp() });
  else streamLines(plainLines(), false, {});
}

/** Start streaming prepared lines, either a whole job or a resume (the moves back in, then the rest of the file).
 *  With a recorder stamp ($FLIGHT=<job>) it goes first, and the lines only if the recorder accepts it. */
export function streamLines(lines: SendLine[], numbered: boolean, opts: { stamp?: string; resumedAt?: number }): void {
  if (starting) return;
  if (!opts.stamp) { begin(lines, numbered, opts.resumedAt); return; }
  const stamp = opts.stamp;
  starting = true;
  command.send(stamp, { log: true, quiet: true }).then(reply => {
    starting = false;
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

/** RESUME at a tool change: the cycle start, once every reply is in (command.ts). */
export function resumeToolChange(): void {
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
  if (stopping) { clearTimeout(stopping.timer); stopping = null; job.stopping.value = false; }
  if (run && !run.ended) { end(run); job.finished('stopped'); }
  holdUntilHeld = 0;
  state.running = false; state.paused = false;
  rtSend('\x18');
  state.lineHead = 0;
  log('info', 'Soft reset');
  updateRunButtons();
}

export function unlockAlarm(): void { import('./connection').then(c => c.sendCmd('$X')); }
export function sendHome(): void { import('./connection').then(c => c.sendCmd('$H')); }
// Absolute and in millimetres whatever the modal state (a probe can leave G91, a job G20).
export function goToXY0(): void { import('./modules/jog').then(j => j.clearWaypoints()); import('./connection').then(c => c.sendCmd('G21G90G0X0Y0')); }

export function setWCS(code: string): void {
  state.activeWcs = code;
  import('./connection').then(c => {
    c.sendCmd(code);
    log('info', 'WCS set to ' + code);
  });
}

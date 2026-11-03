// Job streaming. A job is a source for the command layer, which pulls its lines while they fit in
// the controller's RX buffer. Each run is a source of its own, so a late reply to an earlier run's
// line can't count for a new one.
//
// A run ends when:
// - the G4 P0 after its last line is answered. An ok only means a line was accepted; G4 P0's ok
//   comes when the planner is empty, so the machine has stopped.
// - a line is refused. Nothing more is sent and the machine is held. grblHAL refuses every G-code
//   line after an error until a $ command or an empty line, and neither goes between job lines, so
//   the lines after the refused one don't run. A $ or [ line in the file also clears the error, so
//   it goes only once every line before it is answered, and nothing follows it until it is.
// - Stop, a reset, an alarm or a lost link ends it.
//
// After an M6 nothing more is sent until the tool change is over, so no job line waits in the
// controller behind it: the tool change can then be acknowledged (jogging works), and Resume sends
// the cycle start once every reply is in (command.ts). An M6 that makes no tool change (the same
// tool, or $341=4) carries on, unless "Hold at every M6" is on.
//
// Start reads the modes ($G) first: the program is interpreted from them, and they are kept with
// the job for a resume (stores/starts.ts).

import { byteLen } from './ui';
import { log } from './console';
import { rtSend } from './connection';
import * as command from './command';
import { isRecorderActive, isRecorderEnabled, numberedJobLines, buildJobStamp } from './flight-recorder';
import { cleanLine } from './flight-recorder-resume';
import { errorText } from './errors';
import { rereadAfterReset } from './offsets';
import * as job from './stores/job';
import * as connection from './stores/connection';
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
  nextIndex: number;
  inFlight: number;         // lines sent and not yet answered
  hasEnded: boolean;        // nothing more is pulled; late replies are only counted
  // After an M6: 'sent' until the controller is at the tool change, 'change' until it has left it,
  // 'held' when it made no tool change and "Hold at every M6" holds the job for Resume.
  m6State: 'no' | 'sent' | 'change' | 'held';
  m6Line: number;           // the line of that M6, for the job's tool change timeline
  lastWasSystem: boolean;   // the last line sent was a $ or [ line
}

let currentRun: Run | null = null;
// A job is being sent, and is paused by HOLD; publishRunState copies both into the job store.
let running = false;
let paused = false;
let starting = false;   // waiting for Start's $G, or for the recorder to answer the job stamp
// After an error the hold is repeated while the controller still reports Run, for up to
// HOLD_RETRY_MS: grblHAL ignores a feed hold that arrives before the cycle has started.
const HOLD_RETRY_MS = 3_000;
let holdRetryUntil = 0;   // a Date.now() deadline, or 0

function createRun(lines: SendLine[]): Run {
  const r: Run = { lines, nextIndex: 0, inFlight: 0, hasEnded: false, m6State: 'no', m6Line: 0, lastWasSystem: false, source: null! };
  r.source = {
    next(room) {
      if (r.hasEnded || !running || paused || r.m6State !== 'no' || r.nextIndex >= r.lines.length) return null;
      const nextLine = r.lines[r.nextIndex];
      const isSystem = /^[$[]/.test(nextLine.text);
      if (r.inFlight && (isSystem || r.lastWasSystem)) return null;
      const bytes = byteLen(nextLine.text + '\n');
      if (bytes > command.rxBufferSize() - 1) { haltOnLongLine(r, nextLine, bytes); return null; }
      if (bytes > room) return null;
      r.lastWasSystem = isSystem;
      r.nextIndex++;
      r.inFlight++;
      if (nextLine.line > 0) job.sentLine.value = nextLine.line;
      // Checked here, not taken from the interpreter, which may not have read this far yet.
      if (TOOL_CHANGE.test(cleanLine(nextLine.text))) { r.m6State = 'sent'; r.m6Line = nextLine.line; }
      return nextLine;
    },
    // From an M6 until the tool change is acknowledged, one-off commands wait: sent earlier, they
    // would sit unread in the controller and run after the cycle start. At our own M6 hold the
    // controller is idle and reads them at once.
    holdsOneOffs() { return !r.hasEnded && r.m6State !== 'no' && r.m6State !== 'held' && !command.toolChangeAcknowledged(); },
    replied(line, reply) {
      r.inFlight = Math.max(0, r.inFlight - 1);
      if (r.hasEnded) return;
      if (line.line > 0) job.ackedLine.value = line.line;
      if (reply.result === 'error') { haltRun(r, `Line ${line.line} was refused: error:${reply.code}${errorText(reply.code) ? ' (' + errorText(reply.code) + ')' : ''}`, line.line, reply.code); return; }
      if (r.nextIndex >= r.lines.length && r.inFlight === 0) {
        endRun(r);
        log('info', '✓ Job complete');
        job.finished('completed');
        const endsEarly = job.endsEarly.value;
        if (endsEarly) {
          const text = `The job ended at the program end on line ${endsEarly.line}: the ${endsEarly.left} line${endsEarly.left === 1 ? '' : 's'} after it ${endsEarly.left === 1 ? 'wasn\'t' : 'weren\'t'} sent (Options: Run lines after M30).`;
          log('info', text);
          messages.push('job', text);
        }
      }
    },
    dropped(why) {
      r.inFlight = 0;
      if (r.hasEnded) return;
      endRun(r);
      job.finished(why === 'alarm' ? 'alarm' : why === 'disconnected' ? 'link lost' : 'stopped');
    },
  };
  return r;
}

/** Stops pulling lines from the run. */
function endRun(r: Run): void {
  r.hasEnded = true;
  command.endStream(r.source);
  if (currentRun === r) { running = false; paused = false; job.heldAtM6.value = false; }
  publishRunState();
}

/** A refused line: stop sending, hold the machine and say why. */
function haltRun(r: Run, why: string, line: number, code: number): void {
  endRun(r);
  rtSend('!');
  holdRetryUntil = Date.now() + HOLD_RETRY_MS;
  job.halt.value = { line, code, why };
  log('alarm', why + '. Nothing more was sent and the machine is held: Resume finishes the lines accepted before it, Stop ends the job here.');
  job.finished('error');
}

/** An alarm ends the run; the command layer drops whatever was in flight. */
export function endRunOnAlarm(): void {
  if (currentRun && !currentRun.hasEnded) { endRun(currentRun); job.finished('alarm'); }
  if (pendingStop) { clearTimeout(pendingStop.timer); pendingStop = null; job.stopping.value = false; }
}

function haltOnLongLine(r: Run, line: SendLine, bytes: number): void {
  haltRun(r, `Line ${line.line} is ${bytes} bytes, longer than the controller's ${command.rxBufferSize()}-byte input`, line.line, 0);
}

// The status reports: the tool change at an M6, and Stop's wait for the hold.
command.on('status', line => {
  const field = line.slice(1).split(/[|>]/)[0];
  const stateName = field.split(':')[0].toLowerCase();
  if (pendingStop) checkStopped(field.toLowerCase());
  if (holdRetryUntil) {
    // Held, or an alarm: from here the operator decides (Resume, Stop).
    if (stateName === 'hold' || stateName === 'alarm' || stateName === 'door' || Date.now() > holdRetryUntil) holdRetryUntil = 0;
    else if (stateName === 'run') rtSend('!');
  }
  const r = currentRun;
  if (!r || r.hasEnded || r.m6State === 'no') return;
  // At our own M6 hold, only a late Tool state takes over.
  if (r.m6State === 'held' && stateName !== 'tool') return;
  if (stateName === 'tool') {
    if (r.m6State === 'sent') job.changeStarted(r.m6Line, true);
    r.m6State = 'change';
    job.heldAtM6.value = false;
    // Sent once the M6's ok is in: by then grblHAL has stopped reading its input.
    command.acknowledgeToolChange();
  } else if (stateName === 'jog' || stateName === 'hold') {
    // Jogging at a tool change reports Jog; the tool change goes on.
  } else if (r.m6State === 'change' || (r.inFlight === 0 && stateName === 'idle')) {
    // The tool change is over, or the M6 made none (it was answered and the machine is idle).
    if (r.m6State === 'sent' && jobOptions.holdEveryM6.value) {
      r.m6State = 'held';
      job.changeStarted(r.m6Line, true);
      job.heldAtM6.value = true;
      log('info', `Held at the M6 on line ${r.m6Line}: the controller made no tool change (the same tool, or $341=4), and Hold at every M6 is on. Resume goes on.`);
      return;
    }
    if (r.m6State === 'change') job.changeEnded(); else job.changeStarted(r.m6Line, false);
    r.m6State = 'no';
    command.pump();
  }
});

/** With "Run lines after M30" off, the job ends at its first M2 or M30. */
export function trimAfterProgramEnd(lines: SendLine[]): SendLine[] {
  job.endsEarly.value = null;
  if (jobOptions.runAfterM30.value) return lines;
  const endIndex = lines.findIndex(l => !/^[$[]/.test(l.text) && PROGRAM_END.test(cleanLine(l.text)));
  const linesAfter = endIndex < 0 ? 0 : lines.slice(endIndex + 1).filter(l => l.text !== '%').length;
  if (!linesAfter) return lines;
  job.endsEarly.value = { line: lines[endIndex].line, left: linesAfter };
  log('info', `The job ends at the program end on line ${lines[endIndex].line}; the ${linesAfter} line${linesAfter === 1 ? '' : 's'} after it won't be sent (Options: Run lines after M30 is off).`);
  return lines.slice(0, endIndex + 1);
}

export function startJob(): void {
  if (!connection.connected.peek()) { log('err', 'Not connected'); return; }
  if (job.lines.peek().length === 0) { log('err', 'No file loaded'); return; }
  if (running && !paused) return;
  if (paused) {
    paused = false;
    rtSend('~');
    log('info', 'Resumed');
    publishRunState();
    command.pump();
    return;
  }
  if (starting) return;
  // After homing the first $ command can be refused with error:71 (seen on the sim), so a refused $G
  // is tried once more. Stop, RESET, a lost link or another file loaded meanwhile cancels the Start.
  starting = true;
  const stillWanted = command.intent(), lines = job.lines.peek();
  const readModes = () => command.send('$G', { quiet: true }).catch(e => { if (e instanceof command.CommandFailed) return null; throw e; });
  readModes().then(r => r?.result === 'error' && stillWanted() ? readModes() : r).then(reply => {
    starting = false;
    if (!stillWanted() || job.lines.peek() !== lines) {
      log('info', 'Start: nothing was sent. ' + (stillWanted() ? 'Another file was loaded' : 'Stop, RESET, a reset or the link going') + ' came while $G was answered; press Start again.');
      return;
    }
    if (!connection.connected.peek() || running) return;
    const modes = reply?.result === 'ok' ? [...machine.modal.value] : null;
    if (!modes) log('err', 'Start: $G got no answer, so the modes the job starts from aren\'t known: the program was read from the last known, and a resume will assume G21 G90 G17 G94.');
    program.readNow();
    starts.keep(job.lines.peek(), job.file.value ?? '-', modes);
    const recorded = isRecorderActive();
    if (isRecorderEnabled() && !recorded) log('info', '✈ The flight recorder is on, but this controller has no Flight Recorder plugin. Running without a record.');
    log('info', 'Starting job: ' + job.lines.peek().length + ' lines  (RX buffer: ' + command.rxBufferSize() + ' bytes)' +
        (recorded ? '  flight recorder on' : '') + (modes ? '  modes ' + modes.filter(w => w.startsWith('G')).join(' ') : ''));
    if (recorded) streamLines(trimAfterProgramEnd(numberedJobLines()), true, { stamp: buildJobStamp() });
    else streamLines(trimAfterProgramEnd(plainJobLines()), false, {});
  });
}

/** Streams prepared lines: a whole job, or a resume's moves back in and the rest of the file. A
 *  recorder stamp ($FLIGHT=<job>) goes first, and the lines only if the recorder accepts it. */
export function streamLines(lines: SendLine[], numbered: boolean, opts: { stamp?: string; resumedAt?: number }): void {
  if (starting) return;
  // The machine warmup streams on its own (warmup.ts): a job doesn't start over it.
  if (command.streaming() && !(currentRun && !currentRun.hasEnded)) { log('err', 'Nothing was started: the machine warmup is running. Stop it, or let it end.'); return; }
  if (!opts.stamp) { startRun(lines, numbered, opts.resumedAt); return; }
  const stamp = opts.stamp;
  starting = true;
  const stillWanted = command.intent();
  command.send(stamp, { log: true, quiet: true }).then(reply => {
    starting = false;
    // Stopped while the stamp was pending: the job doesn't start, though the record may show it Running at line 0.
    if (!stillWanted()) { log('info', `The job stamp ${stamp} was answered after Stop, RESET or a reset: nothing of the job was sent.`); return; }
    if (reply.result === 'ok') { startRun(lines, numbered, opts.resumedAt); return; }
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

function startRun(lines: SendLine[], numbered: boolean, resumedAt?: number): void {
  if (!connection.connected.peek()) return;
  if (currentRun && !currentRun.hasEnded) endRun(currentRun);
  holdRetryUntil = 0;
  job.started(numbered, resumedAt);
  job.halt.value = null;
  running = true; paused = false;
  currentRun = createRun([...lines, { text: BARRIER, line: 0 }]);
  publishRunState();
  command.stream(currentRun.source);
}

function stripComment(line: string): string {
  return line.replace(/\(.*?\)/g, '').replace(/;.*/, '').trim();
}

function plainJobLines(): SendLine[] {
  const lines: SendLine[] = [];
  job.lines.peek().forEach((raw, i) => {
    const text = stripComment(raw).trim().toUpperCase();
    if (text) lines.push({ text, line: i + 1 });
  });
  return lines;
}

/** HOLD: the job's own pause, or a feed hold of whatever the machine is doing. */
export function pauseJob(): void {
  if (!running) { rtSend('!'); log('info', 'Feed hold sent'); return; }
  paused = !paused;
  rtSend(paused ? '!' : '~');
  log('info', paused ? 'Feed hold sent' : 'Cycle resume sent');
  publishRunState();
  if (!paused) command.pump();
}

/** RESUME at a tool change: the cycle start, once every reply is in (command.ts). At our own M6 hold
 *  the controller is idle, so the job just carries on. */
export function resumeToolChange(): void {
  const r = currentRun;
  if (r && !r.hasEnded && r.m6State === 'held') {
    r.m6State = 'no';
    job.heldAtM6.value = false;
    job.changeEnded();
    log('info', 'Resume: the job goes on after the M6 on line ' + r.m6Line);
    command.pump();
    return;
  }
  command.resumeToolChange();
}

/** MEASURE at a tool change with $341 1 or 2: $TPW probes the new tool where it is and sets its
 *  length, over the touch plate with 1, at the toolsetter (G59.3) with 2. The tool change must be
 *  acknowledged first. */
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

// Stop: a feed hold, then the reset once a status report says the machine has stopped. A reset
// while moving loses the position (grblHAL raises ALARM 3). Homing can't be held, so Stop resets at
// once while homing. If the hold hasn't finished after STOP_TIMEOUT_MS, the reset goes anyway.

const STOP_TIMEOUT_MS = 10_000;
let pendingStop: { timer: ReturnType<typeof setTimeout> } | null = null;

/** STOP: ends the job being sent, if any, and stops the machine. */
export function stopJob(): void {
  if (!connection.connected.peek()) return;
  // A Start, stamp, warmup or Resume waiting on a reply doesn't go ahead after this.
  command.revokePending('Stop');
  if (currentRun && !currentRun.hasEnded) {
    endRun(currentRun);
    log('info', 'Job stopped');
    job.finished('stopped');
  }
  holdRetryUntil = 0;
  publishRunState();
  stopMachine();
}

/** The hold, then the reset when the machine has stopped. Also for Cancel in probing. */
export function stopMachine(): void {
  if (pendingStop || !command.isConnected()) return;
  rtSend('!');
  rtSend('?');
  pendingStop = { timer: setTimeout(() => finishStop(true), STOP_TIMEOUT_MS) };
  job.stopping.value = true;
  log('info', 'Stop: feed hold sent; the reset goes when the machine has stopped');
}

export function isStopping(): boolean { return !!pendingStop; }

function checkStopped(field: string): void {
  const stateName = field.split(':')[0];
  // Still decelerating: running, jogging, a hold or a door in progress.
  if (stateName === 'run' || stateName === 'jog' || field === 'hold:1' || field === 'door:2' || field === 'door:3') return;
  finishStop(false);
}

function finishStop(timedOut: boolean): void {
  if (!pendingStop) return;
  clearTimeout(pendingStop.timer);
  pendingStop = null;
  job.stopping.value = false;
  if (!command.isConnected()) return;
  rtSend('\x18');
  rereadAfterReset();
  if (timedOut) {
    const text = `The machine hadn't stopped ${STOP_TIMEOUT_MS / 1000} s after Stop, so the reset went anyway. The position may be lost: home again.`;
    log('err', text);
    messages.push('error', text);
  } else log('info', 'Stopped: soft reset sent');
}

/** The link went (connection.ts): no job is being sent any more. */
export function clearRunFlags(): void { running = false; paused = false; }

export function publishRunState(): void {
  job.running.value = running;
  job.paused.value = paused;
}

/** RESET: at once, moving or not. */
export function sendReset(): void {
  if (!connection.connected.peek()) return;
  command.revokePending('RESET');
  if (pendingStop) { clearTimeout(pendingStop.timer); pendingStop = null; job.stopping.value = false; }
  if (currentRun && !currentRun.hasEnded) { endRun(currentRun); job.finished('stopped'); }
  holdRetryUntil = 0;
  running = false; paused = false;
  rtSend('\x18');
  rereadAfterReset();
  log('info', 'Soft reset');
  publishRunState();
}

export function unlockAlarm(): void { import('./connection').then(c => c.sendCmd('$X')); }
export function sendHome(): void { import('./connection').then(c => c.sendCmd('$H')); }
// Absolute and in millimetres whatever the modal state (a probe can leave G91, a job G20).
export function goToXY0(): void { import('./jog').then(j => j.goToXY0()); }

export function selectWcs(code: string): void {
  import('./connection').then(c => {
    c.sendCmd(code);
    log('info', 'WCS set to ' + code);
  });
}

// ═══════════════════════════════════════════════
// JOB CONTROL — character-counting pump
// ═══════════════════════════════════════════════
//
// The job is a source for the command layer, which pulls its lines while they fit in the
// controller's RX buffer, through the same queue as every other command.

import { state } from './state';
import { byteLen } from './ui';
import { log } from './console';
import { rtSend } from './connection';
import * as command from './command';
import { updateProgress } from './gcode';
import { frActive, frEnabled, frJobLines } from './flight-recorder';
import * as job from './stores/job';

export interface SendLine { text: string; line: number; }

let inFlight = 0;   // job lines sent and not yet answered

const source: command.JobSource = {
  next(room) {
    if (!state.running || state.paused || state.lineHead >= state.sendLines.length) return null;
    const next = state.sendLines[state.lineHead];
    if (byteLen(next.text + '\n') > room) return null;
    state.lineHead++;
    inFlight++;
    if (next.line > 0) job.sentLine.value = next.line;
    updateProgress(next.line, state.gcodeLines.length);
    return next;
  },
  replied(line, reply) {
    inFlight = Math.max(0, inFlight - 1);
    if (!state.running) return;
    if (line.line > 0) job.ackedLine.value = line.line;
    if (reply.result === 'error') {
      state.running = false;
      command.endStream(source);
      updateRunButtons();
      log('alarm', 'Stream halted on error. Fix G-code and restart.');
      job.finished('error');
      return;
    }
    if (state.lineHead >= state.sendLines.length && inFlight === 0) {
      state.running = false;
      command.endStream(source);
      log('info', '✓ Job complete');
      updateRunButtons();
      job.finished('completed');
    }
  },
  dropped(why) {
    inFlight = 0;
    if (!state.running) return;
    state.running = false; state.paused = false;
    updateRunButtons();
    job.finished(why === 'alarm' ? 'alarm' : why === 'disconnected' ? 'link lost' : 'stopped');
  },
};

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
  job.started(recorded);
  streamLines(recorded ? frJobLines() : plainLines(), recorded);
}

/** Start streaming prepared lines, either a whole job or a resume (the moves back in, then the rest of the file). */
export function streamLines(lines: SendLine[], numbered: boolean): void {
  state.running = true; state.paused = false;
  state.sendLines = lines; state.jobNumbered = numbered;
  state.lineHead = 0; state.segmentIndex = 0;
  inFlight = 0;
  updateRunButtons();
  if (!lines.length) {
    state.running = false;
    log('info', '✓ Job complete');
    updateRunButtons();
    job.finished('completed');
    return;
  }
  command.stream(source);
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

export function pauseJob(): void {
  if (!state.running) return;
  state.paused = !state.paused;
  rtSend(state.paused ? '!' : '~');
  log('info', state.paused ? 'Feed hold sent' : 'Cycle resume sent');
  updateRunButtons();
  if (!state.paused) command.pump();
}

export function stopJob(): void {
  if (!state.running && !state.paused) return;
  state.running = false; state.paused = false;
  command.endStream(source);
  rtSend('!');
  // The hold first, so the machine decelerates and keeps its position; then the reset.
  setTimeout(() => rtSend('\x18'), 150);
  state.lineHead = 0;
  log('info', 'Job stopped — soft reset sent');
  updateRunButtons();
  job.finished('stopped');
}

export function updateRunButtons(): void {
  job.running.value = state.running;
  job.paused.value = state.paused;
}

export function sendReset(): void {
  if (!state.connected) return;
  if (state.running) job.finished('stopped');
  state.running = false; state.paused = false;
  command.endStream(source);
  rtSend('\x18');
  state.lineHead = 0;
  log('info', 'Soft reset');
  updateRunButtons();
}

export function unlockAlarm(): void { import('./connection').then(c => c.sendCmd('$X')); }
export function sendHome(): void { import('./connection').then(c => c.sendCmd('$H')); }
export function goToXY0(): void { import('./modules/jog').then(j => j.clearWaypoints()); import('./connection').then(c => c.sendCmd('G0 X0 Y0')); }

export function setWCS(code: string): void {
  state.activeWcs = code;
  import('./connection').then(c => {
    c.sendCmd(code);
    log('info', 'WCS set to ' + code);
  });
}

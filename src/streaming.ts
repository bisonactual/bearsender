// ═══════════════════════════════════════════════
// JOB CONTROL — character-counting pump
// ═══════════════════════════════════════════════

import { state } from './state';
import { byteLen } from './ui';
import { log } from './console';
import { cmdSend, rtSend } from './connection';
import { updateProgress } from './gcode';
import { frActive, frEnabled, frJobLines } from './flight-recorder';

export interface SendLine { text: string; line: number; }

export function startJob(): void {
  if (!state.connected) { log('err', 'Not connected'); return; }
  if (state.gcodeLines.length === 0) { log('err', 'No file loaded'); return; }
  if (state.running && !state.paused) return;
  if (state.paused) {
    state.paused = false;
    rtSend('~');
    log('info', 'Resumed');
    updateRunButtons();
    return;
  }
  const recorded = frActive();
  if (frEnabled() && !recorded) log('info', '✈ The flight recorder is on, but this controller has no Flight Recorder plugin. Running without a record.');
  log('info', 'Starting job: ' + state.gcodeLines.length + ' lines  (RX buffer: ' + state.RX_BUFFER_SIZE + ' bytes)' +
      (recorded ? '  flight recorder on' : ''));
  streamLines(recorded ? frJobLines() : plainLines(), recorded);
}

/** Start streaming prepared lines, either a whole job or a resume (the moves back in, then the rest of the file). */
export function streamLines(lines: SendLine[], numbered: boolean): void {
  state.running = true; state.paused = false;
  state.sendLines = lines; state.jobNumbered = numbered;
  state.lineHead = 0; state.rxInFlight = 0; state.sentQueue.length = 0; state.segmentIndex = 0;
  state.esPhase = 'idle';
  updateRunButtons();
  pumpQueue();
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

export function pumpQueue(): void {
  if (!state.running || state.paused) return;
  try { _pumpQueue(); } catch (e: any) { log('err', 'pumpQueue: ' + e.message); state.running = false; updateRunButtons(); }
}

function _pumpQueue(): void {
  const hwm = state.RX_BUFFER_SIZE - 1;

  while (state.lineHead < state.sendLines.length) {
    const { text, line } = state.sendLines[state.lineHead];
    const wouldCost = byteLen(text + '\n');

    if (state.rxInFlight + wouldCost > hwm) break;

    cmdSend(text);
    log('tx', text);
    state.lineHead++;
    updateProgress(line, state.gcodeLines.length);
  }

  if (state.lineHead >= state.sendLines.length && state.sentQueue.length === 0 && state.running) {
    state.running = false;
    log('info', '✓ Job complete');
    updateRunButtons();
  }
}

export function pauseJob(): void {
  if (!state.running) return;
  state.paused = !state.paused;
  rtSend(state.paused ? '!' : '~');
  log('info', state.paused ? 'Feed hold sent' : 'Cycle resume sent');
  updateRunButtons();
}

export function stopJob(): void {
  if (!state.running && !state.paused) return;
  state.running = false; state.paused = false;
  rtSend('!');
  setTimeout(() => rtSend('\x18'), 150);
  state.rxInFlight = 0; state.sentQueue.length = 0; state.lineHead = 0;
  log('info', 'Job stopped — soft reset sent');
  updateRunButtons();
}

export function updateRunButtons(): void {
  ['btnStart'].forEach(id => { (document.getElementById(id) as HTMLButtonElement).disabled = state.running && !state.paused; });
  ['btnPause'].forEach(id => { (document.getElementById(id) as HTMLButtonElement).disabled = !state.running; });
  ['btnStop'].forEach(id => { (document.getElementById(id) as HTMLButtonElement).disabled = !state.running && !state.paused; });
}

export function sendReset(): void {
  if (!state.connected) return;
  rtSend('\x18');
  state.running = false; state.paused = false;
  state.rxInFlight = 0; state.sentQueue.length = 0; state.lineHead = 0;
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

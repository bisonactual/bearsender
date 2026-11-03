// ═══════════════════════════════════════════════
// Connection layer — WebSocket & USB/Serial
// ═══════════════════════════════════════════════
//
// The transports only. Every line and every real-time byte goes through the command layer
// (command.ts), which matches the replies.

import { state, POLL_NORM } from './state';
import { lsGet } from './ui';
import { log } from './console';
import * as command from './command';
import { updateRunButtons } from './streaming';
import { ezResetPluginState, ezCheckPlugin, ezConnected } from './exclusion-zones';
import { frEnabled, frCheckPlugin, frConnected, frDisconnected } from './flight-recorder';
import { loadSettings, forgetSettings } from './settings';
import { loadOffsets, renderOffsetsTable } from './offsets';
import { readSetupState } from './app/asks';
import { batch } from '@preact/signals';
import * as connection from './stores/connection';
import * as machine from './stores/machine';
import * as job from './stores/job';
import * as messages from './stores/messages';

// ── Poll rate ─────────────────────────────────────────────────────────────────
export function setPollRate(ms: number): void {
  if (state.statusInterval) clearInterval(state.statusInterval);
  state.statusInterval = setInterval(() => { if (state.connected) rtSend('?'); }, ms);
}

export function setJogging(active: boolean): void {
  if (state._isJogging === active) return;
  state._isJogging = active;
  if (state.connected) setPollRate(active ? 50 : POLL_NORM);
}

// ── Top-level connect/disconnect ──────────────────────────────────────────────
export function toggleConnect(): void {
  state.connected ? disconnect() : connect();
}

function connect(): void {
  if (connection.settings.value.mode === 'serial') connectSerial();
  else connectWs();
}

function disconnect(): void {
  if (connection.settings.value.mode === 'serial') disconnectSerial();
  else disconnectWs();
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connectWs(): void {
  const url = connection.settings.value.wsUrl.trim();
  if (!url) { messages.push('link', 'No controller address. Set it in Settings, Options.'); return; }
  connection.transport.value = 'websocket';
  connection.address.value = url;
  setStatus('connecting');
  log('info', 'Connecting to ' + url + '…');
  try {
    state.ws = new WebSocket(url);
    state.ws.onopen = onOpen;
    state.ws.onmessage = onMessage;
    state.ws.onclose = onClose;
    state.ws.onerror = () => { log('err', 'WebSocket error — check URL and that the controller is reachable'); };
  } catch (e: any) { log('err', 'Connection failed: ' + e.message); setStatus('disconnected'); }
}

function disconnectWs(): void { if (state.ws) state.ws.close(); }

function feedBuffer(chunk: string): void {
  state._rxBuf += chunk;
  batch(() => {
    let nl;
    while ((nl = state._rxBuf.indexOf('\n')) !== -1) {
      const line = state._rxBuf.slice(0, nl).replace(/\r$/, '').trim();
      state._rxBuf = state._rxBuf.slice(nl + 1);
      if (line) command.receive(line);
    }
  });
}

function onMessage(evt: MessageEvent): void {
  feedBuffer(evt.data);
}

// ── USB / Serial ──────────────────────────────────────────────────────────────
async function connectSerial(): Promise<void> {
  if (!(navigator as any).serial) {
    log('err', 'Web Serial API not supported — use Chrome or Edge');
    return;
  }
  try {
    setStatus('connecting');
    log('info', 'Opening port picker…');
    state.serialPort = await (navigator as any).serial.requestPort();
    const link = connection.settings.value;
    const baud = parseInt(link.baud) || 115200;
    const dataBits = parseInt(link.dataBits) || 8;
    const stopBits = parseInt(link.stopBits) || 1;
    const parity = link.parity || 'none';
    await state.serialPort.open({ baudRate: baud, dataBits, stopBits, parity });

    const info = state.serialPort.getInfo();
    const label = info.usbVendorId
      ? `USB ${info.usbVendorId.toString(16).toUpperCase()}:${(info.usbProductId || 0).toString(16).toUpperCase()} @ ${baud}`
      : `Serial @ ${baud}`;
    connection.transport.value = 'serial';
    connection.address.value = label;

    state.serialAbort = new AbortController();
    state.serialWriter = state.serialPort.writable.getWriter();
    state.serialReader = state.serialPort.readable.getReader();

    serialReadLoop();
    onOpen();
    log('info', `Serial connected — ${baud} baud`);
  } catch (e: any) {
    if (e.name !== 'NotFoundError') log('err', 'Serial error: ' + e.message);
    setStatus('disconnected');
    state.serialPort = null; state.serialWriter = null; state.serialReader = null;
  }
}

async function serialReadLoop(): Promise<void> {
  try {
    while (true) {
      const { value, done } = await state.serialReader.read();
      if (done) break;
      feedBuffer(new TextDecoder().decode(value));
    }
  } catch (e: any) {
    if (e.name !== 'AbortError') log('err', 'Serial read error: ' + e.message);
  } finally {
    if (state.connected) onClose();
  }
}

async function disconnectSerial(): Promise<void> {
  try {
    if (state.serialReader) { await state.serialReader.cancel(); state.serialReader.releaseLock(); state.serialReader = null; }
    if (state.serialWriter) { state.serialWriter.releaseLock(); state.serialWriter = null; }
    if (state.serialPort) { await state.serialPort.close(); state.serialPort = null; }
  } catch (_) { /* ignore close errors */ }
  onClose();
}

// ── Shared open / close handlers ─────────────────────────────────────────────
function onOpen(): void {
  state.connected = true;
  state._rxBuf = '';
  setStatus('connected');
  log('info', connection.settings.value.mode === 'serial' ? 'Serial connected' : 'WebSocket connected');
  messages.push('link', 'Connected to ' + connection.address.value + '.');
  setPollRate(POLL_NORM);
  // No reset with the flight recorder on. If the last job lost its sender the controller may
  // still be retracting, and a reset would stop it half way. Either way the command layer gets
  // the line in step first, waiting as long as the controller takes to answer.
  command.connected(write, { reset: !frEnabled() });
  afterConnect();
  const fb = document.getElementById('limitsFrameBtn') as HTMLButtonElement | null;
  if (fb && state.progLimits) fb.disabled = false;
}

/** What is read from the controller on connecting, one command after another. */
async function afterConnect(): Promise<void> {
  const steps: (() => Promise<unknown>)[] = [
    async () => readBuildInfo((await command.send('$I+', { log: true })).lines),
    // Report units first: positions and offsets are read into mm by it (units.ts).
    () => command.send('$13', { quiet: true }),
    frConnected,
    ezConnected,
    async () => { if (lsGet('fs-opt-autoload-settings', false)) await loadSettings(); },
    loadOffsets,
    readSetupState,
  ];
  for (const step of steps) {
    try { await step(); }
    catch (e) {
      if (!(e instanceof command.CommandFailed)) throw e;
      if (!command.isConnected()) return;
    }
  }
}

/** The $I+ reply: firmware, RX buffer, axes and plugins. */
function readBuildInfo(lines: string[]): void {
  for (const line of lines) {
    if (line.startsWith('[VER:')) connection.firmware.value = line.slice(5, -1).split(':')[0];
    const opt = line.match(/^\[OPT:[^,]*,(\d+),(\d+)/);
    if (opt && parseInt(opt[2]) > 0) {
      state.RX_BUFFER_SIZE = parseInt(opt[2]);
      command.setRxBufferSize(state.RX_BUFFER_SIZE);
      log('info', 'RX buffer: ' + state.RX_BUFFER_SIZE + ' bytes  planner blocks: ' + opt[1]);
    }
    const axes = line.match(/^\[AXS:\d+:([A-Z]+)\]/);
    if (axes) { state.controllerAxes = axes[1].split(''); log('info', 'Axes: ' + state.controllerAxes.join(',')); }
    ezCheckPlugin(line);
    frCheckPlugin(line);
  }
}

command.onSync(s => {
  if (s.syncing && s.retries === 1) log('info', frEnabled()
    ? '✈ Waiting for the controller to answer. It may be finishing a retract after the lost connection.'
    : 'Waiting for the controller to answer.');
  if (s.gaveUp) log('err', 'The controller has not answered for 90 s. Reset it to carry on.');
});
command.onReply(() => updateBufDisplay());

function onClose(): void {
  const wasRunning = state.running;
  state.connected = false;
  command.disconnected();
  setStatus('disconnected');
  log('info', 'Disconnected');
  messages.push('link', 'Disconnected.');
  if (state.statusInterval) clearInterval(state.statusInterval);
  state.running = false; state.paused = false;
  if (wasRunning) job.finished('link lost');
  batch(() => {
    machine.state.value = '';
    machine.wco.value = null;
    machine.offsets.value = {};
    machine.offsetsRead.value = false;
    machine.offsetsAtConnect.value = null;
    machine.offsetWrites.value = {};
    machine.tlo.value = null;
    machine.toolTable.value = null;
    machine.toolTableError.value = null;
    machine.alarm.value = null;
    machine.tool.value = null;
    machine.homed.value = false;
    machine.feed.value = 0;
    machine.spindle.value = 0;
    connection.firmware.value = '';
  });
  updateRunButtons();
  const fb = document.getElementById('limitsFrameBtn') as HTMLButtonElement | null;
  if (fb) fb.disabled = true;
  state.machineHomed = false; state._prevMachineStateSl = ''; _updateHomeBtnHomed();
  state.wcsOffsets = {};
  state.tloOffset = 0;
  state.tloActive = false;
  renderOffsetsTable();
  ezResetPluginState();
  forgetSettings();
  frDisconnected();
}

// ── Send helpers ──────────────────────────────────────────────────────────────

/** Writes to the open link. Only the command layer calls it. */
function write(data: string): boolean {
  if (connection.settings.value.mode === 'serial') {
    if (!state.serialWriter) return false;
    state.serialWriter.write(new TextEncoder().encode(data)).catch(() => {});
    return true;
  }
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return false;
  state.ws.send(data);
  return true;
}

/** A real-time byte: ?, !, ~, 0x18, 0x85, 0x87, the overrides. */
export function rtSend(char: string): void { command.realtime(char); }

/** Sends a line (or several, one per line) that nobody waits for. command.send() gives the reply. */
export function sendCmd(cmd: string): void {
  if (!state.connected) { log('err', 'Not connected'); return; }
  command.post(cmd);
}

// ── Status display ────────────────────────────────────────────────────────────
export function setStatus(s: 'disconnected' | 'connecting' | 'connected'): void {
  connection.status.value = s;
}

export function updateBufDisplay(): void {
  const el = document.getElementById('bufVal');
  if (el) el.textContent = 'RX: ' + command.stats().bytes + '/' + state.RX_BUFFER_SIZE + 'B';
}

/** Homed after a homing cycle. Otherwise the store follows the controller's own H: field (and an
 *  alarm clears it until a full report says otherwise: parser.ts). */
export function _updateHomeBtnHomed(): void {
  if (state.machineHomed) machine.homed.value = true;
}

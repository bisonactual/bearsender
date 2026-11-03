// ═══════════════════════════════════════════════
// Connection layer — WebSocket & USB/Serial
// ═══════════════════════════════════════════════
//
// The transports only. Every line and every real-time byte goes through the command layer
// (command.ts), which matches the replies.

import { lsGet } from './ui';
import { log } from './console';
import * as command from './command';
import { updateRunButtons, clearRunFlags } from './streaming';
import { ezResetPluginState, ezCheckPlugin, ezConnected } from './exclusion-zones';
import { frEnabled, frCheckPlugin, frConnected, frDisconnected } from './flight-recorder';
import { loadSettings, forgetSettings } from './settings';
import { loadOffsets } from './offsets';
import { resetMachineState } from './parser';
import { readSetupState } from './app/asks';
import { batch } from '@preact/signals';
import * as connection from './stores/connection';
import * as machine from './stores/machine';
import * as job from './stores/job';
import * as messages from './stores/messages';

// The open link: a WebSocket, or a serial port with its reader and writer; what came in short of a line
// end; the status poll; and whether a jog is under way (it polls faster).
let ws: WebSocket | null = null;
let serialPort: any = null;
let serialWriter: any = null;
let serialReader: any = null;
let serialAbort: AbortController | null = null;
let rxBuf = '';
let statusInterval: ReturnType<typeof setInterval> | null = null;
let jogging = false;
const POLL_NORM = 100;

// ── Poll rate ─────────────────────────────────────────────────────────────────
export function setPollRate(ms: number): void {
  if (statusInterval) clearInterval(statusInterval);
  statusInterval = setInterval(() => { if (connection.connected.peek()) rtSend('?'); }, ms);
}

export function setJogging(active: boolean): void {
  if (jogging === active) return;
  jogging = active;
  if (connection.connected.peek()) setPollRate(active ? 50 : POLL_NORM);
}

// ── Top-level connect/disconnect ──────────────────────────────────────────────
export function toggleConnect(): void {
  connection.connected.peek() ? disconnect() : connect();
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
    ws = new WebSocket(url);
    ws.onopen = onOpen;
    ws.onmessage = onMessage;
    ws.onclose = onClose;
    ws.onerror = () => { log('err', 'WebSocket error — check URL and that the controller is reachable'); };
  } catch (e: any) { log('err', 'Connection failed: ' + e.message); setStatus('disconnected'); }
}

function disconnectWs(): void { if (ws) ws.close(); }

function feedBuffer(chunk: string): void {
  rxBuf += chunk;
  batch(() => {
    let nl;
    while ((nl = rxBuf.indexOf('\n')) !== -1) {
      const line = rxBuf.slice(0, nl).replace(/\r$/, '').trim();
      rxBuf = rxBuf.slice(nl + 1);
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
    serialPort = await (navigator as any).serial.requestPort();
    const link = connection.settings.value;
    const baud = parseInt(link.baud) || 115200;
    const dataBits = parseInt(link.dataBits) || 8;
    const stopBits = parseInt(link.stopBits) || 1;
    const parity = link.parity || 'none';
    await serialPort.open({ baudRate: baud, dataBits, stopBits, parity });

    const info = serialPort.getInfo();
    const label = info.usbVendorId
      ? `USB ${info.usbVendorId.toString(16).toUpperCase()}:${(info.usbProductId || 0).toString(16).toUpperCase()} @ ${baud}`
      : `Serial @ ${baud}`;
    connection.transport.value = 'serial';
    connection.address.value = label;

    serialAbort = new AbortController();
    serialWriter = serialPort.writable.getWriter();
    serialReader = serialPort.readable.getReader();

    serialReadLoop();
    onOpen();
    log('info', `Serial connected — ${baud} baud`);
  } catch (e: any) {
    if (e.name !== 'NotFoundError') log('err', 'Serial error: ' + e.message);
    setStatus('disconnected');
    serialPort = null; serialWriter = null; serialReader = null;
  }
}

async function serialReadLoop(): Promise<void> {
  try {
    while (true) {
      const { value, done } = await serialReader.read();
      if (done) break;
      feedBuffer(new TextDecoder().decode(value));
    }
  } catch (e: any) {
    if (e.name !== 'AbortError') log('err', 'Serial read error: ' + e.message);
  } finally {
    if (connection.connected.peek()) onClose();
  }
}

async function disconnectSerial(): Promise<void> {
  try {
    if (serialReader) { await serialReader.cancel(); serialReader.releaseLock(); serialReader = null; }
    if (serialWriter) { serialWriter.releaseLock(); serialWriter = null; }
    if (serialPort) { await serialPort.close(); serialPort = null; }
  } catch (_) { /* ignore close errors */ }
  onClose();
}

// ── Shared open / close handlers ─────────────────────────────────────────────
function onOpen(): void {
  rxBuf = '';
  setStatus('connected');
  log('info', connection.settings.value.mode === 'serial' ? 'Serial connected' : 'WebSocket connected');
  messages.push('link', 'Connected to ' + connection.address.value + '.');
  setPollRate(POLL_NORM);
  // No reset with the flight recorder on. If the last job lost its sender the controller may
  // still be retracting, and a reset would stop it half way. Either way the command layer gets
  // the line in step first, waiting as long as the controller takes to answer.
  command.connected(write, { reset: !frEnabled() });
  afterConnect();
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
    // In the power-up alarm $# is refused: loadOffsets sends nothing then, so the state must be known.
    stateKnown,
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

/** Waits up to a second for the first status report. */
async function stateKnown(): Promise<void> {
  for (let i = 0; i < 20 && !machine.state.peek() && command.isConnected(); i++) await new Promise(r => setTimeout(r, 50));
}

/** The $I+ reply: firmware, RX buffer, axes and plugins. */
function readBuildInfo(lines: string[]): void {
  for (const line of lines) {
    if (line.startsWith('[VER:')) connection.firmware.value = line.slice(5, -1).split(':')[0];
    const opt = line.match(/^\[OPT:[^,]*,(\d+),(\d+)/);
    if (opt && parseInt(opt[2]) > 0) {
      const size = parseInt(opt[2]);
      command.setRxBufferSize(size);
      log('info', 'RX buffer: ' + size + ' bytes  planner blocks: ' + opt[1]);
    }
    const axes = line.match(/^\[AXS:\d+:([A-Z]+)\]/);
    if (axes) {
      machine.axes.value = axes[1].split('');
      log('info', 'Axes: ' + machine.axes.value.join(','));
    }
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

function onClose(): void {
  const wasRunning = job.running.peek();
  setStatus('disconnected');
  command.disconnected();
  setStatus('disconnected');
  log('info', 'Disconnected');
  messages.push('link', 'Disconnected.');
  if (statusInterval) clearInterval(statusInterval);
  clearRunFlags();
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
    machine.axes.value = ['X', 'Y', 'Z'];
    machine.mposExtra.value = [];
    machine.wcoExtra.value = null;
    machine.feed.value = 0;
    machine.spindle.value = 0;
    connection.firmware.value = '';
  });
  updateRunButtons();
  resetMachineState();
  ezResetPluginState();
  forgetSettings();
  frDisconnected();
}

// ── Send helpers ──────────────────────────────────────────────────────────────

/** Writes to the open link. Only the command layer calls it. A real-time byte from 0x80 up (0x85, 0x87,
 *  the overrides, the coolant toggles) goes as that one byte. As text it would go as UTF-8, 0xC2 first:
 *  grblHAL acts on the second byte and keeps the 0xC2, which starts the next line, so a $ line after it
 *  is read as G-code (error:9 in an alarm, error:71 when idle). Over WebSocket it goes in a binary
 *  frame, whose bytes grblHAL's websocketd puts into the input as it does a text frame's. */
function write(data: string): boolean {
  const raw = data.length === 1 && data.charCodeAt(0) >= 0x80 ? new Uint8Array([data.charCodeAt(0)]) : null;
  if (connection.settings.value.mode === 'serial') {
    if (!serialWriter) return false;
    serialWriter.write(raw ?? new TextEncoder().encode(data)).catch(() => {});
    return true;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(raw ?? data);
  return true;
}

/** A real-time byte: ?, !, ~, 0x18, 0x85, 0x87, the overrides. */
export function rtSend(char: string): void { command.realtime(char); }

/** Sends a line (or several, one per line) that nobody waits for. command.send() gives the reply. */
export function sendCmd(cmd: string): void {
  if (!connection.connected.peek()) { log('err', 'Not connected'); return; }
  command.post(cmd);
}

// ── Status display ────────────────────────────────────────────────────────────
export function setStatus(s: 'disconnected' | 'connecting' | 'connected'): void {
  connection.status.value = s;
}



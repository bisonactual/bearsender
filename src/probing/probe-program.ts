// ═══════════════════════════════════════════════
// Core probing engine — WCS mapping, probe/idle
// waiting, tool length sequences
// ═══════════════════════════════════════════════
//
// Each step waits for its own reply through the command layer. A probing move (G38.3) is answered
// once the probe cycle has ended, with the [PRB:] line before its ok when $10 asks for it; without
// that, $# gives the same line. A move is answered once it is planned, so G4 P0 goes after it: its
// ok comes when the planner is empty, that is, when the machine has stopped there.
//
// Every move and write says G21: the distances are millimetres whatever the last job left. A
// routine reads the distance mode and units first ($G) and puts them back when it ends, however it
// ends, so its G91 moves don't leave the next move incremental. If that $G gets no answer (a reset or
// a banner came first), the routine doesn't start: the modes to put back aren't known. Cancel takes
// back the routine's commands not sent yet, including those held while the line is synced, and stops
// the move in progress (a hold, then the reset once the machine has stopped); the routine owns the
// machine until then.

import { state } from '../state';
import { log } from '../console';
import { sendCmd } from '../connection';
import { stopMachine, isStopping } from '../streaming';
import { reportMm } from '../units';
import * as command from '../command';
import * as machine from '../stores/machine';
import { progress as warmupProgress } from '../warmup';

export const WCS_P: Record<string, number> = {
  G54: 1,
  G55: 2,
  G56: 3,
  G57: 4,
  G58: 5,
  G59: 6,
  'G59.1': 7,
  'G59.2': 8,
  'G59.3': 9,
};

let _running = false;
let _cancelled = false;
let _cancel: (() => void) | null = null;   // ends the wait of the step in progress
const OWNER = {};                          // the routine's commands, for Cancel (command.cancelOwned)

interface ProbeResult {
  x: number;
  y: number;
  z: number;
  success: boolean;
}

/** The work offset in use, from the status report (a program or the console may have changed it). */
export function getActiveWcs(): string {
  return machine.wcs.value || (state as any).activeWcs || 'G54';
}

export function applyXYResult(x: number, y: number, axes: string, opts: { mode?: string; wcs?: string; xOffset?: number; yOffset?: number }): void {
  const wcs = opts.wcs || getActiveWcs();
  const xOff = opts.xOffset ?? 0;
  const yOff = opts.yOffset ?? 0;
  const fx = (x + xOff).toFixed(4);
  const fy = (y + yOff).toFixed(4);
  // G10 writes the work offset; anything else is measure only. (G92 was dropped: the owner, 3 Nov.)
  if (opts.mode === 'G10') {
    const p = WCS_P[wcs] ?? 1;
    const parts = axes === 'XY' ? `X${fx}Y${fy}` : axes === 'X' ? `X${fx}` : `Y${fy}`;
    sendCmd(`G21G10L2P${p}${parts}`);
  }
  log('info', `Probed ${axes}: X=${fx} Y=${fy} → ${wcs} (${opts.mode})`);
}

export function applyZResult(z: number, plateHeight: number, wcsHeight: number, opts: { mode?: string; wcs?: string }): void {
  const wcs = opts.wcs || getActiveWcs();
  const fz = (z - plateHeight - wcsHeight).toFixed(4);
  if (opts.mode === 'G10') {
    const p = WCS_P[wcs] ?? 1;
    sendCmd(`G21G10L2P${p}Z${fz}`);
  }
  log('info', `Probed Z: raw=${z.toFixed(4)} plate=${plateHeight} → Z${fz} → ${wcs} (${opts.mode})`);
}

export function isProbingRunning(): boolean {
  return _running;
}

/** Why a probing routine wouldn't start now, or null if it would. */
export function probingRefusal(): string | null {
  if (!state.connected) return 'Not connected';
  if (_running) return 'Probing already in progress';
  if (warmupProgress.value) return 'The machine warmup is running, so nothing was sent. Stop it, or let it end.';
  // Sent now, a probe would wait unread in the controller and run after the Resume, in the job.
  if (machine.stateName.value === 'tool' && !command.toolChangeAcknowledged())
    return 'The controller is at a tool change and reads no commands until Resume, so nothing was sent.';
  return null;
}

/** Runs a probing sequence: one at a time, and Cancel ends it. */
export async function runProbing<T>(sequence: () => Promise<T>): Promise<T | null> {
  const refusal = probingRefusal();
  if (refusal) { log('err', refusal); return null; }
  _running = true;
  _cancelled = false;
  const modes = await readModes();
  if (modes === null || _cancelled) { _running = false; return null; }
  try {
    return await sequence();
  } finally {
    _cancel = null;
    // After a Cancel, the reset comes first (it puts back grblHAL's own defaults).
    while (isStopping()) await new Promise(r => setTimeout(r, 50));
    await restoreModes(modes);
    _running = false;
  }
}

/** The distance mode and units now, from the [GC:] line that $G brings: as "G21G90". Null when $G
 *  got no answer or was refused: the [GC:] held may be from before a reset. */
async function readModes(): Promise<string | null> {
  let reply: command.Reply;
  try { reply = await command.send('$G', { owner: OWNER }); }
  catch (e) {
    if (!(e instanceof command.CommandFailed)) throw e;
    if (e.why !== 'cancelled') log('err', `Probing didn't start: $G got no answer (${e.why}), so the modes to put back afterwards aren't known. Nothing was sent.`);
    return null;
  }
  if (reply.result !== 'ok') { log('err', `Probing didn't start: $G was refused (error:${reply.code}). Nothing was sent.`); return null; }
  const words = machine.modal.value;
  return (words.includes('G20') ? 'G20' : 'G21') + (words.includes('G91') ? 'G91' : 'G90');
}

async function restoreModes(modes: string): Promise<void> {
  try {
    const reply = await command.send(modes, { quiet: true });
    if (reply.result === 'ok') log('info', `Probing ended: ${modes} as before`);
    else log('err', `Probing ended, but ${modes} was refused (error:${reply.code}): check the distance mode and units before the next move`);
  } catch (e) {
    if (!(e instanceof command.CommandFailed)) throw e;
    log('err', `Probing ended without putting back ${modes} (${e.why}): check the distance mode and units before the next move`);
  }
}

/** The promise's value, or null if it fails or Cancel is pressed first. */
function orCancel<T>(p: Promise<T>): Promise<T | null> {
  return new Promise(resolve => {
    if (_cancelled) { resolve(null); return; }
    _cancel = () => resolve(null);
    p.then(v => { _cancel = null; resolve(v); }, () => { _cancel = null; resolve(null); });
  });
}

function parseProbe(lines: string[]): ProbeResult | null {
  for (const raw of lines) {
    const m = raw.match(/^\[PRB:([^,]+),([^,]+),([^:]+):(\d)\]$/);
    if (m) return { x: reportMm(parseFloat(m[1])), y: reportMm(parseFloat(m[2])), z: reportMm(parseFloat(m[3])), success: m[4] === '1' };
  }
  return null;
}

/** A probing move, and where it touched. */
async function probeMove(cmd: string): Promise<ProbeResult | null> {
  if (_cancelled) return null;
  const reply = await orCancel(command.send('G21' + cmd, { log: true, owner: OWNER }));
  if (!reply || reply.result !== 'ok') return null;
  const result = parseProbe(reply.lines);
  if (result) return result;
  const params = await orCancel(command.send('$#', { owner: OWNER }));
  return params ? parseProbe(params.lines) : null;
}

/** A move, waiting until the machine has stopped at its end. */
async function sendAndWait(cmd: string): Promise<boolean> {
  if (_cancelled) return false;
  const replies = await orCancel(Promise.all([command.send('G21' + cmd, { log: true, owner: OWNER }), command.send('G4P0', { owner: OWNER })]));
  return !!replies && replies.every(r => r.result === 'ok');
}

/** Cancel: the routine's commands not sent yet are taken back, and a move in progress is stopped. */
export function cancelProbing(): void {
  if (!_running) return;
  _cancelled = true;
  if (_cancel) { _cancel(); _cancel = null; }
  // A $G or $# in flight moves nothing; a move or a dwell behind one may still be under way.
  if (command.cancelOwned(OWNER).some(c => !c.startsWith('$'))) {
    log('info', 'Probing cancelled: stopping the move in progress');
    stopMachine();
  } else log('info', 'Probing cancelled: no move of it was in flight, and what was still to send was taken back');
}

export async function runToolLengthProbe(seq: any): Promise<ProbeResult | null> {
  (window as any).clearPreview3D?.();
  return runProbing(() => seq.mode === 'toolsetter' ? runToolsetterSequence(seq) : runTouchplateSequence(seq));
}

export async function probeAxis(
  axis: string, direction: number,
  probeFeedRate: number, latchFeedRate: number,
  probeDistance: number, latchDistance: number
): Promise<ProbeResult | null> {
  if (_cancelled) return null;
  const sign = direction < 0 ? '-' : '';
  const dist = probeDistance.toFixed(4);
  const latch = latchDistance.toFixed(4);
  const latch2 = (latchDistance * 2).toFixed(4);
  const fast = await probeMove(`G38.3G91F${probeFeedRate}${axis}${sign}${dist}`);
  if (!fast || !fast.success) return null;
  const retractSign = direction < 0 ? '' : '-';
  if (!await sendAndWait(`G91G0${axis}${retractSign}${latch}`)) return null;
  const slow = await probeMove(`G38.3G91F${latchFeedRate}${axis}${sign}${latch2}`);
  if (!slow || !slow.success) return null;
  if (!await sendAndWait(`G91G0${axis}${retractSign}${latch}`)) return null;
  return slow;
}

export async function rapidToMPos(x: number | null, y: number | null, z: number | null): Promise<boolean> {
  if (_cancelled) return false;
  let cmd = 'G53G0';
  if (x !== null) cmd += `X${x.toFixed(4)}`;
  if (y !== null) cmd += `Y${y.toFixed(4)}`;
  if (z !== null) cmd += `Z${z.toFixed(4)}`;
  return sendAndWait(cmd);
}

async function runTouchplateSequence(seq: any): Promise<ProbeResult | null> {
  log('info', '⊕ Touch plate probe starting…');
  const startZ = (state as any).machineZ;
  const fastResult = await probeMove(`G38.3G91F${seq.probeFeedRate}Z-${seq.probeDistance.toFixed(4)}`);
  if (!fastResult || !fastResult.success) {
    log('err', '✗ Probe: no contact on fast probe — check probe wiring and position');
    await sendAndWait(`G91G0Z${seq.latchDistance.toFixed(4)}`);
    return null;
  }
  if (!await sendAndWait(`G91G0Z${seq.latchDistance.toFixed(4)}`)) {
    log('err', '✗ Probe: failed to retract after fast probe');
    return null;
  }
  const slowResult = await probeMove(`G38.3G91F${seq.latchFeedRate}Z-${(seq.latchDistance * 2).toFixed(4)}`);
  if (!slowResult || !slowResult.success) {
    log('err', '✗ Probe: no contact on slow probe');
    await sendAndWait(`G91G0Z${seq.latchDistance.toFixed(4)}`);
    return null;
  }
  // Back up to where it started. (It read the Z it was at, so it stayed on the plate.)
  await sendAndWait(`G90G53G0Z${startZ.toFixed(4)}`);
  log('info', `✓ Touch plate probe: Z=${slowResult.z.toFixed(4)}`);
  return slowResult;
}

async function runToolsetterSequence(seq: any): Promise<ProbeResult | null> {
  if (seq.toolsetterX === undefined || seq.toolsetterY === undefined || seq.toolsetterZ === undefined) {
    log('err', '✗ Toolsetter: G59.3 position not set — configure it in the Offsets tab');
    return null;
  }
  const startX = (state as any).machineX;
  const startY = (state as any).machineY;
  const startZ = (state as any).machineZ;
  const depth = seq.toolsetterDepth ?? 10;
  log('info', '⊕ Toolsetter probe starting…');
  if (!await sendAndWait(`G53G0Z0`)) { log('err', '✗ Toolsetter: could not rapid to Z home'); return null; }
  if (!await sendAndWait(`G53G0X${seq.toolsetterX.toFixed(4)}Y${seq.toolsetterY.toFixed(4)}`)) {
    log('err', '✗ Toolsetter: could not rapid to toolsetter XY'); return null;
  }
  const approachZ = seq.toolsetterZ + depth;
  if (!await sendAndWait(`G53G0Z${approachZ.toFixed(4)}`)) {
    log('err', '✗ Toolsetter: could not approach toolsetter Z'); return null;
  }
  const fastResult = await probeMove(`G38.3G91F${seq.probeFeedRate}Z-${(depth + 5).toFixed(4)}`);
  if (!fastResult || !fastResult.success) {
    log('err', '✗ Toolsetter: no contact on fast probe');
    await sendAndWait(`G53G0Z0`);
    await sendAndWait(`G53G0X${startX.toFixed(4)}Y${startY.toFixed(4)}`);
    return null;
  }
  if (!await sendAndWait(`G91G0Z${seq.latchDistance.toFixed(4)}`)) {
    log('err', '✗ Toolsetter: failed to retract'); return null;
  }
  const slowResult = await probeMove(`G38.3G91F${seq.latchFeedRate}Z-${(seq.latchDistance * 2).toFixed(4)}`);
  if (!slowResult || !slowResult.success) {
    log('err', '✗ Toolsetter: no contact on slow probe');
    await sendAndWait(`G53G0Z0`);
    await sendAndWait(`G53G0X${startX.toFixed(4)}Y${startY.toFixed(4)}`);
    return null;
  }
  await sendAndWait(`G53G0Z0`);
  await sendAndWait(`G53G0X${startX.toFixed(4)}Y${startY.toFixed(4)}`);
  await sendAndWait(`G53G0Z${startZ.toFixed(4)}`);
  log('info', `✓ Toolsetter probe: Z=${slowResult.z.toFixed(4)}`);
  return slowResult;
}

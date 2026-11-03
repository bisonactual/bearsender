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
// Every move says G21 G94: the distances are millimetres and the feeds mm/min whatever the last job
// left (in G93 a feed is a time, and the probe would go faster than set). A routine reads the units,
// the distance mode and the feed mode first ($G); it writes its result while it still owns the
// machine, then puts the modes back, however it ends, so "as before" holds at the end. If that $G
// gets no answer (a reset or a banner came first), the routine doesn't start: the modes to put back
// aren't known. Cancel takes back the routine's commands not sent yet, including those held while
// the line is synced, and stops the move in progress (a hold, then the reset once the machine has
// stopped); the routine owns the machine until then. Once its result is being written, Cancel has
// nothing left to stop and isn't taken: a Cancel that is taken means nothing was written.

import { log } from '../console';
import { stopMachine, isStopping } from '../streaming';
import { reportMm } from '../units';
import * as command from '../command';
import * as machine from '../stores/machine';
import * as connection from '../stores/connection';
import { progress as warmupProgress } from '../warmup';
import { Stop, Miss, afterMiss } from './io';
import type { Io, Point, StepType } from './io';
import type { ProbeSettings } from './settings';
import { probeProblems } from './settings';

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

/** What every move and write says first: millimetres, and feeds in mm/min. */
const MM = 'G21G94';

let _running = false;
let _cancelled = false;
let _finishing = false;                    // the moves are done and the result is being written
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
  return machine.wcs.value || 'G54';
}

/** Why a probing routine wouldn't start now, or null if it would. */
export function probingRefusal(): string | null {
  if (!connection.connected.peek()) return 'Not connected';
  if (_running) return 'Probing already in progress';
  if (warmupProgress.value) return 'The machine warmup is running, so nothing was sent. Stop it, or let it end.';
  // Sent now, a probe would wait unread in the controller and run after the Resume, in the job.
  if (machine.stateName.value === 'tool' && !command.toolChangeAcknowledged())
    return 'The controller is at a tool change and reads no commands until Resume, so nothing was sent.';
  return null;
}

/** Runs a probing sequence: one at a time, and Cancel ends it. `finish` writes what it found while the
 *  routine still owns the machine, before the modes are put back; it isn't run after a Cancel. */
export async function runProbing<T>(sequence: () => Promise<T>, finish?: (found: T) => Promise<void>): Promise<T | null> {
  const refusal = probingRefusal();
  if (refusal) { log('err', refusal); return null; }
  _running = true;
  _cancelled = false;
  const modes = await readModes();
  if (modes === null || _cancelled) { _running = false; return null; }
  try {
    const found = await sequence();
    // A Cancel taken after the last move: nothing is written.
    if (_cancelled) throw new Stop('cancelled');
    if (finish) {
      _finishing = true;
      await finish(found);
    }
    return found;
  } finally {
    _cancel = null;
    // After a Cancel, the reset comes first (it puts back grblHAL's own defaults).
    while (isStopping()) await new Promise(r => setTimeout(r, 50));
    await restoreModes(modes);
    _finishing = false;
    _running = false;
  }
}

/** The units, distance mode and feed mode now, from the [GC:] line that $G brings: as "G21G90G94".
 *  Null when $G got no answer or was refused: the [GC:] held may be from before a reset. */
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
  return (words.includes('G20') ? 'G20' : 'G21') + (words.includes('G91') ? 'G91' : 'G90')
    + (words.includes('G93') ? 'G93' : words.includes('G95') ? 'G95' : 'G94');
}

async function restoreModes(modes: string): Promise<void> {
  try {
    const reply = await command.send(modes, { quiet: true });
    if (reply.result === 'ok') log('info', `Probing ended: ${modes} as before`);
    else log('err', `Probing ended, but ${modes} was refused (error:${reply.code}): check the units, distance mode and feed mode before the next move`);
  } catch (e) {
    if (!(e instanceof command.CommandFailed)) throw e;
    log('err', `Probing ended without putting back ${modes} (${e.why}): check the units, distance mode and feed mode before the next move`);
  }
}

/** The promise's value, or null if it fails or Cancel is pressed first. */
function orCancel<T>(p: Promise<T>): Promise<T | null> {
  return new Promise(resolve => {
    if (_cancelled) { resolve(null); return; }
    _cancel = () => resolve(null);
    _failed = '';
    p.then(v => { _cancel = null; resolve(v); }, e => { _cancel = null; if (e instanceof command.CommandFailed) _failed = e.why; resolve(null); });
  });
}

function parseProbe(lines: string[]): ProbeResult | null {
  for (const raw of lines) {
    const m = raw.match(/^\[PRB:([^,]+),([^,]+),([^:]+):(\d)\]$/);
    if (m) return { x: reportMm(parseFloat(m[1])), y: reportMm(parseFloat(m[2])), z: reportMm(parseFloat(m[3])), success: m[4] === '1' };
  }
  return null;
}

/** Why the last command of the routine failed, for the status: a refusal, or no answer and why (an alarm, a reset). */
let _why = '';
let _failed = '';
const noAnswer = (cmd: string) => `${cmd} got no answer${_failed ? ` (${_failed})` : ''}`;

/** A probing move, and where it touched. Null if it was refused, not answered, or cancelled. */
async function probeMove(cmd: string): Promise<ProbeResult | null> {
  if (_cancelled) return null;
  const reply = await orCancel(command.send(MM + cmd, { log: true, owner: OWNER }));
  if (!reply) { _why = noAnswer(MM + cmd); return null; }
  if (reply.result !== 'ok') { _why = `${MM}${cmd} was refused (error:${reply.code})`; return null; }
  const result = parseProbe(reply.lines);
  if (result) return result;
  const params = await orCancel(command.send('$#', { owner: OWNER }));
  if (!params) _why = noAnswer('$#');
  return params ? parseProbe(params.lines) : null;
}

/** A move, waiting until the machine has stopped at its end. */
async function sendAndWait(cmd: string): Promise<boolean> {
  if (_cancelled) return false;
  const replies = await orCancel(Promise.all([command.send(MM + cmd, { log: true, owner: OWNER }), command.send('G4P0', { owner: OWNER })]));
  if (!replies) { _why = noAnswer(MM + cmd); return false; }
  const bad = replies.find(r => r.result !== 'ok');
  if (bad) { _why = `${bad.command} was refused (error:${bad.code})`; return false; }
  return true;
}

/** Cancel: the routine's commands not sent yet are taken back, and a move in progress is stopped. False
 *  when there is nothing to cancel: no routine, or its moves are done and its result is being written. */
export function cancelProbing(): boolean {
  if (!_running || _finishing) return false;
  _cancelled = true;
  if (_cancel) { _cancel(); _cancel = null; }
  // A $G or $# in flight moves nothing; a move or a dwell behind one may still be under way.
  if (command.cancelOwned(OWNER).some(c => !c.startsWith('$'))) {
    log('info', 'Probing cancelled: stopping the move in progress');
    stopMachine();
  } else log('info', 'Probing cancelled: no move of it was in flight, and what was still to send was taken back');
  return true;
}

function stopped(): Stop {
  return new Stop(_cancelled ? 'cancelled' : _why || 'a command failed');
}

// ── Writing what was found (in a routine's finish) ────────────────────────────

const AXES = ['x', 'y', 'z'] as const;
const zero3 = (): Point => ({ x: 0, y: 0, z: 0 });

/** One line of the result, answered: the routine's own, so it goes before the modes are put back. */
export async function writeLine(line: string): Promise<void> {
  let reply: command.Reply;
  try { reply = await command.send(line, { log: true, owner: OWNER }); }
  catch (e) {
    if (!(e instanceof command.CommandFailed)) throw e;
    throw new Stop(`${line} got no answer (${e.why})`);
  }
  if (reply.result !== 'ok') throw new Stop(`${line} was refused (error:${reply.code})`);
}

/** The offsets in force now, from $#: a work offset's table entry, G92 and the tool length offset
 *  vector ([TLO:z] or [TLO:x,y,z,...]), in mm. */
async function readFrame(wcs: string): Promise<{ table: Point | null; g92: Point; tlo: Point }> {
  let reply: command.Reply;
  try { reply = await command.send('$#', { owner: OWNER }); }
  catch (e) {
    if (!(e instanceof command.CommandFailed)) throw e;
    throw new Stop(`$# got no answer (${e.why}), so the offsets in force aren't known: nothing was written`);
  }
  if (reply.result !== 'ok') throw new Stop(`$# was refused (error:${reply.code}), so the offsets in force aren't known: nothing was written`);
  const vec = (name: string): Point | null => {
    const line = reply.lines.find(l => l.startsWith(`[${name}:`));
    if (!line) return null;
    const v = line.slice(name.length + 2).split(/[,:\]]/).map(parseFloat).filter(n => Number.isFinite(n)).map(reportMm);
    return name === 'TLO' && v.length === 1 ? { x: 0, y: 0, z: v[0] } : { x: v[0] ?? 0, y: v[1] ?? 0, z: v[2] ?? 0 };
  };
  // The command layer takes [TLO:] as a push line, so it isn't among the reply's lines: offsets.ts has
  // stored it by the time the ok comes.
  const tlo = vec('TLO') ?? machine.tloVector.value ?? (machine.tlo.value !== null ? { x: 0, y: 0, z: machine.tlo.value } : zero3());
  return { table: vec(wcs), g92: vec('G92') ?? zero3(), tlo };
}

export interface ZeroWrite {
  /** The G10 L2 values written, per axis given, and the work offset's values before. */
  wrote: Partial<Point>;
  was: Point | null;
  /** G92 and the tool length offset in force, which the controller adds to the work offset. */
  g92: Point;
  tlo: Point;
}

/** Sets a work offset so that work zero lands at `zero` (machine coordinates, the axes given) with the
 *  offsets in force: the controller's work position is the machine position less the work offset,
 *  G92 and the tool length offset vector, so G10 L2 is given the zero less G92 and the TLO, per axis. */
export async function writeZero(wcs: string, zero: Partial<Point>): Promise<ZeroWrite> {
  const frame = await readFrame(wcs);
  const wrote: Partial<Point> = {};
  for (const a of AXES) if (zero[a] !== undefined) wrote[a] = zero[a]! - frame.g92[a] - frame.tlo[a];
  const words = AXES.filter(a => wrote[a] !== undefined).map(a => a.toUpperCase() + wrote[a]!.toFixed(4)).join('');
  await writeLine(`G21G10L2P${WCS_P[wcs] ?? 1}${words}`);
  log('info', `Probed ${AXES.filter(a => zero[a] !== undefined).map(a => `${a.toUpperCase()}${zero[a]!.toFixed(4)}`).join(' ')} → ${wcs} ${words}`);
  return { wrote, was: frame.table, g92: frame.g92, tlo: frame.tlo };
}

/** The machine as a routine's Io: each step is reported to `onStep` as it starts, in the same order as
 *  the drawing's dry run lists them. */
export function machineIo(P: ProbeSettings, onStep: (type: StepType, label: string) => void = () => {}): Io {
  const backOff = (axis: string, dir: number) => sendAndWait(`G91G0${axis}${dir < 0 ? '' : '-'}${P.back.toFixed(4)}`);
  // Feeds or a back-off that can't be used are never sent, nor any move before them: a back-off of 0 or
  // below rapids into the wall it touched.
  const bad = probeProblems(P, true);
  const usable = () => { if (bad.length) throw new Stop(`the probe settings can't be used: ${bad.join('; ')}`); };
  return {
    async move(x, y, z, label, type = 'rapid') {
      usable();
      onStep(type, label);
      if (!await rapidToMPos(x, y, z)) throw stopped();
    },
    async touch(axis, dir, distance, face) {
      usable();
      const sign = dir < 0 ? '-' : '';
      onStep('probe', `Find the ${face} (fast)`);
      const fast = await probeMove(`G38.3G91F${P.fast}${axis}${sign}${distance.toFixed(4)}`);
      if (!fast) throw stopped();
      if (!fast.success) throw new Miss(face, distance, false);
      onStep('contact', `Touched the ${face}`);
      onStep('back', `Back off ${P.back} mm`);
      if (!await backOff(axis, dir)) throw stopped();
      onStep('slow', `Touch the ${face} again (slow)`);
      const slow = await probeMove(`G38.3G91F${P.slow}${axis}${sign}${(P.back * 2).toFixed(4)}`);
      if (!slow) throw stopped();
      if (!slow.success) throw new Miss(face, P.back * 2, true);
      onStep('contact', `Touched the ${face}`);
      onStep('back', `Back off ${P.back} mm`);
      if (!await backOff(axis, dir)) throw stopped();
      return { x: slow.x, y: slow.y, z: slow.z };
    },
  };
}

/** Where the machine is now, in machine coordinates: where a routine starts. */
export function machineAt(): Point {
  const m = machine.mpos.peek();
  return { x: m.x, y: m.y, z: m.z };
}

// ── Tool length ───────────────────────────────────────────────────────────────

/** On a touch plate: straight down, up to the search distance, then back up to the start. The Z touched. */
export async function touchPlate(io: Io, sp: Point, c: { probeDistance: number }): Promise<Point> {
  const r = await afterMiss(() => io.touch('Z', -1, c.probeDistance, 'plate'), () => io.move(null, null, sp.z, 'Back up to the start height'));
  await io.move(null, null, sp.z, 'Back up to the start height', 'result');
  return r;
}

/** On the toolsetter at G59.3: up to the top of the homed Z travel, over it, down to the approach height,
 *  probe, and back the same way to the start. The Z touched. */
export async function toolsetter(io: Io, sp: Point, ts: Point, c: { toolsetterDepth: number }): Promise<Point> {
  const depth = c.toolsetterDepth;
  const top = machine.zTravel.peek()?.max ?? 0; await io.move(null, null, top, `Up to the top of Z travel, machine Z ${top}`);   // F5: the homed travel's top (stores/machine.ts zTravel), not machine Z0
  await io.move(ts.x, ts.y, null, 'Over the toolsetter (G59.3)');
  await io.move(null, null, ts.z + depth, `Down to ${depth} mm above it`);
  const r = await afterMiss(() => io.touch('Z', -1, depth + 5, 'toolsetter'), async () => {
    await io.move(null, null, top, `Up to the top of Z travel, machine Z ${top}`);
    await io.move(sp.x, sp.y, null, 'Back over the start');
  });
  await io.move(null, null, top, `Up to the top of Z travel, machine Z ${top}`);
  await io.move(sp.x, sp.y, null, 'Back over the start');
  await io.move(null, null, sp.z, 'Down to the start height', 'result');
  return r;
}

export async function rapidToMPos(x: number | null, y: number | null, z: number | null): Promise<boolean> {
  if (_cancelled) return false;
  let cmd = 'G53G0';
  if (x !== null) cmd += `X${x.toFixed(4)}`;
  if (y !== null) cmd += `Y${y.toFixed(4)}`;
  if (z !== null) cmd += `Z${z.toFixed(4)}`;
  return sendAndWait(cmd);
}

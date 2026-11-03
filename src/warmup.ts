// ═══════════════════════════════════════════════
// MACHINE WARMUP — the spindle run up in steps at a start point, with or without a motion pattern
// ═══════════════════════════════════════════════
//
// The warmup is a stream of its own through the command layer, like a job but not one: it has no
// Jobs list row and no runtime, doesn't take the queue's next job, and sends no flight recorder stamp
// or line numbers (the recorder keeps a record only of a job stamped with $FLIGHT=). The controller
// times the steps (G4) and ends with M5.
//
// The whole warmup fits in the controller's input (the RX buffer from $I), so all of it, M5 included,
// is sent as soon as it starts (the owner's choice, 3 Nov). The input is what counts, not the planner as
// well: a new spindle speed and a dwell each wait for the moves before them to finish, so what follows
// waits in the input. Where the motion pattern's passes don't fit, each step runs fewer passes and
// dwells the rest of its time, and the Setup tab says so. That alone doesn't stop the spindle after a
// lost link: on the sim, the controller drops the input it hasn't run yet when the WebSocket client goes,
// so the M5 waiting there never runs (review 3 fixes, run W2).
//
// The way to the start point: Z up first, to the higher of the point's Z and where the tool is, then
// over to the point's X and Y, then to its Z. Every move is G53, in mm and mm/min (G21 G94 first, so an
// inverse-time G93 left by a program doesn't scale the feed). Then each step sets the speed and dwells,
// or runs the motion pattern, for its time. M5 ends it; G93 and G20 are put back if they were set.
//
// Hold and Stop are the bottom bar's, as for a job: Stop is the hold, then the reset once the machine
// has stopped (streaming.ts), and the reset stops the spindle.

import { signal, effect } from '@preact/signals';
import { lsGet, lsSet, byteLen } from './ui';
import { log } from './console';
import { errorText } from './errors';
import { stopJob } from './streaming';
import * as command from './command';
import * as connection from './stores/connection';
import * as machine from './stores/machine';
import * as job from './stores/job';
import * as messages from './stores/messages';

/** A spindle routine: the speed from `start` to `max` in `steps` steps of `minutes` each. */
export interface Routine { start: number; max: number; steps: number; minutes: number; }
export type Pattern = 'none' | 'x' | 'y' | 'xy' | 'box';
/** The motion during the steps: ranges from the start point toward −X and −Y, at `feed` mm/min. */
export interface Motion { pattern: Pattern; xRange: number; yRange: number; feed: number; }
/** Machine coordinates, mm. */
export interface Point { x: number; y: number; z: number; }

export const PATTERNS: [Pattern, string][] = [
  ['none', 'Spindle only'], ['x', 'Back and forth in X'], ['y', 'Back and forth in Y'],
  ['xy', 'Back and forth in X, then Y'], ['box', 'Round the rectangle'],
];

function kept<T extends object>(key: string, fallback: T) {
  const s = signal<T>({ ...fallback, ...lsGet<Partial<T>>(key, {}) });
  effect(() => lsSet(key, s.value));
  return s;
}

export const normal = kept<Routine>('fs-warmup-normal', { start: 6000, max: 18000, steps: 3, minutes: 2 });
export const cold = kept<Routine>('fs-warmup-cold', { start: 6000, max: 24000, steps: 4, minutes: 2 });
export const motion = kept<Motion>('fs-warmup-motion', { pattern: 'none', xRange: 300, yRange: 300, feed: 1500 });
/** The owner's start point: "well off the sensors but safe". */
export const point = kept<Point>('fs-warmup-point', { x: -5, y: -5, z: -5 });
/** The operator's switch: the button runs the from-cold routine. */
export const fromCold = signal<boolean>(lsGet('fs-warmup-from-cold', false));
effect(() => lsSet('fs-warmup-from-cold', fromCold.value));

// ── The program ───────────────────────────────────────────────────────────────

/** The steps' speeds, evenly spaced from the starting speed to the target. One step runs at the target. */
export function speeds(r: Routine): number[] {
  const n = Math.max(1, Math.round(r.steps));
  return Array.from({ length: n }, (_, k) => Math.round(n === 1 ? r.max : r.start + (r.max - r.start) * k / (n - 1)));
}

/** One pass of the pattern from the start point and back to it, as machine X Y points. */
function pass(m: Motion, p: Point): { x: number; y: number }[] {
  const x1 = p.x - m.xRange, y1 = p.y - m.yRange;
  switch (m.pattern) {
    case 'x': return [{ x: x1, y: p.y }, { x: p.x, y: p.y }];
    case 'y': return [{ x: p.x, y: y1 }, { x: p.x, y: p.y }];
    case 'xy': return [{ x: x1, y: p.y }, { x: p.x, y: p.y }, { x: p.x, y: y1 }, { x: p.x, y: p.y }];
    case 'box': return [{ x: x1, y: p.y }, { x: x1, y: y1 }, { x: p.x, y: y1 }, { x: p.x, y: p.y }];
    default: return [];
  }
}

/** How long one pass takes, in s, at the feed (no acceleration); 0 for none. */
export function passSecs(m: Motion): number {
  if (m.pattern === 'none' || !(m.feed > 0)) return 0;
  const len = m.pattern === 'x' ? 2 * m.xRange : m.pattern === 'y' ? 2 * m.yRange : 2 * (m.xRange + m.yRange);
  return len > 0 ? len / m.feed * 60 : 0;
}

// A step runs whole passes for its time and dwells what is left; at most this many passes, so a
// small range can't make thousands of lines.
const MAX_PASSES = 100;

export interface Step { line: number; rpm: number; secs: number; }
/** `fit`: the passes per step its time wants, and those that fit in the room given (null with no motion).
 *  `fits`: all of it fits in that room. */
export interface Plan { lines: string[]; steps: Step[]; secs: number; fit: { wanted: number; sent: number } | null; fits: boolean; }

const n = (v: number) => String(Math.round(v * 1000) / 1000);
/** The bytes the lines take in the controller's input, a newline each. */
export const bytes = (lines: string[]) => lines.reduce((t, l) => t + byteLen(l + '\n'), 0);

/** The way to a machine point from where the tool is (machine Z): Z up first, to the higher of the two, so
 *  it never goes down while crossing; then over to X and Y; then to the point's Z. G53, in the units in
 *  force, so the first line wants G21 in front. PARK goes the same way (park.ts). */
export function wayTo(p: Point, fromZ: number): string[] {
  return [`G53G0Z${n(Math.max(p.z, fromZ))}`, `G53G0X${n(p.x)}Y${n(p.y)}`, `G53G0Z${n(p.z)}`];
}

/** The lines with at most `cap` passes a step, and the passes a step's time wants. */
function build(r: Routine, m: Motion, p: Point, fromZ: number, cap: number): { lines: string[]; steps: Step[]; wanted: number } {
  const lines = wayTo(p, fromZ);
  lines[0] = 'G21G94' + lines[0];
  const pts = pass(m, p);
  const each = passSecs(m);
  const steps: Step[] = [];
  let wanted = 0;
  for (const rpm of speeds(r)) {
    const secs = Math.max(0, r.minutes * 60);
    steps.push({ line: lines.length, rpm, secs });
    lines.push(`M3S${rpm}`);
    if (!each) { lines.push(`G4P${n(secs)}`); continue; }
    wanted = Math.min(MAX_PASSES, Math.max(1, Math.floor(secs / each)));
    const passes = Math.min(wanted, cap);
    let first = true;
    for (let k = 0; k < passes; k++) for (const pt of pts) { lines.push(`G53G1X${n(pt.x)}Y${n(pt.y)}${first ? 'F' + n(m.feed) : ''}`); first = false; }
    const rest = secs - passes * each;
    if (rest >= 0.5) lines.push(`G4P${n(rest)}`);
    steps[steps.length - 1].secs = Math.max(secs, passes * each);
  }
  lines.push('M5');
  return { lines, steps, wanted };
}

/** The warmup's lines, from where the tool is (machine Z), in at most `room` bytes: the passes a step
 *  are cut until they fit, and each step dwells the rest of its time. */
export function plan(r: Routine, m: Motion, p: Point, fromZ: number, room = Infinity): Plan {
  let b = build(r, m, p, fromZ, MAX_PASSES);
  let cap = b.wanted;
  while (cap > 0 && bytes(b.lines) > room) b = build(r, m, p, fromZ, --cap);
  return { lines: b.lines, steps: b.steps, secs: b.steps.reduce((t, s) => t + s.secs, 0),
    fit: passSecs(m) ? { wanted: b.wanted, sent: cap } : null, fits: bytes(b.lines) <= room };
}

/** The routine's time in s, the way to the start point not counted. */
export function estimate(r: Routine, m: Motion): number {
  return plan(r, m, point.peek(), point.peek().z).secs;
}

/** The routine as it would go now, in the room the controller's input has. */
export function fitted(r: Routine, m: Motion): Plan {
  return plan(r, m, point.peek(), point.peek().z, room());
}

/** What goes after the routine: G93 and G20 put back if $G showed them, and the barrier. */
function tail(words: string[] | null): string[] {
  return [...(words?.includes('G93') ? ['G93'] : []), ...(words?.includes('G20') ? ['G20'] : []), 'G4P0'];
}

/** The room the routine has in the controller's input, with what goes after it. */
export function room(words: string[] | null = machine.modal.peek()): number {
  return command.rxBufferSize() - 1 - bytes(tail(words));
}

// ── Running it ────────────────────────────────────────────────────────────────

interface Run {
  cold: boolean;
  pattern: Pattern;
  plan: Plan;
  lines: string[];
  source: command.JobSource;
  head: number;
  ended: boolean;
  step: number;       // the step running, -1 on the way to the start point
  stepAt: number;     // when it started
  heldMs: number;     // held since then
  startedAt: number;
}

export interface Progress { cold: boolean; pattern: Pattern; steps: Step[]; step: number; leftMs: number; elapsedMs: number; totalMs: number; held: boolean; }

/** What the progress shows while a warmup runs; null otherwise. */
export const progress = signal<Progress | null>(null);

let run: Run | null = null;
let starting = false;
let ticker: ReturnType<typeof setInterval> | null = null;
let lastTick = 0;

/** Why the button does nothing now, or null when it can start. */
export function whyNot(): string | null {
  if (!connection.connected.value) return 'not connected';
  if (progress.value || starting) return 'running';
  if (job.running.value) return 'a job is running';
  const s = machine.stateName.value;
  if (s !== 'idle') return s ? 'machine ' + (s === 'tool' ? 'at a tool change' : s) : 'no status yet';
  return null;
}

export function running(): boolean { return !!run && !run.ended; }

/** MACHINE WARMUP, held for 5 s: the routine the switch picks. */
export function start(): void {
  const why = whyNot();
  if (why) { log('err', 'Machine warmup: nothing was sent (' + why + ')'); return; }
  starting = true;
  const isCold = fromCold.peek();
  // The modes first, to put G93 and G20 back after. The sim refused the first $ command after homing
  // (error:71) and took the next, so a refusal gets one more try, as Start does. Stop, RESET, a reset
  // or the link going while $G is answered revokes the warmup (command.intent).
  const live = command.intent();
  const modes = () => command.send('$G', { quiet: true }).catch(e => { if (e instanceof command.CommandFailed) return null; throw e; });
  modes().then(r => r?.result === 'error' && live() ? modes() : r).then(reply => {
    starting = false;
    if (!live()) { log('info', 'Machine warmup: nothing was sent. Stop, RESET, a reset or the link going came while $G was answered.'); return; }
    const why = whyNot();
    if (why) { log('err', 'Machine warmup: nothing was sent (' + why + ')'); return; }
    const words = reply?.result === 'ok' ? [...machine.modal.peek()] : null;
    if (!words) log('err', 'Machine warmup: $G got no answer, so the modes it found aren\'t known; it leaves G21 G94 in force.');
    const p = plan(isCold ? cold.peek() : normal.peek(), motion.peek(), point.peek(), machine.mpos.peek().z, room(words));
    if (p.fit && p.fit.sent < p.fit.wanted) log('info', `Machine warmup: ${p.fit.sent} of the ${p.fit.wanted} passes a step, to fit in the controller's ${command.rxBufferSize()}-byte input; each step dwells the rest of its time.`);
    if (!p.fits) log('err', `Machine warmup: it doesn't fit in the controller's ${command.rxBufferSize()}-byte input even without motion, so its M5 goes only when there is room: if the link drops before then, the spindle keeps running.`);
    // Its ok comes once the planner is empty: the machine has stopped.
    begin(isCold, p, [...p.lines, ...tail(words)]);
  });
}

function begin(isCold: boolean, p: Plan, lines: string[]): void {
  const r: Run = { cold: isCold, pattern: motion.peek().pattern, plan: p, lines, head: 0, ended: false, step: -1, stepAt: Date.now(), heldMs: 0, startedAt: Date.now(), source: null! };
  r.source = {
    next(room) {
      if (r.ended || r.head >= r.lines.length) return null;
      const text = r.lines[r.head];
      if (byteLen(text + '\n') > room) return null;
      r.head++;
      return { text, line: r.head };
    },
    replied(line, reply) {
      if (r.ended) return;
      if (reply.result === 'error') {
        const why = errorText(reply.code);
        end(r, `Machine warmup stopped: the controller refused ${line.text} (error:${reply.code}${why ? ', ' + why : ''}). Stop was sent: the hold, then the reset, which stops the spindle.`, true);
        stopJob();
        return;
      }
      const k = r.plan.steps.findIndex(s => s.line === line.line - 1);
      // grblHAL answers M3 once the moves before it have run, so its ok is the step starting.
      if (k >= 0) { r.step = k; r.stepAt = Date.now(); r.heldMs = 0; }
      if (line.line === r.lines.length) end(r, 'Machine warmup done (' + (r.cold ? 'from cold' : 'normal') + ', ' + job.fmtDuration(Date.now() - r.startedAt) + ')', false);
    },
    dropped(why) {
      if (r.ended) return;
      if (why === 'reset' || why === 'alarm') {
        end(r, `Machine warmup ended: the controller was ${why === 'reset' ? 'reset' : 'stopped by an alarm'}, which stops the spindle.`, true);
      } else if (why === 'disconnected') {
        const left = r.lines.length - r.head;
        end(r, left
          ? `Machine warmup: the link was lost with ${left} of its lines not sent, so the spindle may still be running. Check the machine.`
          : 'Machine warmup: the link was lost. All of its lines had been sent, but a controller can drop what it hasn\'t run yet when the link goes (the sim does), so the spindle may still be running. Check the machine.', true);
      } else {
        // A jog cancel empties the controller's input, so the rest of the warmup is gone: stop the spindle.
        end(r, `Machine warmup ended: the controller's input was emptied (${why}), so the rest of it was lost. M5 was sent to stop the spindle.`, true);
        command.post('M5');
      }
    },
  };
  run = r;
  log('info', `Machine warmup (${isCold ? 'from cold' : 'normal'}): ${p.steps.map(s => s.rpm).join(', ')} rpm, about ${job.fmtDuration(p.secs * 1000)}; ${lines.length} lines`);
  lastTick = Date.now();
  ticker = setInterval(tick, 500);
  tick();
  command.stream(r.source);
}

function end(r: Run, text: string, warn: boolean): void {
  r.ended = true;
  command.endStream(r.source);
  if (run === r) run = null;
  if (ticker) { clearInterval(ticker); ticker = null; }
  progress.value = null;
  log(warn ? 'err' : 'info', text);
  messages.push(warn ? 'error' : 'job', text);
}

/** STOP while the warmup runs: nothing more is sent, then the hold and the reset, as for a job. */
export function stop(): void {
  if (run) end(run, 'Machine warmup stopped: the hold, then the reset, which stops the spindle.', false);
  stopJob();
}

function tick(): void {
  const r = run;
  if (!r) return;
  const now = Date.now();
  const held = ['hold', 'door'].includes(machine.stateName.peek());
  if (held) r.heldMs += now - lastTick;
  lastTick = now;
  const steps = r.plan.steps;
  const totalMs = r.plan.secs * 1000;
  const after = (k: number) => steps.slice(k + 1).reduce((t, s) => t + s.secs * 1000, 0);
  const leftMs = r.step < 0 ? totalMs : Math.max(0, steps[r.step].secs * 1000 - (now - r.stepAt - r.heldMs)) + after(r.step);
  progress.value = { cold: r.cold, pattern: r.pattern, steps, step: r.step, leftMs, elapsedMs: now - r.startedAt, totalMs, held };
}

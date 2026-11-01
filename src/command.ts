// ═══════════════════════════════════════════════
// Command layer — every line sent to the controller, and its reply
// ═══════════════════════════════════════════════
//
// grblHAL reads lines in the order they arrive and answers each with exactly one `ok` or
// `error:N`. So a reply belongs to a command by position: the oldest command still waiting owns
// the next ok or error, and every line before it that isn't a push message.
//
// Push messages are the lines grblHAL sends with no command behind them. They go to subscribers,
// never to a command, even when a command also asks for one ($G gives [GC:], $# gives [TLO:]):
//   <…>         status reports
//   ALARM:n
//   [MSG:…]
//   Grbl…       the start-up banner, after a reset and when a network client connects
//   [GC:…]      also sent after a status report when the modal state has changed
//   [TLO:…]     also sent after a status report when the tool length offset has changed
//   >…          the echo of a start-up line ($N0, $N1) after a reset
// [PRB:] is only ever sent inside a reply (the G38 cycle, and $#), so it belongs to the command.
//
// The line is "in step" when every ok or error still to come belongs to a command in the queue.
// It isn't after connecting, after a reset or a banner, or after anything that makes grblHAL empty
// its input with lines still unanswered: a jog cancel, an alarm (the critical ones empty it, and
// the flight recorder empties it while it retracts). Then the layer holds every new command and
// syncs (see probe() below) before it trusts the queue again.
//
// Real-time bytes (?, !, ~, 0x18, 0x85, 0x87, the overrides) go straight out and have no reply.
// The job is a source the layer pulls lines from while they fit in the controller's RX buffer,
// after any one-off commands, through the same queue, so their replies can never cross.

import { log } from './console';
import { byteLen } from './ui';

export interface Reply {
  command: string;
  /** Every line before the ok or error, push messages left out. */
  lines: string[];
  result: 'ok' | 'error';
  /** N of error:N, 0 for ok. */
  code: number;
}

export type Failure = 'timeout' | 'reset' | 'disconnected' | 'not connected' | 'alarm' | 'jog cancel' | 'banner';

/** Why a command's promise was rejected. A timed-out command still owns its reply when it comes. */
export class CommandFailed extends Error {
  constructor(readonly command: string, readonly why: Failure) { super(command + ': ' + why); }
}

export interface SendOptions {
  /** How long to wait for the ok or error, in ms. */
  timeout?: number;
  /** Show the command and its reply lines in the console. */
  log?: boolean;
  /** An error is the caller's to show: not logged here, and not put in the messages. */
  quiet?: boolean;
}

export interface JobLine { text: string; line: number; }

/** The streaming job, as the layer sees it. */
export interface JobSource {
  /** The next line if it costs no more than `room` bytes, or null to send nothing now. */
  next(room: number): JobLine | null;
  replied(line: JobLine, reply: Reply): void;
  /** The layer gave up on the job's lines in flight (a reset, a disconnect, a resync). */
  dropped(why: Failure): void;
}

export type PushKind = 'status' | 'alarm' | 'msg' | 'banner' | 'gc' | 'tlo' | 'startup' | 'other';

/** `retries` counts the probes that went because the one before had no answer in time. */
export interface SyncState { syncing: boolean; attempts: number; retries: number; gaveUp: boolean; }

// Long enough for $H, a G38 probe at a slow feed and $$ behind a full planner. The ok of a move
// comes when it is planned, which can wait while the planner is full.
const DEFAULT_TIMEOUT = 300_000;
const SYNC_RETRY = 2_500;     // ms an attempt waits for its answer before the next one goes
const SYNC_LIMIT = 90_000;    // ms of attempts before waiting for a banner instead
const RESET_WAIT = 3_000;     // ms to wait for the banner after a reset before syncing anyway
const TOOL_ACK = '\xA3';

interface Entry {
  command: string;
  bytes: number;
  lines: string[];
  log: boolean;
  quiet?: boolean;
  job?: JobLine;
  source?: JobSource;
  resolve?: (reply: Reply) => void;
  reject?: (failure: CommandFailed) => void;
  timer?: ReturnType<typeof setTimeout>;
  late?: boolean;   // its promise timed out; it keeps its place and its reply
}

interface Sync {
  attempts: number;         // probes sent since the line was last in step
  retries: number;          // of those, the ones sent because the last had no answer in time
  since: number;
  awaitingBanner: boolean;  // after a reset, until the banner
  confirming: boolean;
  sawHelp: boolean;
  sawVer: boolean;
  gaveUp: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

let write: ((data: string) => boolean) | null = null;
let phase: 'offline' | 'syncing' | 'ready' = 'offline';
let sync: Sync | null = null;
const queued: Entry[] = [];    // not sent yet: the line isn't in step, or there's no room
const waiting: Entry[] = [];   // sent, oldest first; each owns the next ok or error in turn
let bytesInFlight = 0;
let rxSize = 128;
let source: JobSource | null = null;

const pushSubs = new Map<PushKind, ((line: string) => void)[]>();
const replySubs: ((reply: Reply, info: { job: boolean; quiet: boolean }) => void)[] = [];
const syncSubs: ((s: SyncState) => void)[] = [];

// ── Trace, for the debug copy and the evidence runs ──────────────────────────
export interface TraceEntry { t: number; dir: 'tx' | 'rx' | 'rt' | 'sync'; text: string; }
const _trace: TraceEntry[] = [];
function trace(dir: TraceEntry['dir'], text: string): void {
  _trace.push({ t: Date.now(), dir, text });
  if (_trace.length > 3000) _trace.splice(0, _trace.length - 3000);
}
export function traceLog(): TraceEntry[] { return _trace.slice(); }

// ── The link ─────────────────────────────────────────────────────────────────

/** A link is open. With `reset`, a soft reset goes first; without it the line is synced as it is. */
export function connected(writer: (data: string) => boolean, opts: { reset: boolean }): void {
  write = writer;
  phase = 'syncing';
  if (opts.reset) realtime('\x18');
  else resync('reset', { awaitBanner: false, dropQueued: true });
}

export function disconnected(): void {
  write = null;
  phase = 'offline';
  endSync();
  failAll(waiting, 'disconnected');
  failAll(queued, 'disconnected');
  dropSource('disconnected');
  bytesInFlight = 0;
  trace('sync', 'link closed');
}

export function isConnected(): boolean { return phase !== 'offline'; }
export function inStep(): boolean { return phase === 'ready'; }

/** The RX buffer size from the [OPT:] line of $I. */
export function setRxBufferSize(bytes: number): void { if (bytes > 0) rxSize = bytes; }
export function rxBufferSize(): number { return rxSize; }

export function stats(): { phase: string; waiting: string[]; queued: number; bytes: number; rxSize: number } {
  return { phase, waiting: waiting.map(e => e.command), queued: queued.length, bytes: bytesInFlight, rxSize };
}

// ── Sending ──────────────────────────────────────────────────────────────────

/** Sends one line and resolves with its reply. error:N resolves too; only a timeout, reset or lost link rejects. */
export function send(line: string, opts: SendOptions = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const command = line.trim();
    if (phase === 'offline') { reject(new CommandFailed(command, 'not connected')); return; }
    enqueue({ command, bytes: byteLen(command + '\n'), lines: [], log: !!opts.log, quiet: opts.quiet, resolve, reject }, opts.timeout ?? DEFAULT_TIMEOUT);
  });
}

/** Sends lines nobody waits for (split on newlines), through the same queue. */
export function post(text: string, opts: { log?: boolean } = {}): void {
  const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
  if (phase === 'offline') { if (lines.length) log('err', 'Not connected'); return; }
  for (const command of lines) enqueue({ command, bytes: byteLen(command + '\n'), lines: [], log: opts.log ?? true }, 0);
}

/** A real-time byte. It has no reply; a reset and a jog cancel take the line out of step. */
export function realtime(byte: string): void {
  // The tool change acknowledge lets grblHAL read new lines ahead of the job's buffered ones, so
  // their replies would come out of order. Nothing here sends it.
  if (byte === TOOL_ACK) throw new Error('The tool change acknowledge (0xA3) would reorder replies');
  if (!write || phase === 'offline') return;
  write(byte);
  if (byte !== '?') trace('rt', '0x' + byte.charCodeAt(0).toString(16));
  if (byte === '\x18') resync('reset', { awaitBanner: true, dropQueued: true });
  // grblHAL empties its input on a jog cancel, whatever the lines in it are.
  else if (byte === '\x85' && waiting.length) resync('jog cancel', { awaitBanner: false, dropQueued: false });
}

/** Starts pulling job lines from `src`. */
export function stream(src: JobSource): void {
  source = src;
  pump();
}

/** Stops pulling job lines. The ones in flight still get their replies. */
export function endStream(src: JobSource): void {
  if (source === src) source = null;
}

/** Sends whatever fits: queued commands first, then job lines. */
export function pump(): void {
  if (phase !== 'ready' || !write) return;
  const limit = rxSize - 1;
  while (queued.length) {
    const e = queued[0];
    if (bytesInFlight + e.bytes > limit && waiting.length) return;
    queued.shift();
    transmit(e);
  }
  while (source && phase === 'ready') {
    const line = source.next(limit - bytesInFlight);
    if (!line) break;
    transmit({ command: line.text, bytes: byteLen(line.text + '\n'), lines: [], log: true, job: line, source });
  }
}

function enqueue(e: Entry, timeout: number): void {
  if (e.resolve && timeout > 0) e.timer = setTimeout(() => timedOut(e, timeout), timeout);
  queued.push(e);
  pump();
}

function transmit(e: Entry): void {
  if (!write || !write(e.command + '\n')) { fail(e, 'disconnected'); return; }
  waiting.push(e);
  bytesInFlight += e.bytes;
  trace('tx', e.command);
  if (e.log) log('tx', e.command);
}

function timedOut(e: Entry, ms: number): void {
  e.timer = undefined;
  const i = queued.indexOf(e);
  if (i >= 0) queued.splice(i, 1);   // never sent, so it owns nothing
  else e.late = true;                // sent: its reply is still its own when it comes
  log('err', `No reply to "${e.command}" after ${ms / 1000} s`);
  trace('sync', 'timeout ' + e.command);
  e.reject?.(new CommandFailed(e.command, 'timeout'));
}

function fail(e: Entry, why: Failure): void {
  if (e.timer) clearTimeout(e.timer);
  if (!e.late) e.reject?.(new CommandFailed(e.command, why));
}

function failAll(list: Entry[], why: Failure): void {
  const entries = list.splice(0);
  for (const e of entries) fail(e, why);
}

function dropSource(why: Failure): void {
  const s = source;
  source = null;
  s?.dropped(why);
}

// ── Receiving ────────────────────────────────────────────────────────────────

/** One line from the controller, without its line ending. */
export function receive(line: string): void {
  if (!line.startsWith('<')) trace('rx', line);
  const kind = pushKind(line);
  if (kind) { pushed(kind, line); return; }
  if (phase === 'syncing') { syncLine(line); return; }
  if (phase === 'offline') return;

  const done = line === 'ok' || line.startsWith('error:');
  const head = waiting[0];
  if (!head) {
    if (done) log('err', `Stray "${line}" with no command waiting, ignored`);
    else { log('rx', line); deliver('other', line); }
    return;
  }
  if (!done) { head.lines.push(line); return; }

  waiting.shift();
  bytesInFlight = Math.max(0, bytesInFlight - head.bytes);
  if (head.timer) clearTimeout(head.timer);
  const reply: Reply = {
    command: head.command, lines: head.lines,
    result: line === 'ok' ? 'ok' : 'error', code: line === 'ok' ? 0 : parseInt(line.slice(6)) || 0,
  };
  if (head.log) for (const l of head.lines) log(l.startsWith('[') ? 'info' : 'rx', l);
  if (reply.result === 'error' && !head.quiet) log('err', line + '  ← "' + head.command + '"');
  if (head.late) log('info', `The late reply to "${head.command}" came: ${line}`);
  for (const fn of replySubs) fn(reply, { job: !!head.job, quiet: !!head.quiet });
  if (head.job) head.source?.replied(head.job, reply);
  else if (!head.late) head.resolve?.(reply);
  pump();
}

function pushKind(line: string): PushKind | null {
  if (line.startsWith('<')) return 'status';
  if (line.startsWith('ALARM:')) return 'alarm';
  if (line.startsWith('[MSG:')) return 'msg';
  if (/^Grbl(HAL)? \d/.test(line)) return 'banner';
  if (line.startsWith('[GC:')) return 'gc';
  if (line.startsWith('[TLO:')) return 'tlo';
  if (line.startsWith('>')) return 'startup';
  return null;
}

function pushed(kind: PushKind, line: string): void {
  // Out of step first, so whatever a subscriber sends waits for the sync.
  // A banner while syncing can be a network client's greeting, which empties nothing, and the
  // commands held then were never sent, so they stay.
  if (kind === 'banner' && phase !== 'offline') {
    if (sync?.awaitingBanner) { trace('sync', 'banner after reset'); probe(); }
    else resync('banner', { awaitBanner: false, dropQueued: phase === 'ready' });
  }
  if (kind === 'alarm' && phase === 'ready' && waiting.length) resync('alarm', { awaitBanner: false, dropQueued: false });
  deliver(kind, line);
}

function deliver(kind: PushKind, line: string): void {
  for (const fn of pushSubs.get(kind) ?? []) fn(line);
}

// ── Subscriptions ────────────────────────────────────────────────────────────

export function on(kind: PushKind, fn: (line: string) => void): () => void {
  const list = pushSubs.get(kind) ?? [];
  list.push(fn);
  pushSubs.set(kind, list);
  return () => pushSubs.set(kind, (pushSubs.get(kind) ?? []).filter(f => f !== fn));
}

/** Every reply as it is matched: commands, posted lines and job lines alike. */
export function onReply(fn: (reply: Reply, info: { job: boolean; quiet: boolean }) => void): void { replySubs.push(fn); }

export function onSync(fn: (s: SyncState) => void): void { syncSubs.push(fn); }

// ── Getting in step ──────────────────────────────────────────────────────────
//
// Every command still waiting is rejected (the queued ones too after a reset), and new ones are
// held. Then probes go out until one is answered: "\n$\n". The newline ends any half-received line
// left in the controller's input (its reply, or the ok of the empty line, is dropped). `$` is
// answered with the [HLP:] line in every state, even mid-job or in an alarm, and nothing pushes
// [HLP:]. So the first [HLP:] followed by ok marks the point where the line is in step, and
// everything before it (stray oks, late replies, the end of an old reply) is dropped.
//
// While the flight recorder retracts after a lost link, grblHAL throws its input away, so a probe
// can vanish or arrive cut in half. After SYNC_RETRY another goes. If more than one went, an
// earlier one may still be answered after the [HLP:] that was seen, so one more line, $I+, goes
// out, and everything up to the ok after its [VER:] is dropped too. Nothing else is in flight then.

function resync(why: Failure, opts: { awaitBanner: boolean; dropQueued: boolean }): void {
  const attempts = sync?.attempts ?? 0;
  endSync();
  phase = 'syncing';
  failAll(waiting, why);
  if (opts.dropQueued) failAll(queued, why);
  dropSource(why);
  bytesInFlight = 0;
  sync = { attempts, retries: 0, since: Date.now(), awaitingBanner: opts.awaitBanner, confirming: false, sawHelp: false, sawVer: false, gaveUp: false };
  trace('sync', 'out of step: ' + why + (opts.awaitBanner ? ', waiting for the banner' : ''));
  if (opts.awaitBanner) sync.timer = setTimeout(probe, RESET_WAIT);
  else probe();
}

function probe(): void {
  const s = sync;
  if (!s || !write) return;
  if (s.timer) clearTimeout(s.timer);
  s.awaitingBanner = false;
  s.confirming = false;
  s.sawHelp = false;
  if (Date.now() - s.since > SYNC_LIMIT) {
    // Nothing more goes out; a banner (the operator resetting it) starts again.
    s.gaveUp = true;
    trace('sync', 'no answer, waiting for a banner');
    notifySync();
    return;
  }
  s.attempts++;
  write('\n$\n');
  trace('sync', 'probe ' + s.attempts);
  s.timer = setTimeout(retry, SYNC_RETRY);
  notifySync();
}

function retry(): void {
  if (sync) sync.retries++;
  probe();
}

function syncLine(line: string): void {
  const s = sync!;
  if (s.awaitingBanner || s.gaveUp) return;
  if (!s.confirming) {
    if (line.startsWith('[HLP:')) { s.sawHelp = true; return; }
    if (line === 'ok' && s.sawHelp) {
      if (s.attempts === 1) { ready(); return; }
      s.confirming = true;
      s.sawVer = false;
      if (s.timer) clearTimeout(s.timer);
      write!('\n$I+\n');
      trace('sync', 'confirm');
      s.timer = setTimeout(retry, SYNC_RETRY * 2);
      return;
    }
    s.sawHelp = false;
    return;
  }
  if (line.startsWith('[VER:')) { s.sawVer = true; return; }
  if (line === 'ok' && s.sawVer) { ready(); return; }
  if (line === 'ok' || line.startsWith('error:')) s.sawVer = false;
}

function ready(): void {
  endSync();
  phase = 'ready';
  trace('sync', 'in step');
  notifySync();
  pump();
}

function endSync(): void {
  if (sync?.timer) clearTimeout(sync.timer);
  sync = null;
}

function notifySync(): void {
  const s: SyncState = { syncing: phase === 'syncing', attempts: sync?.attempts ?? 0, retries: sync?.retries ?? 0, gaveUp: sync?.gaveUp ?? false };
  for (const fn of syncSubs) fn(s);
}

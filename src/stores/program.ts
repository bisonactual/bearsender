// The loaded file as the G-code interpreter reads it.
//
// Everything that reads the program goes through src/gcode: the Preview, the Jobs list's tools and
// times, the Setup list's travel and tools, and the resume. It is read again whenever what it
// depends on changes: the file, the work offsets, G92, the tool length, G28/G30, the rapid rates,
// the tool table, the controller's modes ($G), the settings it uses ($28, homing and travel), the
// "Run lines after M30" option, and where the machine stands while idle (a moment after a jog).
// While a job runs it isn't read again, so the rows stay the run's.

import { signal, computed, effect } from '@preact/signals';
import { interpretGcode, lexLine, moveExtrema } from '../gcode/index';
import { emptyBounds, includePoint, subtract } from '../gcode/geometry';
import type { Bounds, InterpreterContext, Issue, Motion, Point, Position, Program, WorkSystem } from '../gcode/index';
import { log } from '../console';
import * as job from './job';
import * as machine from './machine';
import * as connection from './connection';
import * as options from './options';

/** A tool in the Jobs list: one use of a tool, from its M6 to the next (the interpreter's tool uses). */
export interface ToolRow {
  index: number;
  /** The programmed T, or null when the program never names the tool it starts with. */
  tool: number | null;
  /** The line with the M6, or 0 for the tool already in the spindle at the start. */
  changeLine: number;
  /** First and last line, counted from 1 as in the job store. */
  start: number;
  end: number;
  /** The operations, from the comment headings before them (the interpreter's inference). */
  name: string;
  /** Lower bound from the G-code: no acceleration, overrides or waits. */
  estSeconds: number;
  timeComplete: boolean;
}

export interface ProgramView {
  program: Program;
  rows: ToolRow[];
  /** Tool descriptions from header comments like (T1 D=6. CR=0. - ZMIN=-3. - flat end mill). */
  described: Record<number, string>;
  /** Estimated seconds of the program up to the end of each line; index 0 is 0. */
  cum: Float64Array;
  estSeconds: number;
  /** The first block the interpreter couldn't read: everything after it is unknown. */
  stopped: Issue | null;
  /** Where the program itself moves, for the limits module and Frame (programExtent). */
  extent: { machine: Bounds; perWorkOffset: Partial<Record<WorkSystem, Bounds>> };
  /** How long the reading took, in ms. */
  readMs: number;
}

const WCS: WorkSystem[] = ['G54', 'G55', 'G56', 'G57', 'G58', 'G59', 'G59.1', 'G59.2', 'G59.3'];
const vec = (v: machine.Vec3): Point => ({ x: v.x, y: v.y, z: v.z });

/** The modes in the words of a [GC:] line ($G), as the interpreter takes them; undefined with none. Every
 *  word a program inherits is used: units, distance, plane, feed mode, motion, arc distance (G91.1;
 *  grblHAL has no G90.1), the cycle retract (G98/G99), the spindle (M3/M4/M5 and S), the coolant
 *  (M7/M8/M9) and the feed (F, 0 being none). A motion mode it doesn't read (G38.x, a canned cycle) is
 *  taken as G80: axis words alone stop it. */
export function modesFromWords(words: string[] | null | undefined): InterpreterContext['initialModes'] {
  if (!words?.length) return undefined;
  const has = (w: string) => words.includes(w);
  const word = (letter: string) => { const w = words.find(x => x[0] === letter && /^[FS][\d.]+$/.test(x)); return w ? parseFloat(w.slice(1)) : null; };
  const motion = words.find(w => /^G(0|1|2|3|38\.\d|8\d)$/.test(w));
  const f = word('F'), s = word('S');
  return {
    units: has('G20') ? 'G20' : 'G21', distance: has('G91') ? 'G91' : 'G90',
    plane: has('G18') ? 'G18' : has('G19') ? 'G19' : 'G17', feedMode: has('G93') ? 'G93' : 'G94',
    ...(motion ? { motion: (['G0', 'G1', 'G2', 'G3', 'G80'].includes(motion) ? motion : 'G80') as Motion } : {}),
    arcDistance: has('G90.1') ? 'G90.1' : 'G91.1', retract: has('G99') ? 'G99' : 'G98',
    spindle: has('M3') ? 'M3' : has('M4') ? 'M4' : 'M5', spindleSpeed: s !== null && s > 0 ? s : null,
    coolant: { mist: has('M7'), flood: has('M8') },
    programmedFeed: f !== null && f > 0 ? f : null,
  };
}

/** Where $H takes the machine, as far as the controller has said: the axes its homing cycles home
 *  ($44-$49, null if none were read) and the startup lines grblHAL runs after homing ($N0, $N1; null
 *  until read). */
function homing(): NonNullable<InterpreterContext['homing']> {
  const s = machine.settings.value;
  const cycles = [44, 45, 46, 47, 48, 49].map(id => parseInt(s[id] ?? '')).filter(Number.isFinite);
  const mask = cycles.reduce((m, c) => m | c, 0);
  return {
    axes: cycles.length ? (['x', 'y', 'z'] as const).filter((_, i) => mask & (1 << i)) : null,
    startup: machine.startupLines.value,
  };
}

/** The work offset in the words of a [GC:] line, if there is one. */
export function wcsFromWords(words: string[] | null | undefined): WorkSystem | undefined {
  return words?.find((w): w is WorkSystem => WCS.includes(w as WorkSystem));
}

/** Where homing leaves each axis, in machine coordinates (machine_limits.c limits_set_machine_positions):
 *  0 with "set machine origin to 0" ($22 bit 3); otherwise −$27 for an axis homing up, or −$13x + $27 for one
 *  homing down ($23). Undefined until those settings are read. */
function homePosition(): Position | undefined {
  const s = machine.settings.value;
  const travel = [130, 131, 132].map(id => parseFloat(s[id] ?? ''));
  const flags = parseInt(s[22] ?? ''), dir = parseInt(s[23] ?? ''), pulloff = parseFloat(s[27] ?? '');
  if (travel.some(isNaN) || isNaN(flags) || isNaN(dir) || isNaN(pulloff)) return undefined;
  const at = (i: number) => (flags & 8) ? 0 : (dir & (1 << i)) ? -travel[i] + pulloff : -pulloff;
  return { x: at(0), y: at(1), z: at(2) };
}

/** Where the program starts from: the machine position while it stands idle and no job runs, to the
 *  micron. A jog or a move while idle sets it once the machine is at rest; a run never does. */
const startAt = signal<Point | null>(null);
effect(() => {
  const s = machine.stateName.value, m = machine.mpos.value;
  if (!connection.connected.value) { startAt.value = null; return; }
  if (job.running.value || !['idle', 'alarm', 'check', 'sleep'].includes(s)) return;
  const r = (v: number) => Math.round(v * 1000) / 1000;
  const p = { x: r(m.x), y: r(m.y), z: r(m.z) }, was = startAt.peek();
  if (!was || was.x !== p.x || was.y !== p.y || was.z !== p.z) startAt.value = p;
});

/** What the interpreter needs from the controller, as far as it is known. With `withPosition`, the
 *  program starts from where the machine stands (startAt). The modes are the controller's now ($G). */
export function context(withPosition = true): InterpreterContext {
  const ctx: InterpreterContext = {};
  const offsets = machine.offsets.value;
  if (machine.offsetsRead.value) {
    const table: InterpreterContext['workOffsets'] = {};
    for (const k of WCS) if (offsets[k]) table[k] = vec(offsets[k]);
    ctx.workOffsets = table;
    if (offsets.G28) ctx.g28 = vec(offsets.G28);
    if (offsets.G30) ctx.g30 = vec(offsets.G30);
    if (offsets.G92) ctx.initialG92 = vec(offsets.G92);
  }
  const wcs = machine.wcs.value as WorkSystem;
  ctx.activeWorkOffset = WCS.includes(wcs) ? wcs : 'G54';
  // The whole vector decides: an offset in X or Y alone counts, with Z 0.
  const tlo = machine.tlo.value, tloVector = machine.tloVector.value;
  const lengthOffset = tloVector ? vec(tloVector) : tlo ? { x: 0, y: 0, z: tlo } : null;
  if (lengthOffset && (lengthOffset.x || lengthOffset.y || lengthOffset.z)) ctx.initialLengthOffset = lengthOffset;
  // $110-$112 are mm/min whatever $13 says, as are $27, $28 and $130-$132.
  const rate = (id: number) => { const v = parseFloat(machine.settings.value[id] ?? ''); return v > 0 ? v : undefined; };
  const rates = { x: rate(110), y: rate(111), z: rate(112) };
  if (rates.x && rates.y && rates.z) ctx.rapidRates = rates as Point;
  const g73 = rate(28);
  if (g73) ctx.g73RetractMm = g73;
  const home = homePosition();
  if (home) ctx.homePosition = home;
  ctx.homing = homing();
  // Each tool's whole offset: grblHAL's G43 H applies it on every axis by default (TOOL_LENGTH_OFFSET_AXIS
  // -1). An axis the table doesn't list is taken as 0.
  const table = machine.toolTable.value;
  if (table) {
    const lengths: Record<number, Point> = {};
    for (const e of table) if (e.z !== null) lengths[e.tool] = { x: e.x ?? 0, y: e.y ?? 0, z: e.z };
    ctx.toolLengthOffsets = lengths;
  }
  const tool = machine.tool.value;
  if (tool) ctx.initialTool = tool;
  if (connection.connected.value) {
    const modes = modesFromWords(machine.modal.value);
    if (modes) ctx.initialModes = modes;
  }
  ctx.afterProgramEnd = options.runAfterM30.value ? 'continue' : 'stop';
  const at = startAt.value;
  if (withPosition && at) ctx.initialPosition = { ...at };
  return ctx;
}

/** The lines as the interpreter reads them. $ and [ lines go as they are: it knows which change nothing,
 *  follows $H, and leaves the reading incomplete after the others. */
export function programText(lines: string[]): string {
  return lines.join('\n');
}

const HEADER_TOOL = /^T(\d+)\s+(.*)$/i;

/** "D=6 CR=3 - ZMIN=-5.99 - ball end mill" → "6 mm ball end mill". */
function describe(rest: string): string {
  const parts = rest.split(' - ').map(p => p.trim());
  const dia = rest.match(/\bD=([\d.]+)/i);
  const kind = parts.length > 1 ? parts[parts.length - 1] : '';
  return [dia ? parseFloat(dia[1]) + ' mm' : '', kind].filter(Boolean).join(' ') || rest;
}

function describedTools(p: Program): Record<number, string> {
  const out: Record<number, string> = {};
  for (const line of p.lines) {
    if (line.code) continue;
    for (const c of lexLine(line.raw).comments) {
      const m = c.match(HEADER_TOOL);
      if (m && !/\bM0*6\b/i.test(m[2])) out[parseInt(m[1])] ??= describe(m[2]);
    }
  }
  return out;
}

function toolRows(p: Program, cum: Float64Array): ToolRow[] {
  const rows: ToolRow[] = p.tools.map((u, index) => ({
    index, tool: u.tool, changeLine: u.changeLine ?? 0, start: u.startLine, end: u.endLine,
    name: [...new Set(u.operations.map(id => p.operations[id]?.name).filter(n => n && !HEADER_TOOL.test(n)))].join(' · '),
    estSeconds: u.estimatedSeconds, timeComplete: u.timeComplete,
  }));
  if (!rows.length) return rows;
  // What comes before the first M6 with nothing cut (a G28, the setup blocks) belongs to the first tool.
  const first = rows[0];
  const cuts = first.changeLine === 0 && rows.length > 1 && p.moves.some(m => m.toolUse === first.index && m.kind !== 'rapid');
  if (first.changeLine === 0 && rows.length > 1 && !cuts) {
    rows.shift();
    rows[0].start = 1;
    rows[0].estSeconds += first.estSeconds;
    rows[0].timeComplete &&= first.timeComplete;
  } else rows[0].start = 1;
  rows[rows.length - 1].end = p.lines.length;
  rows.forEach((r, k) => { r.index = k; if (k + 1 < rows.length) r.end = rows[k + 1].start - 1; });
  // The rows' times from the per-line sums, so that they and the progress agree.
  for (const r of rows) r.estSeconds = cum[r.end] - cum[r.start - 1];
  return rows;
}

/** The program's own motion: the end of every move and the extremes of every arc, in machine
 *  coordinates and per work offset in that offset's coordinates. Unlike the interpreter's bounds it
 *  leaves out where the machine starts from, G53 moves and G28/G30, so Frame traces the work, not
 *  the way to it. The travel check uses the interpreter's bounds, which have all of them. An axis
 *  counts from the first move whose line names it: a first G0 Z5 ends at the start's X and Y. */
function programExtent(p: Program): ProgramView['extent'] {
  const machine = emptyBounds(), perWorkOffset: ProgramView['extent']['perWorkOffset'] = {};
  const named = { x: false, y: false, z: false };
  for (const m of p.moves) {
    if (/^(G(53|28|30)\b|\$H)/.test(m.source)) continue;
    if (!named.x || !named.y || !named.z) {
      const code = p.lines[m.line - 1]?.code ?? '';
      for (const [letter] of lexLine(code).words) if (letter === 'X' || letter === 'Y' || letter === 'Z') named[letter === 'X' ? 'x' : letter === 'Y' ? 'y' : 'z'] = true;
    }
    const wb = perWorkOffset[m.workOffset] ??= emptyBounds();
    for (const end of m.arc ? moveExtrema(m).slice(1) : [m.end]) {
      const pt: Position = { x: named.x ? end.x : null, y: named.y ? end.y : null, z: named.z ? end.z : null };
      includePoint(machine, pt);
      includePoint(wb, { x: subtract(pt.x, m.frameOffset.x), y: subtract(pt.y, m.frameOffset.y), z: subtract(pt.z, m.frameOffset.z) } as Position);
    }
  }
  return { machine, perWorkOffset };
}

/** Read the lines of a program with the controller as it is now. */
export function read(lines: string[], ctx: InterpreterContext = context()): ProgramView {
  const t0 = performance.now();
  const program = interpretGcode(programText(lines), ctx);
  const per = new Float64Array(program.lines.length + 1);
  for (const m of program.moves) if (m.estimatedSeconds) per[m.line] += m.estimatedSeconds;
  for (const e of program.events) if (e.seconds) per[e.line] += e.seconds;
  const cum = new Float64Array(program.lines.length + 1);
  for (let i = 1; i < cum.length; i++) cum[i] = cum[i - 1] + per[i];
  return {
    program, rows: toolRows(program, cum), described: describedTools(program), cum, estSeconds: cum[cum.length - 1],
    stopped: program.issues.find(i => i.severity === 'error') ?? null, extent: programExtent(program), readMs: performance.now() - t0,
  };
}

/** The loaded program, read; null with no file, or until it has been read. */
export const view = signal<ProgramView | null>(null);
/** Reading is under way (it takes about a second for 28,000 moves). */
export const isReading = signal(false);

/** Read again at once, for those who changed something the program depends on (offsets.ts). */
export function reread(): void { schedule(true); }

/** Read now if anything it depends on has changed: Start, so the run's rows are read from its modes. */
export function readNow(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  readIfStale(false);
}

// What a reading depends on, besides the lines and the start: a new reading only when one of these changes.
const contextKey = computed(() => JSON.stringify(context(false)));
const startKey = () => JSON.stringify(startAt.peek());

let timer: ReturnType<typeof setTimeout> | null = null;
let readFor: string[] | null = null;
let readKey = '';
let readStart = '';

function readIfStale(force: boolean): void {
  const lines = job.lines.peek();
  if (!lines.length) { view.value = null; isReading.value = false; readFor = null; return; }
  const key = contextKey.peek(), start = startKey();
  if (!force && lines === readFor && key === readKey && start === readStart) { isReading.value = false; return; }
  // Not while the file runs: the tool changes and offset reads would make it read again mid-job,
  // and the rows must stay the run's. It reads once the run ends (the effect below watches it).
  if (lines === readFor && job.running.peek()) { isReading.value = false; return; }
  const v = read(lines);
  readFor = lines; readKey = key; readStart = start;
  view.value = v;
  isReading.value = false;
  log('info', `Program read: ${v.program.moves.length.toLocaleString('en-GB')} moves, ${v.rows.length} tool${v.rows.length === 1 ? '' : 's'}, ` +
    `about ${Math.round(v.estSeconds)} s of motion, in ${Math.round(v.readMs)} ms` + (v.stopped ? `; stops at line ${v.stopped.line}: ${v.stopped.message}` : ''));
}

function schedule(force = false, delay = 30): void {
  if (timer) clearTimeout(timer);
  // A moment first, so the screen says "reading" before the page is busy, and a burst of offset reads makes one reading.
  timer = setTimeout(() => { timer = null; readIfStale(force); }, delay);
}

let lastStart = '';
effect(() => {
  const lines = job.lines.value;
  contextKey.value;
  job.running.value;
  const start = JSON.stringify(startAt.value);
  if (lines !== readFor) { view.value = null; isReading.value = lines.length > 0; }
  // Only the start moved (a jog, a move while idle): read once it has stayed put a moment.
  const moved = start !== lastStart && lines === readFor;
  lastStart = start;
  schedule(false, moved ? 400 : 30);
});

/** The row a line belongs to. */
export function rowAt(rows: ToolRow[], line: number): number {
  for (let k = rows.length - 1; k >= 0; k--) if (line >= rows[k].start) return k;
  return 0;
}

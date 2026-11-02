// ═══════════════════════════════════════════════
// Program store — the loaded file as the G-code interpreter reads it
// ═══════════════════════════════════════════════
//
// Everything that reads the program goes through src/gcode: the Preview, the Jobs list's tools and
// times, the Setup list's travel and tools, and the resume. It is read again whenever what it
// depends on changes: the file, the work offsets, G92, the tool length, G28/G30, the rapid rates
// and the tool table.

import { signal, computed, effect } from '@preact/signals';
import { interpretGcode, lexLine } from '../gcode/index';
import type { InterpreterContext, Issue, Point, Program, WorkSystem } from '../gcode/index';
import { log } from '../console';
import * as job from './job';
import * as machine from './machine';
import * as connection from './connection';

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
  /** How long the reading took, in ms. */
  readMs: number;
}

const WCS: WorkSystem[] = ['G54', 'G55', 'G56', 'G57', 'G58', 'G59', 'G59.1', 'G59.2', 'G59.3'];
const vec = (v: machine.Vec3): Point => ({ x: v.x, y: v.y, z: v.z });

/** What the interpreter needs from the controller, as far as it is known. The machine position is
 *  where the program starts from; it is taken as it is now, and isn't a reason to read again. */
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
  const tlo = machine.tlo.value;
  if (tlo) ctx.initialLengthOffset = { x: 0, y: 0, z: tlo };
  // $110-$112 are mm/min whatever $13 says.
  const rate = (id: number) => { const v = parseFloat(machine.settings.value[id] ?? ''); return v > 0 ? v : undefined; };
  const rates = { x: rate(110), y: rate(111), z: rate(112) };
  if (rates.x && rates.y && rates.z) ctx.rapidRates = rates as Point;
  const table = machine.toolTable.value;
  if (table) {
    const lengths: Record<number, number> = {};
    for (const e of table) if (e.z !== null) lengths[e.tool] = e.z;
    ctx.toolLengthOffsets = lengths;
  }
  const tool = machine.tool.value;
  if (tool) ctx.initialTool = tool;
  if (withPosition && connection.connected.value && machine.state.peek()) ctx.initialPosition = vec(machine.mpos.peek());
  return ctx;
}

/** grblHAL takes $ and [ lines, which aren't G-code: read them as comments. They move nothing,
 *  except $H (homing), which leaves the position where homing puts it (an inference, not modelled). */
export function programText(lines: string[]): string {
  return lines.map(l => /^[$[]/.test(l) ? ';' + l : l).join('\n');
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
    stopped: program.issues.find(i => i.severity === 'error') ?? null, readMs: performance.now() - t0,
  };
}

/** The loaded program, read; null with no file, or until it has been read. */
export const view = signal<ProgramView | null>(null);
/** Reading is under way (it takes about a second for 28,000 moves). */
export const reading = signal(false);

/** Read again at once, for those who changed something the program depends on (offsets.ts). */
export function reread(): void { schedule(true); }

// What a reading depends on, besides the lines: a new reading only when one of these changes.
const contextKey = computed(() => JSON.stringify(context(false)));

let timer: ReturnType<typeof setTimeout> | null = null;
let readFor: string[] | null = null;
let readKey = '';

function schedule(force = false): void {
  if (timer) clearTimeout(timer);
  // A moment first, so the screen says "reading" before the page is busy, and a burst of offset reads makes one reading.
  timer = setTimeout(() => {
    timer = null;
    const lines = job.lines.value;
    if (!lines.length) { view.value = null; reading.value = false; readFor = null; return; }
    const key = contextKey.value;
    if (!force && lines === readFor && key === readKey) { reading.value = false; return; }
    // Not while the file runs: the tool changes and offset reads would make it read again mid-job,
    // and the rows must stay the run's. It reads once the run ends (the effect below watches it).
    if (lines === readFor && job.running.value) { reading.value = false; return; }
    const v = read(lines);
    readFor = lines; readKey = key;
    view.value = v;
    reading.value = false;
    log('info', `Program read: ${v.program.moves.length.toLocaleString('en-GB')} moves, ${v.rows.length} tool${v.rows.length === 1 ? '' : 's'}, ` +
      `about ${Math.round(v.estSeconds)} s of motion, in ${Math.round(v.readMs)} ms` + (v.stopped ? `; stops at line ${v.stopped.line}: ${v.stopped.message}` : ''));
  }, 30);
}

effect(() => {
  const lines = job.lines.value;
  contextKey.value;
  job.running.value;
  if (lines !== readFor) { view.value = null; reading.value = lines.length > 0; }
  schedule();
});

/** The row a line belongs to. */
export function rowAt(rows: ToolRow[], line: number): number {
  for (let k = rows.length - 1; k >= 0; k--) if (line >= rows[k].start) return k;
  return 0;
}

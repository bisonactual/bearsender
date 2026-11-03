// ═══════════════════════════════════════════════
// Flight recorder — job id, line numbering and the resume plan
// ═══════════════════════════════════════════════
//
// Pure functions, no DOM. Same rules as the Flight-Recorder repo's test sender
// (tools/stream.py) and its docs/COMMANDS.md:
//   - every line goes out as N<line> + the line, where <line> counts the loaded
//     file's lines (state.gcodeLines, so blank lines don't count)
//   - the job is stamped first with $FLIGHT=<CRC-32 of the file>
//   - to resume, work out the modal state up to the recorded line and where each
//     axis was, put the file's tool length offset back, go up to the lift height
//     unless the tool is higher, over the start of the line, straight down, and
//     stream on from that line
// The modal state and the position come from the G-code interpreter (src/gcode), read from the modes
// the job started from (stores/starts.ts) and the offsets and tool length as they are when Resume is pressed.

import { interpretGcode, lexLine } from './gcode/index';
import type { InterpreterContext, ModalState } from './gcode/index';

const _enc = new TextEncoder();
let _crcTable: number[] | null = null;

export function crc32(text: string): number {
  if (!_crcTable) {
    _crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      _crcTable.push(c >>> 0);
    }
  }
  let crc = 0xFFFFFFFF;
  for (const byte of _enc.encode(text)) crc = _crcTable[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

export function jobId(lines: string[]): string {
  return crc32(lines.join('\n')).toString(16).toUpperCase().padStart(8, '0');
}

/** Upper case, comments and spaces taken out. */
export function cleanLine(raw: string): string {
  return raw.replace(/\(.*?\)/g, '').replace(/;.*/, '').toUpperCase().replace(/\s+/g, '');
}

/** The line to send with its N-number, or null if there's nothing to send. */
export function numberedLine(raw: string, line: number): string | null {
  const text = cleanLine(raw).replace(/N\d+(\.\d+)?/g, '');
  if (!text) return null;
  // System commands, user commands and program demarcation go out as they are.
  if (text.startsWith('$') || text.startsWith('[') || text === '%') return text;
  return 'N' + line + text;
}

// ── Resume plan ───────────────────────────────────────────────────────────────

export class ResumeRefused extends Error {}

const CYCLES = new Set([73, 76, 81, 82, 83, 84, 85, 86, 87, 88, 89]);
const gWords = (raw: string) => lexLine(raw).words.filter(([l]) => l === 'G').map(([, v]) => v);

/**
 * The modal state in force at the start of line `upto` (counted as the job's N numbers), and the
 * machine position then, as the interpreter reads the program up to it. `text` is the program as
 * the interpreter reads it (stores/program.ts programText).
 */
export function resumeState(text: string, upto: number, context: InterpreterContext): ModalState {
  const program = interpretGcode(text, context);
  if (upto < 1 || upto > program.lines.length) throw new ResumeRefused(`line ${upto} isn't in the loaded file`);
  const before = program.issues.find(i => i.severity === 'error' && i.line < upto);
  if (before) throw new ResumeRefused(`line ${before.line}, before it, can't be read (${before.message.replace(/ Interpretation stops here.*$/, '')}), so the state there isn't known`);
  const here = program.issues.find(i => i.severity === 'error' && i.line === upto);
  if (here) throw new ResumeRefused(`line ${upto}: ${here.message.replace(/ Interpretation stops here.*$/, '')}`);
  const s = program.stateAfterLine(upto - 1);
  if (s.programEnd && context.afterProgramEnd !== 'continue') throw new ResumeRefused(`line ${upto} comes after the program end, and isn't sent (Options: Run lines after M30 is off)`);
  if (s.cycle || gWords(program.lines[upto - 1].raw).some(g => CYCLES.has(g)) || CYCLES.has(parseFloat(s.motion.slice(1))))
    throw new ResumeRefused(`line ${upto}: canned cycles can't be resumed`);
  const g92 = context.initialG92 ?? { x: 0, y: 0, z: 0 };
  if ((['x', 'y', 'z'] as const).some(a => s.g92[a] !== g92[a])) throw new ResumeRefused('G92 offsets set by the program can\'t be resumed');
  if (s.position.x === null || s.position.y === null || s.position.z === null)
    throw new ResumeRefused('no position before the resume line, start the job again instead');
  return s;
}

/** The modal state as the resume dialog lists it: "G21 G90 G17 G54 · T2 · M3 S16000 · F900 · coolant off". */
export function describeState(s: ModalState): string {
  const coolant = s.coolant.mist || s.coolant.flood ? [s.coolant.mist ? 'M7' : '', s.coolant.flood ? 'M8' : ''].filter(Boolean).join(' ') : 'coolant off';
  return [
    [s.units, s.distance, s.plane, s.feedMode, s.workOffset, s.motion].join(' '),
    s.tool !== null ? 'T' + s.tool : 'no tool named',
    s.spindle === 'M5' ? 'spindle off' : `${s.spindle} S${s.spindleSpeed ?? '?'}`,
    s.programmedFeed !== null ? 'F' + s.programmedFeed : 'no feed yet',
    coolant,
    s.lengthOffset.mode === 'G49' ? 'G49' : s.lengthOffset.h !== null ? 'G43 H' + s.lengthOffset.h
      : `tool length offset as on the controller (Z ${s.lengthOffset.value.z?.toFixed(3) ?? '?'})`,
  ].filter(Boolean).join(' · ');
}

/** The tool length offset in force at the resume line, as one line to send: G49 where the file cancelled
 *  it (or nothing was in force), G43 H<n> where the file set it, or, where the job ran on the offset the
 *  controller had when it started (G43.1, $TPW), that offset as it is now, in mm. */
export function lengthOffsetLine(s: ModalState): string {
  const o = s.lengthOffset;
  if (o.mode === 'G49') return 'G49';
  if (o.h !== null) return `G43H${o.h}`;
  if (o.value.x === null || o.value.y === null || o.value.z === null) throw new ResumeRefused('the tool length offset before the resume line isn\'t known');
  return 'G21G43.1' + (['x', 'y'] as const).filter(k => o.value[k] !== 0).map(k => k.toUpperCase() + o.value[k]!.toFixed(4)).join('') + 'Z' + o.value.z.toFixed(4);
}

/** The first move: up to `liftZ` (machine Z) unless the tool is already higher, so it never goes down. */
export interface Lift { liftZ: number; currentZ: number; }

/**
 * The lines that take the machine back onto the start of the resume line. The tool length offset is
 * put back first, as the file had it there, before any move. The moves back in are in machine
 * coordinates (G53), mm and feed per minute, to the interpreter's machine position: up to the lift
 * height (or not at all, if the tool is higher), across, then straight down. Then the program's own
 * modes are put back: units, distance, plane, feed mode, work offset, and its feed.
 */
export function resumePreamble(job: string, noRetract: boolean, s: ModalState, lift: Lift, spinup = 2): string[] {
  const p = s.position;
  if ((s.spindle === 'M3' || s.spindle === 'M4') && !s.spindleSpeed)
    throw new ResumeRefused('the spindle is on with no speed set before the resume line');
  const plungeFeed = s.feedMode === 'G94' && s.feed ? s.feed : 100;   // mm/min
  const f4 = (v: number | null) => v!.toFixed(4);
  const preamble = [`$FLIGHT=${job}${noRetract ? ',1' : ''}`, `G21G90G94${s.plane}`, lengthOffsetLine(s)];
  if (lift.currentZ < lift.liftZ - 0.0005) preamble.push(`G53G0Z${lift.liftZ.toFixed(4)}`);   // up to the lift height
  preamble.push(`G53G0X${f4(p.x)}Y${f4(p.y)}`);               // over the start of the resume line
  if (s.spindle === 'M3' || s.spindle === 'M4') preamble.push(`S${s.spindleSpeed!.toFixed(0)}${s.spindle}`, `G4P${spinup.toFixed(1)}`);
  if (s.coolant.mist) preamble.push('M7');
  if (s.coolant.flood) preamble.push('M8');
  preamble.push(`G53G1Z${f4(p.z)}F${plungeFeed.toFixed(1)}`);   // straight down, the tool has been there before
  // G91.1 and G98 are grblHAL's own defaults; the others only when the program used them.
  const feed = s.feedMode === 'G94' && s.programmedFeed !== null ? `F${s.programmedFeed.toFixed(1)}` : '';
  preamble.push(s.units + s.distance + s.feedMode + s.workOffset + (s.arcDistance === 'G90.1' ? 'G90.1' : '') + (s.retract === 'G99' ? 'G99' : '') + feed);
  return preamble;
}

/** Index into gcodeLines of the line to resume from, and that line with its motion mode put back. */
export function resumeStart(gcodeLines: string[], recordLine: number, motion: string): { index: number; first: string } {
  for (let i = Math.max(0, recordLine - 1); i < gcodeLines.length; i++) {
    const first = numberedLine(gcodeLines[i], i + 1);
    if (!first || first.startsWith('$') || first.startsWith('[') || first === '%') continue;
    const hasMotion = gWords(gcodeLines[i]).some(g => g === 0 || g === 1 || g === 2 || g === 3);
    return { index: i, first: hasMotion ? first : first.replace(/^(N\d+)/, '$1' + motion) };
  }
  throw new ResumeRefused('nothing left to run after the recorded line');
}

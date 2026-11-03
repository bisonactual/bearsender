// The flight recorder's job id, line numbering and resume plan, as pure functions. The rules are the
// Flight-Recorder repo's test sender's (tools/stream.py) and its docs/COMMANDS.md:
// - every line goes out as N<line> and the line, <line> counting the loaded file's lines (job.lines,
//   so blank lines don't count);
// - the job is stamped first with $FLIGHT=<CRC-32 of the file>;
// - a resume works out the modal state and position at the recorded line, puts the file's tool length
//   offset back, goes up to the lift height unless the tool is higher, over the start of the line and
//   straight down, then streams on from that line.
// The state and position come from the G-code interpreter (src/gcode), read from the modes the job
// started from (stores/starts.ts) and the offsets and tool length as they are when Resume is pressed.

import { interpretGcode, lexLine } from './gcode/index';
import type { InterpreterContext, ModalState } from './gcode/index';

const encoder = new TextEncoder();
let crcTable: number[] | null = null;

export function crc32(text: string): number {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      crcTable.push(c >>> 0);
    }
  }
  let crc = 0xFFFFFFFF;
  for (const byte of encoder.encode(text)) crc = crcTable[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
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

// Resume plan

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
  const state = program.stateAfterLine(upto - 1);
  if (state.programEnd && context.afterProgramEnd !== 'continue') throw new ResumeRefused(`line ${upto} comes after the program end, and isn't sent (Options: Run lines after M30 is off)`);
  if (state.cycle || gWords(program.lines[upto - 1].raw).some(g => CYCLES.has(g)) || CYCLES.has(parseFloat(state.motion.slice(1))))
    throw new ResumeRefused(`line ${upto}: canned cycles can't be resumed`);
  const g92 = context.initialG92 ?? { x: 0, y: 0, z: 0 };
  if ((['x', 'y', 'z'] as const).some(a => state.g92[a] !== g92[a])) throw new ResumeRefused('G92 offsets set by the program can\'t be resumed');
  if (state.position.x === null || state.position.y === null || state.position.z === null)
    throw new ResumeRefused('no position before the resume line, start the job again instead');
  return state;
}

/** The modal state as the resume dialog lists it: "G21 G90 G17 G54 · T2 · M3 S16000 · F900 · coolant off". */
export function describeState(state: ModalState): string {
  const coolant = state.coolant.mist || state.coolant.flood ? [state.coolant.mist ? 'M7' : '', state.coolant.flood ? 'M8' : ''].filter(Boolean).join(' ') : 'coolant off';
  return [
    [state.units, state.distance, state.plane, state.feedMode, state.workOffset, state.motion].join(' '),
    state.tool !== null ? 'T' + state.tool : 'no tool named',
    state.spindle === 'M5' ? 'spindle off' : `${state.spindle} S${state.spindleSpeed ?? '?'}`,
    state.programmedFeed !== null ? 'F' + state.programmedFeed : 'no feed yet',
    coolant,
    state.lengthOffset.mode === 'G49' ? 'G49' : state.lengthOffset.h !== null ? 'G43 H' + state.lengthOffset.h
      : `tool length offset as on the controller (Z ${state.lengthOffset.value.z?.toFixed(3) ?? '?'})`,
  ].filter(Boolean).join(' · ');
}

/** The tool length offset in force at the resume line, as one line to send: G49 where the file
 *  cancelled it or none was in force, G43 H<n> where the file set it, or the controller's offset as
 *  it is now, in mm, where the job ran on the one it had at the start (G43.1, $TPW). */
export function lengthOffsetLine(state: ModalState): string {
  const offset = state.lengthOffset;
  if (offset.mode === 'G49') return 'G49';
  if (offset.h !== null) return `G43H${offset.h}`;
  if (offset.value.x === null || offset.value.y === null || offset.value.z === null) throw new ResumeRefused('the tool length offset before the resume line isn\'t known');
  return 'G21G43.1' + (['x', 'y'] as const).filter(k => offset.value[k] !== 0).map(k => k.toUpperCase() + offset.value[k]!.toFixed(4)).join('') + 'Z' + offset.value.z.toFixed(4);
}

/** The first move: up to `liftZ` (machine Z) unless the tool is already higher, so it never goes down. */
export interface Lift { liftZ: number; currentZ: number; }

/**
 * The lines that take the machine back onto the start of the resume line. Before any move, the tool
 * length offset goes back as the file had it there, and the spindle and coolant are stopped where the
 * file had them off (the operator may have switched them on). The moves are in machine coordinates
 * (G53), mm and mm/min: up to the lift height unless the tool is higher, across, then straight down,
 * with the spindle and coolant started above the line where the file had them on. Then the program's
 * own modes go back: units, distance, plane, feed mode, work offset, cycle retract and feed.
 */
export function resumePreamble(job: string, noRetract: boolean, state: ModalState, lift: Lift, spinup = 2): string[] {
  const position = state.position;
  const spindleOn = state.spindle === 'M3' || state.spindle === 'M4';
  if (spindleOn && !state.spindleSpeed) throw new ResumeRefused('the spindle is on with no speed set before the resume line');
  const plungeFeed = state.feedMode === 'G94' && state.feed ? state.feed : 100;   // mm/min
  const fixed4 = (v: number | null) => v!.toFixed(4);
  const preamble = [`$FLIGHT=${job}${noRetract ? ',1' : ''}`, `G21G90G94${state.plane}`, lengthOffsetLine(state)];
  if (!spindleOn) preamble.push('M5');
  if (!state.coolant.mist || !state.coolant.flood) preamble.push('M9');   // what should be on comes back on below
  if (lift.currentZ < lift.liftZ - 0.0005) preamble.push(`G53G0Z${lift.liftZ.toFixed(4)}`);   // up to the lift height
  preamble.push(`G53G0X${fixed4(position.x)}Y${fixed4(position.y)}`);               // over the start of the resume line
  if (spindleOn) preamble.push(`S${state.spindleSpeed!.toFixed(0)}${state.spindle}`, `G4P${spinup.toFixed(1)}`);
  if (state.coolant.mist) preamble.push('M7');
  if (state.coolant.flood) preamble.push('M8');
  preamble.push(`G53G1Z${fixed4(position.z)}F${plungeFeed.toFixed(1)}`);   // straight down, the tool has been there before
  // G91.1 is grblHAL's only arc mode; G98/G99 always, as an earlier job or the console may have left either.
  const feed = state.feedMode === 'G94' && state.programmedFeed !== null ? `F${state.programmedFeed.toFixed(1)}` : '';
  preamble.push(state.units + state.distance + state.feedMode + state.workOffset + (state.arcDistance === 'G90.1' ? 'G90.1' : '') + state.retract + feed);
  return preamble;
}

/** The index in `lines` of the line to resume from, and that line with its motion mode put back. */
export function resumeStart(lines: string[], recordLine: number, motion: string): { index: number; first: string } {
  for (let i = Math.max(0, recordLine - 1); i < lines.length; i++) {
    const first = numberedLine(lines[i], i + 1);
    if (!first || first.startsWith('$') || first.startsWith('[') || first === '%') continue;
    const hasMotion = gWords(lines[i]).some(g => g === 0 || g === 1 || g === 2 || g === 3);
    return { index: i, first: hasMotion ? first : first.replace(/^(N\d+)/, '$1' + motion) };
  }
  throw new ResumeRefused('nothing left to run after the recorded line');
}

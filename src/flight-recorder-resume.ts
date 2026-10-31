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
//     axis was, go up to the retract height, over the start of the line, straight
//     down, and stream on from that line

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

type Frame = string;                                // G54..G59, or G53
type AxisPos = { mm: number; frame: Frame } | null;

export interface Modes {
  units: string; plane: string; wcs: string; distance: string; motion: string;
  F: number | null; S: number | null; spindle: string; coolant: string;
  pos: { X: AxisPos; Y: AxisPos; Z: AxisPos };
}

const WORD = /([A-Z])([-+]?[0-9]*\.?[0-9]+)/g;
const MOTION = new Set(['0', '1', '2', '3']);
const REFUSED: Record<string, string> = {
  '93': 'inverse time feed (G93)', '95': 'feed per revolution (G95)', '41': 'cutter compensation',
  '42': 'cutter compensation', '10': 'offsets set by the program (G10)', '92': 'G92 offsets',
};
const CYCLES = new Set(['73', '76', '81', '82', '83', '84', '85', '86', '87', '88', '89', '38.2', '38.3', '38.4', '38.5']);

function words(text: string): [string, string][] {
  return [...text.matchAll(WORD)].map(m => [m[1], m[2]] as [string, string]);
}

/** The G numbers on a line, tidied so that G01 is '1' and G38.20 is '38.2'. */
function gcodes(ws: [string, string][]): Set<string> {
  const codes = new Set<string>();
  for (const [letter, value] of ws) {
    if (letter !== 'G') continue;
    codes.add(value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : String(parseInt(value, 10)));
  }
  return codes;
}

export class ResumeRefused extends Error {}

/** The program as (line number, cleaned text), the same numbering the job was sent with. */
export function programLines(gcodeLines: string[]): { line: number; text: string }[] {
  const lines: { line: number; text: string }[] = [];
  gcodeLines.forEach((raw, i) => {
    const text = cleanLine(raw).replace(/N\d+(\.\d+)?/g, '');
    if (text && text !== '%' && !text.startsWith('$') && !text.startsWith('[')) lines.push({ line: i + 1, text });
  });
  return lines;
}

/** The modal state in force at the start of line `upto`, and where each axis was then. */
export function modalScan(lines: { line: number; text: string }[], upto: number): Modes {
  const modes: Modes = {
    units: 'G21', plane: 'G17', wcs: 'G54', distance: 'G90', motion: 'G0',
    F: null, S: null, spindle: 'M5', coolant: 'M9',
    pos: { X: null, Y: null, Z: null },
  };
  for (const { line, text } of lines) {
    if (line > upto) break;
    const ws = words(text);
    const codes = gcodes(ws);
    // Checked on the resume line itself as well.
    if ([...codes].some(c => CYCLES.has(c)))
      throw new ResumeRefused(`line ${line}: canned cycles and probing can't be resumed`);
    if (line === upto) break;
    const refused = [...codes].filter(c => c in REFUSED).sort();
    if (refused.length) throw new ResumeRefused(`line ${line}: ${REFUSED[refused[0]]} can't be resumed`);
    if (ws.some(([letter]) => 'ABCUVW'.includes(letter)))
      throw new ResumeRefused(`line ${line}: axes other than XYZ can't be resumed`);
    for (const code of codes) {
      if (MOTION.has(code)) modes.motion = 'G' + code;
      else if (code === '20' || code === '21') modes.units = 'G' + code;
      else if (code === '17' || code === '18' || code === '19') modes.plane = 'G' + code;
      else if (code === '90' || code === '91') modes.distance = 'G' + code;
      else if (['54', '55', '56', '57', '58', '59'].includes(code)) modes.wcs = 'G' + code;
    }
    for (const [letter, value] of ws) {
      if (letter === 'M') {
        const m = String(parseInt(value, 10));
        if (m === '3' || m === '4' || m === '5') modes.spindle = 'M' + m;
        else if (m === '7' || m === '8' || m === '9') modes.coolant = 'M' + m;
      } else if (letter === 'F') modes.F = parseFloat(value);
      else if (letter === 'S') modes.S = parseFloat(value);
    }
    const axes = ws.filter(([letter]) => letter === 'X' || letter === 'Y' || letter === 'Z');
    if (!axes.length) continue;
    if (codes.has('28') || codes.has('30')) {
      // A move to a stored position, which we don't know here.
      for (const [letter] of axes) modes.pos[letter as 'X' | 'Y' | 'Z'] = null;
      continue;
    }
    if (modes.distance === 'G91' && !codes.has('53'))
      throw new ResumeRefused(`line ${line}: incremental moves can't be resumed`);
    // A G20 or G21 on this line already applies to its own coordinates.
    const unit = modes.units === 'G20' ? 25.4 : 1;
    const frame = codes.has('53') ? 'G53' : modes.wcs;
    for (const [letter, value] of axes) modes.pos[letter as 'X' | 'Y' | 'Z'] = { mm: parseFloat(value) * unit, frame };
  }
  return modes;
}

/**
 * The lines that take the machine back onto the start of the resume line. The moves
 * back in are in mm, absolute and feed per minute, each axis in the frame it was
 * programmed in. Then the program's own units, work offset and feed are put back.
 */
export function resumePreamble(job: string, noRetract: boolean, modes: Modes, retractZ = -20, spinup = 2): string[] {
  const pos = modes.pos;
  if (!pos.X || !pos.Y || !pos.Z) throw new ResumeRefused('no position before the resume line, start the job again instead');
  if ((modes.spindle === 'M3' || modes.spindle === 'M4') && !modes.S)
    throw new ResumeRefused('the spindle is on with no speed set before the resume line');
  const plungeFeed = modes.F ? modes.F * (modes.units === 'G20' ? 25.4 : 1) : 100;   // mm/min

  const move = (axes: ('X' | 'Y' | 'Z')[], motion: string, feedWord = ''): string[] => {
    const frames = [...new Set(axes.map(a => pos[a]!.frame))].sort();
    return frames.map(frame =>
      frame + motion + axes.filter(a => pos[a]!.frame === frame).map(a => a + pos[a]!.mm.toFixed(4)).join('') + feedWord);
  };

  const preamble = [
    `$FLIGHT=${job}${noRetract ? ',1' : ''}`,
    `G21G90${modes.plane}G94`,
    `G53G0Z${retractZ.toFixed(4)}`,             // up to the retract height, in machine coordinates
    ...move(['X', 'Y'], 'G0'),                   // over the start of the resume line
  ];
  if (modes.spindle === 'M3' || modes.spindle === 'M4') preamble.push(`S${modes.S!.toFixed(0)}${modes.spindle}`, `G4P${spinup.toFixed(1)}`);
  if (modes.coolant === 'M7' || modes.coolant === 'M8') preamble.push(modes.coolant);
  preamble.push(...move(['Z'], 'G1', `F${plungeFeed.toFixed(1)}`));   // straight down, the tool has been there before
  preamble.push(modes.units + modes.wcs + (modes.F ? `F${modes.F.toFixed(1)}` : ''));
  return preamble;
}

/** Index into gcodeLines of the line to resume from, and that line with its motion mode put back. */
export function resumeStart(gcodeLines: string[], recordLine: number, modes: Modes): { index: number; first: string } {
  for (let i = Math.max(0, recordLine - 1); i < gcodeLines.length; i++) {
    const first = numberedLine(gcodeLines[i], i + 1);
    if (!first || first.startsWith('$') || first.startsWith('[') || first === '%') continue;
    const hasMotion = [...gcodes(words(first.replace(/^N\d+/, '')))].some(c => MOTION.has(c));
    return { index: i, first: hasMotion ? first : first.replace(/^(N\d+)/, '$1' + modes.motion) };
  }
  throw new ResumeRefused('nothing left to run after the recorded line');
}

import type { Arc, Axis, CycleCode, InterpreterContext, Issue, ModalState, Motion, Move, Operation, Position, Program, ProgramEvent, SourceLine, ToolUse, WorkSystem } from './types';
import { AXES, TAU, add, distance, emptyBounds, includePoint, moveExtrema, planeAxes, signedSweep, subtract, unknown, zero } from './geometry';
import { lexLine } from './lexer';
export * from './types';
export { sampleMove, moveExtrema, arcPoint, planeAxes } from './geometry';
export { lexLine } from './lexer';

const WCS = new Set([54, 55, 56, 57, 58, 59, 59.1, 59.2, 59.3]);
const CYCLES = new Set([73, 81, 82, 83, 85, 89]);
const SUPPORTED_G = new Set([0, 1, 2, 3, 4, 17, 18, 19, 20, 21, 28, 30, 40, 43, 49, 53, ...WCS, ...CYCLES, 80, 90, 91, 90.1, 91.1, 92, 93, 94, 98, 99]);
const SUPPORTED_M = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 30]);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const finitePosition = (v: Position): boolean => AXES.every(k => v[k] === null || Number.isFinite(v[k]));

/** Reinterpret the original text whenever machine context changes. No global state or UI imports. */
export function interpretGcode(text: string, context: InterpreterContext = {}): Program {
  const rawLines = text.split(/\r\n|\n|\r/), blocks = rawLines.map(lexLine);
  // Resolve the heading rule first so spindle/setup dwells after a heading are
  // charged to the upcoming operation, before its first physical move.
  const headings = new Map<number, string>();
  let candidate: { name: string; line: number } | null = null;
  blocks.forEach((block, index) => {
    if (!block.code && block.comments.some(Boolean)) candidate = { name: block.comments.filter(Boolean).join(' / '), line: index + 1 };
    const g = block.words.filter(([l]) => l === 'G').map(([, v]) => v);
    const m = block.words.filter(([l]) => l === 'M').map(([, v]) => v);
    const axisMotion = block.words.some(([l]) => 'XYZIJKR'.includes(l)) && !g.includes(92) && (!g.includes(4) || g.some(v => [0, 1, 2, 3].includes(v)));
    if (candidate && (m.includes(6) || axisMotion || g.some(v => v === 28 || v === 30 || CYCLES.has(v)))) {
      headings.set(candidate.line, candidate.name); candidate = null;
    }
    if (m.includes(2) || m.includes(30)) candidate = null;
  });
  const issues: Issue[] = [], moves: Move[] = [], events: ProgramEvent[] = [];
  const tools: ToolUse[] = [], operations: Operation[] = [], lines: SourceLine[] = [];
  const fileToLoader: (number | null)[] = [null], loaderToFile = [0];
  const bounds: Program['bounds'] = { machine: emptyBounds(), work: emptyBounds(), perWorkOffset: {} };
  const issue = (line: number, code: string, message: string, severity: Issue['severity'] = 'warning') => {
    issues.push({ line, code, message, severity });
  };
  const offsets = clone(context.workOffsets ?? {});
  const active = context.activeWorkOffset ?? 'G54';
  if (!Object.keys(offsets).length) {
    offsets[active] = { x: 0, y: 0, z: 0 };
    issue(0, 'assumed-work-offset', `No work offsets supplied; ${active} assumed zero.`, 'inference');
  }
  for (const p of Object.values(offsets)) if (!finitePosition(p)) throw new Error('Work offsets must be finite mm values');
  for (const p of [context.initialPosition, context.g28, context.g30, context.initialG92]) {
    if (p && !finitePosition(p)) throw new Error('Context coordinates must be finite mm or null');
  }
  const rapid = { x: 3000, y: 3000, z: 3000, ...context.rapidRates };
  if (AXES.some(k => context.rapidRates?.[k] === undefined)) issue(0, 'default-rapid', 'Unspecified rapid rates default to 3000 mm/min per axis.', 'inference');
  if (AXES.some(k => !Number.isFinite(rapid[k]) || rapid[k] <= 0)) throw new Error('Rapid rates must be positive mm/min');
  if (context.g73RetractMm !== undefined && (!Number.isFinite(context.g73RetractMm) || context.g73RetractMm <= 0)) throw new Error('g73RetractMm must be positive');
  const maxMoves = context.maxExpandedMoves ?? 1000000;
  if (!Number.isInteger(maxMoves) || maxMoves < 1) throw new Error('maxExpandedMoves must be a positive integer');
  let state: ModalState = {
    motion: 'G0', plane: 'G17', units: 'G21', distance: 'G90', arcDistance: 'G91.1', feedMode: 'G94',
    workOffset: active, workOffsetValue: offsets[active] ? { ...offsets[active]! } : unknown(),
    tool: context.initialTool ?? null, selectedTool: context.initialTool ?? null,
    lengthOffset: { mode: 'G49', h: null, value: zero() }, g92: { ...(context.initialG92 ?? zero()) },
    spindle: 'M5', spindleSpeed: null, coolant: { mist: false, flood: false }, feed: null, programmedFeed: null,
    retract: 'G98', position: { ...(context.initialPosition ?? unknown()) }, cycle: null,
    operation: null, programEnd: null, reliable: true,
  };
  if (!context.initialPosition) issue(0, 'unknown-start', 'Initial machine position not supplied; axes remain unknown until established by absolute moves.');
  if (!offsets[active]) issue(0, 'unknown-work-offset', `${active} not supplied; initial work translation is unknown.`);
  const initialState = clone(state);
  let currentTool: number | null = null;
  let halted = false, timeComplete = true, estimatedSeconds = 0;
  const frameOffset = (): Position => Object.fromEntries(AXES.map(k => [k, add(add(state.workOffsetValue[k], state.g92[k]), state.lengthOffset.value[k])])) as Position;
  const markIncomplete = () => { bounds.machine.complete = bounds.work.complete = timeComplete = false; };
  const stop = (line: number, code: string, message: string) => {
    issue(line, code, message + ' Interpretation stops here; later geometry/modal state is not guessed.', 'error');
    state.reliable = false; halted = true; markIncomplete();
  };
  const selectWcs = (wcs: WorkSystem, line: number) => {
    state.workOffset = wcs;
    state.workOffsetValue = offsets[wcs] ? { ...offsets[wcs]! } : unknown();
    if (!offsets[wcs]) issue(line, 'unknown-work-offset', `${wcs} not supplied; machine coordinates using it are unknown.`);
  };
  const beginOperation = (name: string, line: number) => {
    if (state.operation !== null) operations[state.operation].endLine = line - 1;
    const id = operations.length;
    operations.push({ id, name, inferred: true, startLine: line, endLine: line, estimatedSeconds: 0, timeComplete: true, tools: [] });
    state.operation = id;
    issue(line, 'operation-inference', `Comment-only heading inferred as operation: ${name}`, 'inference');
  };
  const ensureToolUse = (line: number, change = false) => {
    if (currentTool !== null && !change) return;
    if (currentTool !== null) tools[currentTool].endLine = line - 1;
    currentTool = tools.length;
    tools.push({ id: currentTool, tool: state.tool, changeLine: change ? line : null, startLine: line, endLine: line, estimatedSeconds: 0, timeComplete: true, operations: [] });
  };
  const account = (seconds: number | null, line: number) => {
    ensureToolUse(line);
    const tool = tools[currentTool!];
    tool.endLine = line;
    const op = state.operation === null ? null : operations[state.operation];
    if (op) {
      op.endLine = line;
      if (!tool.operations.includes(op.id)) tool.operations.push(op.id);
      if (!op.tools.includes(tool.id)) op.tools.push(tool.id);
    }
    if (seconds === null) {
      timeComplete = tool.timeComplete = false;
      if (op) op.timeComplete = false;
    } else {
      estimatedSeconds += seconds; tool.estimatedSeconds += seconds;
      if (op) op.estimatedSeconds += seconds;
    }
  };
  const event = (line: number, kind: ProgramEvent['kind'], seconds: number | null) => {
    account(seconds, line);
    events.push({ line, kind, seconds, tool: state.tool, toolUse: currentTool, operation: state.operation });
  };
  let inverseFeedOnBlock = false;
  const deltaTo = (end: Position, affected: Axis[] = AXES): Position => Object.fromEntries(AXES.map(k => [k, affected.includes(k) ? subtract(end[k], state.position[k]) : 0])) as Position;
  const emit = (line: number, kind: Move['kind'], end: Position, source: string, arc?: Arc, displacement = deltaTo(end)) => {
    if (halted) return;
    if (moves.length >= maxMoves) { stop(line, 'expansion-limit', `Exceeded ${maxMoves} expanded moves.`); return; }
    const start = { ...state.position };
    // Keep unknown-to-known transitions even if all known coordinates are unchanged.
    if (!arc && AXES.every(k => displacement[k] === 0)) return;
    let length = distance(zero(), displacement);
    if (arc) {
      const w = planeAxes(arc.plane)[2], rise = displacement[w];
      length = rise === null ? null : Math.hypot(arc.radius * arc.sweep, rise);
    }
    let seconds: number | null = null;
    if (kind === 'rapid') {
      const durations = AXES.map(k => displacement[k] === null ? null : Math.abs(displacement[k]!) / rapid[k] * 60);
      if (durations.every(v => v !== null)) seconds = Math.max(...durations as number[]);
    } else if (state.feedMode === 'G93') {
      if (inverseFeedOnBlock && state.feed !== null && state.feed > 0) seconds = 60 / state.feed;
      else issue(line, 'missing-inverse-feed', 'G93 requires a positive F on each feed/arc block; time is unknown.');
    } else if (state.feed !== null && state.feed > 0) {
      if (length !== null) seconds = length / state.feed * 60;
    } else issue(line, 'missing-feed', 'Feed move has no positive G94 feed; time is unknown.');
    if (length === null) issue(line, 'unknown-move-length', 'Move has unknown coordinates; length and ordinary feed/rapid time are incomplete.');
    account(seconds, line);
    const move: Move = {
      kind, line, loaderLine: fileToLoader[line]!, start, end: { ...end }, displacement: { ...displacement }, arc,
      workOffset: state.workOffset, frameOffset: frameOffset(), feed: state.feed, feedMode: state.feedMode,
      tool: state.tool, toolUse: currentTool, operation: state.operation, length, estimatedSeconds: seconds, source,
    };
    moves.push(move);
    const wb = bounds.perWorkOffset[state.workOffset] ??= emptyBounds();
    for (const p of moveExtrema(move)) {
      includePoint(bounds.machine, p);
      const work = Object.fromEntries(AXES.map(k => [k, subtract(p[k], move.frameOffset[k])])) as Position;
      includePoint(bounds.work, work); includePoint(wb, work);
    }
    state.position = { ...end };
  };
  const target = (words: Record<string, number>, scale: number, machine = false): Position => {
    const end = { ...state.position }, offset = frameOffset();
    for (const k of AXES) if (k.toUpperCase() in words) {
      const value = words[k.toUpperCase()] * scale;
      end[k] = machine ? value : state.distance === 'G91' ? add(end[k], value) : add(value, offset[k]);
    }
    return end;
  };
  const blockDelta = (words: Record<string, number>, scale: number, end: Position, machine = false): Position => {
    const delta = zero();
    for (const k of AXES) if (k.toUpperCase() in words) delta[k] = state.distance === 'G91' && !machine ? words[k.toUpperCase()] * scale : subtract(end[k], state.position[k]);
    return delta;
  };
  const makeArc = (line: number, words: Record<string, number>, end: Position, scale: number): Arc | null => {
    const start = state.position, [u, v] = planeAxes(state.plane), clockwise = state.motion === 'G2';
    if ([start[u], start[v], end[u], end[v]].some(n => n === null)) {
      stop(line, 'unknown-arc-plane', 'Cannot resolve arc with unknown in-plane coordinates.'); return null;
    }
    const p = words.P ?? 1;
    if (!Number.isInteger(p) || p < 1) { stop(line, 'invalid-arc-turns', 'Arc P must be a positive integer.'); return null; }
    const centre = { ...start };
    const letters: Record<string, string> = { x: 'I', y: 'J', z: 'K' };
    if ('R' in words) {
      if ('I' in words || 'J' in words || 'K' in words) { stop(line, 'ambiguous-arc', 'R and IJK cannot be mixed.'); return null; }
      const r = Math.abs(words.R * scale), dx = end[u]! - start[u]!, dy = end[v]! - start[v]!, chord = Math.hypot(dx, dy);
      if (chord < 1e-10 || r <= 0 || chord > r * 2 + 1e-8) {
        stop(line, 'invalid-radius-arc', 'R arc requires distinct endpoints and a radius at least half the chord; full-circle R is ambiguous.'); return null;
      }
      const h = Math.sqrt(Math.max(0, r * r - chord * chord / 4));
      const candidates = [1, -1].map(sign => {
        const cu = (start[u]! + end[u]!) / 2 - sign * dy / chord * h;
        const cv = (start[v]! + end[v]!) / 2 + sign * dx / chord * h;
        const a = Math.atan2(start[v]! - cv, start[u]! - cu);
        return { cu, cv, sweep: signedSweep(a, Math.atan2(end[v]! - cv, end[u]! - cu), clockwise) };
      });
      const chosen = candidates.find(c => words.R < 0 ? Math.abs(c.sweep) >= Math.PI - 1e-9 : Math.abs(c.sweep) <= Math.PI + 1e-9)!;
      centre[u] = chosen.cu; centre[v] = chosen.cv;
    } else {
      if (!(letters[u] in words) && !(letters[v] in words)) { stop(line, 'missing-arc-centre', 'Arc needs in-plane IJK or R.'); return null; }
      if (state.arcDistance === 'G90.1' && (!(letters[u] in words) || !(letters[v] in words))) {
        stop(line, 'missing-absolute-centre', 'G90.1 requires both in-plane centre words.'); return null;
      }
      const offset = frameOffset();
      for (const k of [u, v]) centre[k] = state.arcDistance === 'G91.1'
        ? add(start[k], (words[letters[k]] ?? 0) * scale) : add(words[letters[k]] * scale, offset[k]);
    }
    if (centre[u] === null || centre[v] === null) { stop(line, 'unknown-arc-centre', 'Arc centre depends on an unknown offset.'); return null; }
    const radius = Math.hypot(start[u]! - centre[u]!, start[v]! - centre[v]!);
    const endRadius = Math.hypot(end[u]! - centre[u]!, end[v]! - centre[v]!);
    // Allow finite CAM rounding, with grblHAL's radius consistency thresholds.
    const error = Math.abs(radius - endRadius);
    if (radius < 1e-10 || error > 0.5 || (error > 0.005 && error > radius * 0.001)) {
      stop(line, 'arc-radius-mismatch', `Arc radii disagree (${radius.toFixed(6)} vs ${endRadius.toFixed(6)} mm).`); return null;
    }
    const startAngle = Math.atan2(start[v]! - centre[v]!, start[u]! - centre[u]!);
    const base = signedSweep(startAngle, Math.atan2(end[v]! - centre[v]!, end[u]! - centre[u]!), clockwise);
    const sweep = base + (clockwise ? -1 : 1) * TAU * (p - 1);
    return { centre, radius, direction: clockwise ? 'cw' : 'ccw', plane: state.plane, turns: Math.abs(sweep) / TAU, programmedTurns: p, startAngle, sweep };
  };

  const expandCycle = (line: number, words: Record<string, number>, scale: number) => {
    const code = state.motion as CycleCode, [u, v, w] = planeAxes(state.plane), offset = frameOffset();
    const depthWord = w.toUpperCase(), prev = state.cycle;
    const fresh = !prev || prev.code !== code || prev.plane !== state.plane || prev.workOffset !== state.workOffset || prev.distance !== state.distance || AXES.some(k => prev.frameOffset[k] !== offset[k]);
    if (state.feedMode === 'G93') { stop(line, 'inverse-time-cycle', 'Canned cycles in G93 are invalid.'); return; }
    if (fresh && (!('R' in words) || !(depthWord in words))) { stop(line, 'incomplete-cycle', 'A new cycle needs R and its drilling-axis depth.'); return; }
    if (fresh && ['G82', 'G89'].includes(code) && !('P' in words)) { stop(line, 'missing-cycle-dwell', `${code} requires P on activation.`); return; }
    if (fresh && ['G73', 'G83'].includes(code) && !('Q' in words)) { stop(line, 'missing-cycle-peck', `${code} requires Q on activation.`); return; }
    const q = 'Q' in words ? words.Q * scale : fresh ? null : prev!.q;
    const dwell = ['G73', 'G83'].includes(code) ? 0.25 : ['G82', 'G89'].includes(code) ? ('P' in words ? words.P : prev!.dwell) : 0;
    const l = words.L ?? 1;
    if (!Number.isInteger(l) || l < 1 || dwell < 0 || (['G73', 'G83'].includes(code) && (q === null || q <= 0))) {
      stop(line, 'invalid-cycle-parameters', 'Cycle needs positive integer L, nonnegative dwell and positive Q for pecks.'); return;
    }
    if (code === 'G73' && context.g73RetractMm === undefined) { stop(line, 'unknown-chip-retract', 'G73 needs context.g73RetractMm (controller setting).'); return; }
    const entry = state.position[w];
    const r = 'R' in words ? state.distance === 'G91' ? add(entry, words.R * scale) : add(words.R * scale, offset[w]) : prev!.r;
    const bottom = depthWord in words ? state.distance === 'G91' ? add(r, words[depthWord] * scale) : add(words[depthWord] * scale, offset[w]) : prev!.depth;
    if (entry === null || r === null || bottom === null) { stop(line, 'unknown-cycle-depth', 'Cannot expand cycle with unknown entry/R/depth.'); return; }
    if (bottom > r) { stop(line, 'invalid-cycle-depth', 'Cycle depth must be at or below R.'); return; }
    const pecks = q === null ? 1 : Math.max(1, Math.ceil((r - bottom) / q));
    if (l * (pecks * 2 + 3) > maxMoves - moves.length) { stop(line, 'expansion-limit', 'Cycle expansion exceeds resource limit.'); return; }
    state.cycle = { code, plane: state.plane, workOffset: state.workOffset, distance: state.distance, frameOffset: offset, r, depth: bottom, q, dwell };
    const clear = state.retract === 'G99' ? r : Math.max(entry, r);
    const linear = (value: number, kind: 'rapid' | 'feed', phase: string) => {
      const end = { ...state.position, [w]: value };
      emit(line, kind, end, `${code} ${phase}`, undefined, deltaTo(end, [w]));
    };
    // grblHAL: raise to R before lateral motion, peck from the retract point,
    // dwell 0.25 s per G73/G83 peck, G73 partial retract set by g73_retract.
    if (entry < r) linear(r, 'rapid', 'preliminary raise');
    for (let repeat = 0; repeat < l && !halted; repeat++) {
      const hole = { ...state.position };
      for (const k of [u, v]) if (k.toUpperCase() in words) {
        const value = words[k.toUpperCase()] * scale;
        hole[k] = state.distance === 'G91' ? add(hole[k], value) : add(value, offset[k]);
      }
      emit(line, 'rapid', hole, `${code} hole ${repeat + 1}/${l}`, undefined, blockDelta(Object.fromEntries([u, v].filter(k => k.toUpperCase() in words).map(k => [k.toUpperCase(), words[k.toUpperCase()]])), scale, hole));
      linear(r, 'rapid', 'approach R');
      let depthNow = r;
      while (depthNow > bottom + 1e-10 && !halted) {
        depthNow = q === null ? bottom : Math.max(bottom, depthNow - q);
        linear(depthNow, 'feed', 'cut');
        if (dwell > 0) event(line, 'dwell', dwell);
        const retract = code === 'G73' && depthNow > bottom ? depthNow + context.g73RetractMm! : clear;
        linear(retract, ['G85', 'G89'].includes(code) ? 'feed' : 'rapid', 'retract');
      }
    }
  };

  for (let index = 0; index < rawLines.length; index++) {
    const raw = rawLines[index], line = index + 1, block = blocks[index], moveStart = moves.length;
    fileToLoader.push(raw.trim() ? loaderToFile.length : null);
    if (raw.trim()) loaderToFile.push(line);
    const finish = () => lines.push({ line, raw, code: block.code, loaderLine: fileToLoader[line], stateAfter: clone(state), moveRange: [moveStart, moves.length] });
    if (state.programEnd) {
      if (block.code && block.code !== '%') issue(line, 'after-program-end', 'Executable text after program end ignored.');
      finish(); continue;
    }
    // Diagnose unsupported tokens even in a suffix already stopped by an earlier error.
    for (const message of block.errors) issue(line, 'syntax', message, 'error');
    const gs = block.words.filter(([l]) => l === 'G').map(([, n]) => n);
    const ms = block.words.filter(([l]) => l === 'M').map(([, n]) => n);
    for (const g of gs) if (!SUPPORTED_G.has(g)) issue(line, 'unsupported-g', `G${g} is not handled${g === 41 || g === 42 ? ' (cutter compensation)' : ''}.`, 'error');
    for (const m of ms) if (!SUPPORTED_M.has(m)) issue(line, 'unsupported-m', `M${m} is not handled${m === 98 ? ' (subprogram call)' : ''}.`, 'error');
    for (const [letter] of block.words) if (!'GMNXYZIJKRPFSTHLQ'.includes(letter)) issue(line, 'unsupported-word', `${letter} word is not handled${'ABC'.includes(letter) ? ' (rotary axis)' : letter === 'O' ? ' (subprogram/macro)' : ''}.`, 'error');
    if (halted) { finish(); continue; }
    if (block.errors.length || gs.some(g => !SUPPORTED_G.has(g)) || ms.some(m => !SUPPORTED_M.has(m)) || block.words.some(([l]) => !'GMNXYZIJKRPFSTHLQ'.includes(l))) {
      stop(line, 'unsupported-block', 'Invalid or unsupported block.'); finish(); continue;
    }
    if (!block.code) {
      if (headings.has(line)) beginOperation(headings.get(line)!, line);
      finish(); continue;
    }
    if (block.code === '%') { finish(); continue; }
    const words: Record<string, number> = {}, seen = new Set<string>();
    let conflict = false;
    for (const [letter, value] of block.words) {
      if (letter === 'G' || letter === 'M') continue;
      if (seen.has(letter)) { stop(line, 'duplicate-word', `Duplicate ${letter} word.`); conflict = true; }
      seen.add(letter); words[letter] = value;
    }
    const groups = [
      gs.filter(g => [0, 1, 2, 3, 80].includes(g) || CYCLES.has(g)), gs.filter(g => [17, 18, 19].includes(g)),
      gs.filter(g => [20, 21].includes(g)), gs.filter(g => [90, 91].includes(g)), gs.filter(g => [90.1, 91.1].includes(g)),
      gs.filter(g => [93, 94].includes(g)), gs.filter(g => WCS.has(g)), gs.filter(g => [43, 49].includes(g)),
      gs.filter(g => [98, 99].includes(g)), gs.filter(g => [4, 28, 30, 92].includes(g)),
      ms.filter(m => [0, 1, 2, 30].includes(m)), ms.filter(m => [3, 4, 5].includes(m)),
    ];
    if (groups.some(g => g.length > 1) || (ms.includes(9) && (ms.includes(7) || ms.includes(8)))) {
      stop(line, 'modal-conflict', 'Multiple commands in one modal group.'); conflict = true;
    }
    if (conflict) { finish(); continue; }
    const before = clone(state);
    for (const g of gs) {
      if ([0, 1, 2, 3, 80].includes(g) || CYCLES.has(g)) {
        state.motion = `G${g}` as Motion;
        if (!CYCLES.has(g)) state.cycle = null;
      } else if ([17, 18, 19].includes(g)) state.plane = `G${g}` as ModalState['plane'];
      else if (g === 20 || g === 21) state.units = `G${g}`;
      else if (g === 90 || g === 91) state.distance = `G${g}`;
      else if (g === 90.1 || g === 91.1) state.arcDistance = `G${g}`;
      else if (g === 93 || g === 94) { if (state.feedMode !== `G${g}`) state.feed = state.programmedFeed = null; state.feedMode = `G${g}`; }
      else if (WCS.has(g)) selectWcs(`G${g}` as WorkSystem, line);
      else if (g === 98 || g === 99) state.retract = `G${g}`;
    }
    const scale = state.units === 'G20' ? 25.4 : 1;
    if ('F' in words) {
      if (words.F <= 0) stop(line, 'invalid-feed', 'F must be positive.');
      state.programmedFeed = words.F; state.feed = words.F * (state.feedMode === 'G94' ? scale : 1);
    }
    if ('S' in words) { if (words.S < 0) stop(line, 'invalid-speed', 'S must be nonnegative.'); state.spindleSpeed = words.S; }
    for (const letter of ['T', 'H', 'N']) if (letter in words && (!Number.isInteger(words[letter]) || words[letter] < 0)) stop(line, 'invalid-integer', `${letter} must be a nonnegative integer.`);
    if ('T' in words) state.selectedTool = words.T;
    const hasAxis = AXES.some(k => k.toUpperCase() in words);
    const isArc = state.motion === 'G2' || state.motion === 'G3';
    const isCycle = CYCLES.has(Number(state.motion.slice(1)));
    const action = gs.find(g => [4, 28, 30, 92].includes(g));
    const executes = hasAxis || (isArc && ['I', 'J', 'K', 'R'].some(k => k in words)) || (isCycle && (gs.some(g => CYCLES.has(g)) || ['R', 'L', 'P', 'Q'].some(k => k in words)));
    const allowed = new Set(['G', 'M', 'N', 'F', 'S', 'T']);
    if (hasAxis) for (const k of ['X', 'Y', 'Z']) allowed.add(k);
    if (gs.includes(43)) allowed.add('H');
    if (action === 4) allowed.add('P');
    else if (action === undefined && isArc) {
      const [u, v] = planeAxes(state.plane), letters = { x: 'I', y: 'J', z: 'K' };
      for (const k of [letters[u], letters[v], 'R', 'P']) allowed.add(k);
    } else if (action === undefined && isCycle) {
      for (const k of ['R', 'L']) allowed.add(k);
      if (['G73', 'G83'].includes(state.motion)) allowed.add('Q');
      if (['G82', 'G89'].includes(state.motion)) allowed.add('P');
    }
    for (const letter of Object.keys(words)) if (!allowed.has(letter)) stop(line, 'unused-word', `${letter} has no supported meaning on this block.`);
    if (gs.includes(53) && (action !== undefined || !['G0', 'G1'].includes(state.motion))) stop(line, 'invalid-g53', 'G53 requires G0/G1 and cannot share an axis-using nonmodal action.');
    if (action !== undefined && action !== 4 && gs.some(g => [0, 1, 2, 3, 80].includes(g) || CYCLES.has(g))) stop(line, 'axis-command-conflict', 'Axis-using nonmodal action conflicts with explicit motion.');
    if (halted) { state = { ...before, reliable: false }; finish(); continue; }
    if (ms.includes(6)) {
      if (state.selectedTool === null) { stop(line, 'unknown-tool', 'M6 has no selected T.'); finish(); continue; }
      state.tool = state.selectedTool; ensureToolUse(line, true); event(line, 'tool-change', null);
      issue(line, 'untimed-tool-change', 'Operator/ATC tool-change duration is excluded from lower-bound time.');
    }
    if (gs.includes(49)) state.lengthOffset = { mode: 'G49', h: null, value: zero() };
    if (gs.includes(43)) {
      const h = words.H ?? state.tool;
      const value = h === null ? undefined : context.toolLengthOffsets?.[h];
      const vector = typeof value === 'number' ? { x: 0, y: 0, z: value } : value;
      if (vector && !finitePosition(vector)) throw new Error('Tool length offsets must be finite mm');
      state.lengthOffset = { mode: 'G43', h, value: vector ? { ...vector } : unknown() };
      if (!vector) issue(line, 'unknown-length-offset', `G43 H${h ?? '?'} not supplied; affected coordinates are unknown.`);
    }
    for (const m of ms) {
      if (m === 3 || m === 4 || m === 5) state.spindle = `M${m}`;
      else if (m === 7) state.coolant.mist = true;
      else if (m === 8) state.coolant.flood = true;
      else if (m === 9) state.coolant = { mist: false, flood: false };
    }
    inverseFeedOnBlock = 'F' in words;
    if (action === 4) {
      if (!('P' in words) || words.P < 0) stop(line, 'invalid-dwell', 'G4 needs nonnegative P seconds.');
      else event(line, 'dwell', words.P);
      // G4 suspends implicit modal motion, but explicit G0/G1/G2/G3 on the
      // same line executes after the dwell (controller order of execution).
      if (hasAxis) {
        if (gs.some(g => [0, 1, 2, 3].includes(g))) {
          const end = target(words, scale, gs.includes(53));
          const delta = blockDelta(words, scale, end, gs.includes(53));
          if (isArc) { const arc = makeArc(line, words, end, scale); if (arc) emit(line, 'arc', end, state.motion, arc, delta); }
          else emit(line, state.motion === 'G0' ? 'rapid' : 'feed', end, state.motion, undefined, delta);
        } else stop(line, 'ambiguous-dwell-axis', 'G4 with axes but no explicit motion is ambiguous.');
      }
    } else if (action === 92) {
      if (!hasAxis) stop(line, 'missing-g92-axis', 'G92 needs an axis word.');
      else {
        for (const k of AXES) if (k.toUpperCase() in words) state.g92[k] = subtract(subtract(state.position[k], add(state.workOffsetValue[k], state.lengthOffset.value[k])), words[k.toUpperCase()] * scale);
        issue(line, 'g92-applied', 'G92 applied to the coordinate translation; persistent controller G92 state must match before resume.');
      }
    } else if (action === 28 || action === 30) {
      if (hasAxis) { const end = target(words, scale); emit(line, 'rapid', end, `G${action} intermediate`, undefined, blockDelta(words, scale, end)); }
      const stored = action === 28 ? context.g28 : context.g30;
      const end = { ...state.position };
      for (const k of AXES) if (!hasAxis || k.toUpperCase() in words) end[k] = stored?.[k] ?? null;
      if (AXES.some(k => end[k] === null)) issue(line, 'unknown-return-position', `G${action} stored position is missing for at least one axis; not assumed to be work zero.`);
      emit(line, 'rapid', end, `G${action} stored return`, undefined, deltaTo(end, hasAxis ? AXES.filter(k => k.toUpperCase() in words) : AXES));
    } else if (executes) {
      if (state.motion === 'G80') stop(line, 'motion-cancelled', 'Axis words with cancelled motion G80.');
      else if (isCycle) expandCycle(line, words, scale);
      else {
        const end = target(words, scale, gs.includes(53));
        const delta = blockDelta(words, scale, end, gs.includes(53));
        if (isArc) { const arc = makeArc(line, words, end, scale); if (arc) emit(line, 'arc', end, state.motion, arc, delta); }
        else emit(line, state.motion === 'G0' ? 'rapid' : 'feed', end, gs.includes(53) ? `G53 ${state.motion}` : state.motion, undefined, delta);
      }
    }
    if (!halted) for (const m of ms) {
      if (m === 0 || m === 1) { event(line, m === 0 ? 'pause' : 'optional-stop', null); issue(line, 'untimed-stop', `M${m} operator wait excluded from lower-bound time.`); }
      if (m === 2 || m === 30) {
        event(line, 'end', 0); state.programEnd = `M${m}`;
        state.spindle = 'M5'; state.coolant = { mist: false, flood: false };
        state.motion = 'G1'; state.plane = 'G17'; state.distance = 'G90'; state.feedMode = 'G94'; state.cycle = null;
        selectWcs('G54', line);
      }
    }
    finish();
  }
  const lastExecuted = lines.find(l => l.stateAfter.programEnd !== null)?.line ?? lines.length;
  if (currentTool !== null) tools[currentTool].endLine = lastExecuted;
  if (state.operation !== null) operations[state.operation].endLine = lastExecuted;
  if (halted) {
    for (const b of Object.values(bounds.perWorkOffset)) b.complete = false;
    if (currentTool !== null) tools[currentTool].timeComplete = false;
    if (state.operation !== null) operations[state.operation].timeComplete = false;
  }
  return {
    lines, initialState, moves, events, tools, operations, bounds, estimatedSeconds, timeComplete, issues, fileToLoader, loaderToFile,
    stateAfterLine(line: number): ModalState {
      if (!Number.isInteger(line) || line < 0 || line > lines.length) throw new RangeError('Physical file line out of range');
      return clone(line === 0 ? initialState : lines[line - 1].stateAfter);
    },
  };
}

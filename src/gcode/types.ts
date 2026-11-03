/** All coordinates and length offsets are mm; rates are mm/min; times are seconds. */
export type Axis = 'x' | 'y' | 'z';
export type Point = Record<Axis, number>;
/** null means that the controller context or a stored return position is unknown. */
export type Position = Record<Axis, number | null>;
export type WorkSystem = 'G54' | 'G55' | 'G56' | 'G57' | 'G58' | 'G59' | 'G59.1' | 'G59.2' | 'G59.3';
export type Plane = 'G17' | 'G18' | 'G19';
export type CycleCode = 'G73' | 'G81' | 'G82' | 'G83' | 'G85' | 'G89';
export type Motion = 'G0' | 'G1' | 'G2' | 'G3' | 'G80' | CycleCode;

export interface InterpreterContext {
  workOffsets?: Partial<Record<WorkSystem, Point>>;
  activeWorkOffset?: WorkSystem;
  initialPosition?: Position;
  rapidRates?: Partial<Point>;
  g28?: Position;
  g30?: Position;
  /** G43 H table entries, including optional X/Y offsets. A number is a Z offset. */
  toolLengthOffsets?: Record<number, number | Point>;
  initialTool?: number;
  initialG92?: Point;
  /** A tool length offset already in force on the controller (G43.1, $TPW), until the program's G49 or G43. */
  initialLengthOffset?: Point;
  /** The controller's g73_retract setting, in mm. Required for G73. */
  g73RetractMm?: number;
  /** The controller's modes when the program starts ($G). Each one not given is G21, G90, G17, G94, G0. */
  initialModes?: Partial<Pick<ModalState, 'units' | 'distance' | 'plane' | 'feedMode' | 'motion'>>;
  /** Where homing ($H) leaves each axis, in machine coordinates; null where it isn't known. */
  homePosition?: Position;
  /** After M2/M30 grblHAL resets some modes and reads on. 'stop' (the default) reads nothing after it,
   *  for a sender that doesn't send the rest; 'continue' reads on with grblHAL's resets. */
  afterProgramEnd?: 'stop' | 'continue';
  /** Resource guard for erroneous L/Q values; exceeding it stops interpretation. */
  maxExpandedMoves?: number;
}

export interface CycleState {
  code: CycleCode;
  plane: Plane;
  workOffset: WorkSystem;
  distance: 'G90' | 'G91';
  frameOffset: Position;
  /** Resolved machine coordinates, retained when R/depth words are omitted. */
  r: number;
  depth: number;
  q: number | null;
  dwell: number;
}

export interface ModalState {
  motion: Motion;
  plane: Plane;
  units: 'G20' | 'G21';
  distance: 'G90' | 'G91';
  arcDistance: 'G90.1' | 'G91.1';
  feedMode: 'G93' | 'G94';
  workOffset: WorkSystem;
  workOffsetValue: Position;
  tool: number | null;
  selectedTool: number | null;
  lengthOffset: { mode: 'G43' | 'G49'; h: number | null; value: Position };
  g92: Position;
  spindle: 'M3' | 'M4' | 'M5';
  spindleSpeed: number | null;
  coolant: { mist: boolean; flood: boolean };
  /** G94: mm/min; G93: inverse minutes. Also retain the exact last F word. */
  feed: number | null;
  programmedFeed: number | null;
  retract: 'G98' | 'G99';
  position: Position;
  cycle: CycleState | null;
  operation: number | null;
  programEnd: 'M2' | 'M30' | null;
  /** False after an unsupported/invalid block. Not a resume authorization. */
  reliable: boolean;
}

export interface Issue {
  /** 1-based physical file line; 0 denotes missing/assumed input context. */
  line: number;
  code: string;
  message: string;
  severity: 'inference' | 'warning' | 'error';
}

export interface Bounds { min: Position; max: Position; complete: boolean }
export interface Arc {
  centre: Position;
  radius: number;
  direction: 'cw' | 'ccw';
  plane: Plane;
  /** Actual sweep / (2*pi), including partial and extra turns. */
  turns: number;
  programmedTurns: number;
  startAngle: number;
  sweep: number;
}
export interface Move {
  kind: 'rapid' | 'feed' | 'arc';
  line: number;
  loaderLine: number;
  start: Position;
  end: Position;
  /** Known incremental displacement can survive an unknown absolute position. */
  displacement: Position;
  arc?: Arc;
  workOffset: WorkSystem;
  /** Translation in force for this move, including G92 and G43. */
  frameOffset: Position;
  feed: number | null;
  feedMode: 'G93' | 'G94';
  tool: number | null;
  toolUse: number | null;
  operation: number | null;
  length: number | null;
  estimatedSeconds: number | null;
  source: string;
}
export interface ProgramEvent {
  line: number;
  kind: 'dwell' | 'pause' | 'optional-stop' | 'tool-change' | 'end';
  seconds: number | null;
  tool: number | null;
  toolUse: number | null;
  operation: number | null;
}
export interface TimedRange {
  id: number;
  startLine: number;
  endLine: number;
  estimatedSeconds: number;
  timeComplete: boolean;
}
/** One entry per tool-use interval, so repeated uses of the same T stay distinct. */
export interface ToolUse extends TimedRange {
  tool: number | null;
  changeLine: number | null;
  operations: number[];
}
export interface Operation extends TimedRange {
  name: string;
  inferred: boolean;
  tools: number[];
}
export interface SourceLine {
  line: number;
  raw: string;
  code: string;
  loaderLine: number | null;
  stateAfter: ModalState;
  moveRange: [number, number];
}
export interface Program {
  lines: SourceLine[];
  initialState: ModalState;
  moves: Move[];
  events: ProgramEvent[];
  tools: ToolUse[];
  operations: Operation[];
  bounds: { machine: Bounds; work: Bounds; perWorkOffset: Partial<Record<WorkSystem, Bounds>> };
  estimatedSeconds: number;
  timeComplete: boolean;
  issues: Issue[];
  /** Index zero is unused; loader lines count every nonblank line, including comments. */
  fileToLoader: (number | null)[];
  loaderToFile: number[];
  /** Independent snapshots; line 0 is initial state. Out-of-range requests throw. */
  stateAfterLine(line: number): ModalState;
}

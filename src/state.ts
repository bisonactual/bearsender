// ═══════════════════════════════════════════════
// Shared mutable state, for the carried-over screens
// ═══════════════════════════════════════════════
//
// New code reads the signal stores in src/stores instead.

import type { ToolEntry } from './stores/machine';

export const state = {
  // Connection
  ws: null as WebSocket | null,
  serialPort: null as any,
  serialWriter: null as any,
  serialReader: null as any,
  serialAbort: null as AbortController | null,
  connMode: 'websocket' as 'websocket' | 'serial',
  connected: false,

  // Jog
  jogStepXY: 10,
  jogStepZ: 1,
  jogMaxSpeedXY: 3000,
  jogMaxSpeedZ: 500,
  statusInterval: null as ReturnType<typeof setInterval> | null,
  _isJogging: false,
  jogHoldMode: false,
  _jogHoldActive: false,

  // Command history
  cmdHistory: [] as string[],
  histIdx: -1,

  // Machine position
  machineX: 0,
  machineY: 0,
  machineZ: 0,

  // RX buffer tracking
  RX_BUFFER_SIZE: 128,
  rxInFlight: 0,
  sentQueue: [] as { line: string; bytes: number; fileLine?: number }[],  // fileLine: the job line it carries

  // Job
  gcodeLines: [] as string[],
  lineHead: 0,
  running: false,
  paused: false,
  segmentIndex: 0,
  sendLines: [] as { text: string; line: number }[],  // the job as sent: text, and its line in gcodeLines (1-based)
  jobNumbered: false,                                 // lines carry N<line>, so Ln in status reports is a line of the file

  // Receive buffer
  _rxBuf: '',

  // Settings engine
  settingsGroups: {} as Record<number, { id: number; parentId: number; name: string }>,
  settingsDefs: {} as Record<number, any>,
  settingsValues: {} as Record<number, string>,
  settingsDirty: {} as Record<number, string>,
  activeGroupId: null as number | null,
  settingsLoaded: false,
  esPhase: 'idle' as string,
  esPendingOks: 0,
  pendingSettingWrite: null as { id: number; btn: HTMLElement | null } | null,
  controllerAxes: ['X', 'Y', 'Z'] as string[],

  // Toolpath
  toolpathSegments: [] as any[],
  totalMoves: 0,
  totalRapids: 0,

  // Work coordinate offsets ($# table)
  wcsOffsets: {} as Record<string, { x: number; y: number; z: number }>,
  tloOffset: 0 as number,
  tloActive: false as boolean,
  activeWcs: 'G54' as string,
  rulerCoords: 'machine' as string,
  wcsPhase: 'idle' as string,
  currentToolNumber: 0,
  ttPhase: 'idle' as string,
  _ttLines: [] as string[],
  ttEntries: [] as ToolEntry[],

  // Program limits
  progLimits: null as any,
  progLimitsTab: 'overall' as string,

  // Console
  conLines: 0,
  consoleMaxLines: 50,

  // Homing
  machineHomed: false,
  _prevMachineStateSl: '',

  // Overrides
  ovrCurrent: { feed: 100, rapid: 100, spindle: 100 },

  // Camera
  camStream: null as MediaStream | null,
  camActive: false,
  camZoomVal: 1.0,
  camCrossSizeVal: 80,
  camCrossStyle: 'cross',
  camCrossColor: '#00d4ff',
  camOffsetX: 0,
  camOffsetY: 0,
  camCrossX: 0.5,
  camCrossY: 0.5,
  camDragging: false,
  camShiftDrag: false,
  camDragStartCross: { x: 0.5, y: 0.5 },
  camDragStartMouse: { x: 0, y: 0 },
  camMeasuring: false,
  camMeasureStartPos: null as { x: number; y: number } | null,
  _camTabInited: false,
  _probingTabInited: false,

  // Keyboard jog
  kbJogActive: false,
  kbJogKey: null as string | null,

  // Touch keyboard
  kbdBuffer: '',

  // Viewport extents
  vpXMin: -300,
  vpXMax: 0,
  vpYMin: -300,
  vpYMax: 0,
  vpOrtho: false,

  // Coolant
  floodOn: false,
  mistOn: false,

  // Spindle/coolant UI active state
  showToolhead: true,
};

export const POLL_JOG = 50;
export const POLL_NORM = 100;
export const KEYBOARD_JOG_DIST = 100000;
export const VP_STORAGE_KEY = 'fs-viewport-extents';
export const SD_EXTS = new Set(['.nc', '.gcode', '.g', '.ngc', '.tap', '.gc']);

export const KB_JOG_MAP: Record<string, string> = {
  'ArrowLeft': 'X-', 'ArrowRight': 'X+',
  'ArrowDown': 'Y-', 'ArrowUp': 'Y+',
  'PageDown': 'Z-', 'PageUp': 'Z+',
};

export const DTYPE_MAP: Record<string, number> = {
  'bool': 0, 'boolean': 0,
  'bitfield': 1,
  'xbitfield': 2,
  'radiobuttons': 3, 'radio': 3,
  'axismask': 4,
  'integer': 5, 'int': 5,
  'float': 6, 'decimal': 6,
  'string': 7, 'text': 7,
  'password': 8,
  'ipv4': 9,
};

export const SIG_PIN_MAP: Record<string, string> = {
  'X': 'sig-xlim',
  'Y': 'sig-ylim',
  'Z': 'sig-zlim',
  'A': 'sig-alim',
  'B': 'sig-blim',
  'P': 'sig-probe',
  'T': 'sig-toolsetter',
  'D': 'sig-door',
  'R': 'sig-estop',
};

export const OPT_COLOR_DEFAULTS: Record<string, string> = {
  // UI theme
  text:     '#f1f5f9',
  text2:    '#94a3b8',
  bg:       '#0f0e0c',
  surface:  '#1a1814',
  accent:   '#ff8c42',
  // Tab bar
  tabActive: '#ff8c42',
  // Viewport toolpath
  vpCut:      '#00d4ff',
  vpRapid:    '#ff4444',
  vpExecuted: '#00ff88',
  vpTool:     '#ffd740',
};

export const OPT_COLOR_CSS_VARS: Record<string, string> = {
  text:     '--text',
  text2:    '--text2',
  bg:       '--bg',
  surface:  '--surface',
  accent:   '--accent',
  tabActive: '--tab-active',
  vpCut:      '--vp-cut',
  vpRapid:    '--vp-rapid',
  vpExecuted: '--vp-executed',
  vpTool:     '--vp-tool',
};

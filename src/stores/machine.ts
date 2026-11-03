// ═══════════════════════════════════════════════
// Machine store — what the controller reports
// ═══════════════════════════════════════════════

import { signal, computed } from '@preact/signals';

export interface Vec3 { x: number; y: number; z: number; }
export interface ToolEntry { pocket: number; tool: number; x: number | null; y: number | null; z: number | null; d: number | null; name: string; }
export interface Overrides { feed: number; rapid: number; spindle: number; }

/** The state field of the last status report, as sent: Idle, Run, Hold:0, Alarm, Tool, Door:1 ... */
export const state = signal('');
export const mpos = signal<Vec3>({ x: 0, y: 0, z: 0 });
/** The work offset in force (WCO), which includes G92 and the tool length offset. Null until reported. */
export const wco = signal<Vec3 | null>(null);
/** The active work offset (G54 ... G59.3). */
export const wcs = signal('G54');
/** The $# table, read on connect. */
export const offsets = signal<Record<string, Vec3>>({});
export const offsetsRead = signal(false);
/** The $# table as first read after connecting, to tell what was set this session. */
export const offsetsAtConnect = signal<Record<string, Vec3> | null>(null);
/** How each work offset was last written this session: probed (G10 L2, G92) or zeroed (G10 L20). */
export const offsetWrites = signal<Record<string, 'probed' | 'zeroed'>>({});
/** The tool length offset from $# ([TLO:]), null until read. */
export const tlo = signal<number | null>(null);
/** The whole tool length offset vector from [TLO:], null until read. `tlo` is its Z. */
export const tloVector = signal<Vec3 | null>(null);
export const overrides = signal<Overrides>({ feed: 100, rapid: 100, spindle: 100 });
export const feed = signal(0);
export const spindle = signal(0);
/** The planner blocks and input bytes free (Bf:), null until reported. */
export const buffer = signal<{ blocks: number; bytes: number } | null>(null);
/** Spindle and coolant as reported (A:): S clockwise, C counter-clockwise, F flood, M mist. Null until reported. */
export const accessories = signal<string | null>(null);
/** Input pins that are active, as letters (Pn:). */
export const pins = signal('');
/** The code of the last alarm, cleared when the alarm is. */
export const alarm = signal<number | null>(null);
export const homed = signal(false);
/** The tool in the spindle, when the controller reports it. */
export const tool = signal<number | null>(null);
/** The $TTLIST answer. Null until the controller has answered. */
export const toolTable = signal<ToolEntry[] | null>(null);
/** The error $TTLIST got, when the controller has no tool table. */
export const toolTableError = signal<string | null>(null);
/** $ settings values read so far. */
export const settings = signal<Record<number, string>>({});
/** The modal state from the last [GC:] line: G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0. */
export const modal = signal<string[]>([]);

/** The P word that selects each work offset in G10. */
export const WCS_P: Record<string, number> = { G54: 1, G55: 2, G56: 3, G57: 4, G58: 5, G59: 6, 'G59.1': 7, 'G59.2': 8, 'G59.3': 9 };
/** P for the active work offset, for every zero in the app. */
export const activeP = computed(() => WCS_P[wcs.value] ?? 1);

/** idle, run, hold, alarm, tool, door, home, jog, check, sleep, or '' before the first report. */
export const stateName = computed(() => state.value.split(':')[0].toLowerCase());

/** The axes the controller has, from [AXS:] in $I: X, Y, Z, then any of A, B, C, U, V, W. */
export const axes = signal<string[]>(['X', 'Y', 'Z']);
/** The machine position of the axes after Z, in the order of `axes`: degrees for A, B and C, mm for U, V, W. */
export const mposExtra = signal<number[]>([]);
/** WCO for the axes after Z, null until reported. */
export const wcoExtra = signal<number[] | null>(null);

export interface ExtraAxis { letter: string; rotary: boolean; m: number; w: number; }
/** The axes after Z, for the DROs: from $I, or as many as the status report gives if $I named none. */
export const extraAxes = computed<ExtraAxis[]>(() => {
  const letters = axes.value.slice(3), m = mposExtra.value, o = wcoExtra.value ?? [];
  return Array.from({ length: Math.max(letters.length, m.length) }, (_, i) => {
    const letter = letters[i] ?? 'ABCUVW'[i] ?? '?';
    return { letter, rotary: 'ABC'.includes(letter), m: m[i] ?? 0, w: (m[i] ?? 0) - (o[i] ?? 0) };
  });
});

export const wpos = computed<Vec3>(() => {
  const m = mpos.value;
  const o = wco.value ?? offsets.value[wcs.value] ?? { x: 0, y: 0, z: 0 };
  return { x: m.x - o.x, y: m.y - o.y, z: m.z - o.z };
});

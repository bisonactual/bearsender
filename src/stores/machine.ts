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
export const overrides = signal<Overrides>({ feed: 100, rapid: 100, spindle: 100 });
export const feed = signal(0);
export const spindle = signal(0);
/** Input pins that are active, as letters (Pn:). */
export const pins = signal('');
/** The code of the last alarm, cleared when the alarm is. */
export const alarm = signal<number | null>(null);
export const homed = signal(false);
/** The tool in the spindle, when the controller reports it. */
export const tool = signal<number | null>(null);
/** The $TTLIST answer. Null until the controller has answered. */
export const toolTable = signal<ToolEntry[] | null>(null);
/** $ settings values read so far. */
export const settings = signal<Record<number, string>>({});

/** idle, run, hold, alarm, tool, door, home, jog, check, sleep, or '' before the first report. */
export const stateName = computed(() => state.value.split(':')[0].toLowerCase());

export const wpos = computed<Vec3>(() => {
  const m = mpos.value;
  const o = wco.value ?? offsets.value[wcs.value] ?? { x: 0, y: 0, z: 0 };
  return { x: m.x - o.x, y: m.y - o.y, z: m.z - o.z };
});

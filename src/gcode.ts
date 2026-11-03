// Loading G-code files, and the program's extents for the limits card and FRAME (src/frame.ts). What
// the program does comes from the G-code interpreter (src/gcode, through stores/program.ts).

import { effect } from '@preact/signals';
import { log } from './console';
import { onJobFileLoaded } from './flight-recorder';
import type { Bounds } from './gcode/index';
import * as job from './stores/job';
import * as program from './stores/program';

export function processGcode(text: string, name: string): void {
  // CR, LF or CRLF: grblHAL ends a line at either, so a lone CR inside a line would split it there.
  const lines = text.split(/\r\n|\r|\n/).map(l => l.trim()).filter(l => l.length > 0);
  job.loaded(name, lines);
  log('info', 'Loaded: ' + name + ' (' + lines.length + ' lines)');
  onJobFileLoaded(name);
}

/** The work offsets or the tool length changed (offsets.ts): read the program again with them. */
export function refreshLoadedProgramPreview(): void {
  program.reread();
}

// The program's extents

/** The interpreter's bounds as the job store keeps them (job.AxisRange). */
function axisRange(b: Bounds): job.AxisRange {
  const has = (a: 'x' | 'y' | 'z') => b.min[a] !== null;
  return {
    xMin: b.min.x ?? 0, xMax: b.max.x ?? 0, yMin: b.min.y ?? 0, yMax: b.max.y ?? 0, zMin: b.min.z ?? 0, zMax: b.max.z ?? 0,
    hasX: has('x'), hasY: has('y'), hasZ: has('z'),
  };
}

/** The program's own motion (program.ts programExtent): overall in machine coordinates; per work offset in
 *  that offset's coordinates, in the order the program uses them. */
function computeProgramLimits(v: program.ProgramView | null): void {
  if (!v || !v.program.moves.length) { job.limits.value = null; return; }
  const per = v.extent.perWorkOffset;
  const order = Object.keys(per) as (keyof typeof per)[];
  const perWcs: Record<string, job.AxisRange> = {};
  for (const code of order) perWcs[code] = axisRange(per[code]!);
  job.limits.value = { overall: axisRange(v.extent.machine), perWcs, order };
}

effect(() => computeProgramLimits(program.view.value));

export function loadFile(input: HTMLInputElement): void {
  const file = input.files?.[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = e => processGcode(e.target!.result as string, file.name);
  reader.readAsText(file);
}

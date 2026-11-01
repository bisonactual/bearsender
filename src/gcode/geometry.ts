import type { Arc, Axis, Bounds, Move, Plane, Position } from './types';

export const AXES: Axis[] = ['x', 'y', 'z'];
export const TAU = Math.PI * 2;
export const zero = (): Position => ({ x: 0, y: 0, z: 0 });
export const unknown = (): Position => ({ x: null, y: null, z: null });
export const add = (a: number | null, b: number | null): number | null => a === null || b === null ? null : a + b;
export const subtract = (a: number | null, b: number | null): number | null => a === null || b === null ? null : a - b;
export function planeAxes(plane: Plane): [Axis, Axis, Axis] {
  return plane === 'G17' ? ['x', 'y', 'z'] : plane === 'G18' ? ['z', 'x', 'y'] : ['y', 'z', 'x'];
}
export function distance(a: Position, b: Position): number | null {
  const delta = AXES.map(k => subtract(b[k], a[k]));
  return delta.some(v => v === null) ? null : Math.hypot(...delta as number[]);
}
export const emptyBounds = (): Bounds => ({ min: unknown(), max: unknown(), complete: true });
export function includePoint(bounds: Bounds, p: Position): void {
  for (const k of AXES) {
    const v = p[k];
    if (v === null) { bounds.complete = false; continue; }
    bounds.min[k] = bounds.min[k] === null ? v : Math.min(bounds.min[k]!, v);
    bounds.max[k] = bounds.max[k] === null ? v : Math.max(bounds.max[k]!, v);
  }
}
export function arcPoint(start: Position, end: Position, arc: Arc, t: number): Position {
  if (t <= 0) return { ...start };
  if (t >= 1) return { ...end };
  const [u, v, w] = planeAxes(arc.plane);
  const angle = arc.startAngle + arc.sweep * t;
  return {
    [u]: add(arc.centre[u], arc.radius * Math.cos(angle)),
    [v]: add(arc.centre[v], arc.radius * Math.sin(angle)),
    [w]: start[w] === null || end[w] === null ? null : start[w]! + (end[w]! - start[w]!) * t,
  } as Position;
}
export function signedSweep(start: number, end: number, clockwise: boolean): number {
  const delta = ((clockwise ? start - end : end - start) % TAU + TAU) % TAU;
  return (clockwise ? -1 : 1) * (delta < 1e-10 ? TAU : delta);
}
/** Analytic quadrant extrema; sampling is used only for display, never for bounds. */
export function moveExtrema(move: Move): Position[] {
  const points = [{ ...move.start }, { ...move.end }];
  const arc = move.arc;
  if (!arc) return points;
  for (const angle of [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2]) {
    const advance = ((Math.sign(arc.sweep) * (angle - arc.startAngle)) % TAU + TAU) % TAU;
    if (advance <= Math.abs(arc.sweep) + 1e-10) {
      points.push(arcPoint(move.start, move.end, arc, advance / Math.abs(arc.sweep)));
    }
  }
  return points;
}
export function sampleMove(move: Move, maxAngle = Math.PI / 90): Position[] {
  if (!move.arc) return [{ ...move.start }, { ...move.end }];
  const count = Math.min(100000, Math.max(2, Math.ceil(Math.abs(move.arc.sweep) / maxAngle)));
  return Array.from({ length: count + 1 }, (_, n) => arcPoint(move.start, move.end, move.arc!, n / count));
}

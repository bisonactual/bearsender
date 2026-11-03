// Surfacing: the G-code that planes a surface (fly-cutting), and its preview waypoints.

import { lsGet, lsSet } from './ui';
import * as machine from './stores/machine';

const SAVE_KEY = 'fs-tool-surfacing';

export interface SurfacingConfig {
  xSize: number; ySize: number;
  targetDepth: number; depthPerPass: number;
  stepoverPct: number; bitDiameter: number;
  feedRate: number; plungeRate: number;
  spindleRpm: number; spindleDelay: number;
  overrun: number;
  pattern: 'zigzagX' | 'zigzagY' | 'spiral';
  origin: 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right' | 'center';
  startPos: 'current' | 'G54' | 'G55' | 'G56' | 'G57' | 'G58' | 'G59';
}

export const DEFAULTS: SurfacingConfig = {
  xSize: 100, ySize: 100,
  targetDepth: 0.5, depthPerPass: 0.5,
  stepoverPct: 80, bitDiameter: 25.4,
  feedRate: 2000, plungeRate: 200,
  spindleRpm: 15000, spindleDelay: 5,
  overrun: 5,
  pattern: 'zigzagY',
  origin: 'bottom-left',
  startPos: 'current',
};

export function loadSurfacingConfig(): SurfacingConfig { return { ...DEFAULTS, ...lsGet(SAVE_KEY, {}) }; }
export function saveSurfacingConfig(c: SurfacingConfig): void { lsSet(SAVE_KEY, c); }

export interface Waypoint { x: number; y: number; z: number; type: string; label: string; }

export function generateWaypoints(cfg: SurfacingConfig): Waypoint[] {
  const { xSize, ySize, targetDepth, depthPerPass, stepoverPct, bitDiameter, overrun, pattern, origin } = cfg;
  const stepover = (bitDiameter * stepoverPct) / 100;
  const numDepthPasses = Math.ceil(targetDepth / depthPerPass);
  const isZigzagX = pattern === 'zigzagX';
  const isSpiral = pattern === 'spiral';

  // Where the origin corner puts the area
  let startX = 0, startY = 0;
  if (origin === 'bottom-right') startX = -xSize;
  else if (origin === 'top-left') startY = -ySize;
  else if (origin === 'top-right') { startX = -xSize; startY = -ySize; }
  else if (origin === 'center') { startX = -xSize / 2; startY = -ySize / 2; }

  // Measured from the chosen work offset's zero
  const startOffset = resolveStartOffset(cfg);
  startX += startOffset.x;
  startY += startOffset.y;

  const areaX = startX - overrun, areaY = startY - overrun;
  const areaW = xSize + overrun * 2, areaH = ySize + overrun * 2;
  const waypoints: Waypoint[] = [{ x: areaX, y: areaY, z: 0, type: 'start', label: 'Start' }];

  let currentDepth = 0;
  for (let depthPass = 0; depthPass < numDepthPasses; depthPass++) {
    currentDepth = Math.min(currentDepth + depthPerPass, targetDepth);
    const z = -currentDepth;
    waypoints.push({ x: areaX, y: areaY, z: 0, type: 'rapid', label: `Move to start` });
    waypoints.push({ x: areaX, y: areaY, z, type: 'probe', label: `Pass ${depthPass + 1} Z${z.toFixed(2)}` });

    if (isSpiral) {
      let left = areaX, right = areaX + areaW, top = areaY, bottom = areaY + areaH;
      const step = Math.max(stepover, 0.1);
      while (right - left > 0 && bottom - top > 0) {
        waypoints.push({ x: right, y: top, z, type: 'probe', label: 'Spiral cut' });
        top += step; if (top >= bottom) break;
        waypoints.push({ x: right, y: bottom, z, type: 'probe', label: 'Spiral cut' });
        right -= step; if (left >= right) break;
        waypoints.push({ x: left, y: bottom, z, type: 'probe', label: 'Spiral cut' });
        bottom -= step; if (top >= bottom) break;
        waypoints.push({ x: left, y: top, z, type: 'probe', label: 'Spiral cut' });
        left += step; if (left >= right) break;
      }
    } else {
      const stepDim = isZigzagX ? areaW : areaH;
      const numPasses = Math.ceil(stepDim / stepover) + 1;
      let dir = 1;
      for (let p = 0; p < numPasses; p++) {
        if (isZigzagX) {
          const yp = areaY + p * stepover;
          waypoints.push({ x: dir === 1 ? areaX + areaW : areaX, y: yp, z, type: 'probe', label: `Row ${p + 1}` });
        } else {
          const xp = areaX + p * stepover;
          waypoints.push({ x: xp, y: dir === 1 ? areaY + areaH : areaY, z, type: 'probe', label: `Col ${p + 1}` });
        }
        dir *= -1;
      }
    }
    waypoints.push({ x: waypoints[waypoints.length - 1].x, y: waypoints[waypoints.length - 1].y, z: 0, type: 'retract', label: 'Retract' });
  }
  return waypoints;
}

/** How far the chosen work offset's zero is from the machine now, in X and Y (0 for "current"). */
function resolveStartOffset(cfg: SurfacingConfig): { x: number; y: number } {
  if (cfg.startPos === 'current') return { x: 0, y: 0 };
  const wcs = machine.offsets.value[cfg.startPos];
  if (!wcs) return { x: 0, y: 0 };
  const m = machine.mpos.value;
  return { x: wcs.x - m.x, y: wcs.y - m.y };
}

export function generateGcode(cfg: SurfacingConfig): string {
  const { xSize, ySize, targetDepth, depthPerPass, stepoverPct, bitDiameter,
          feedRate, plungeRate, spindleRpm, spindleDelay, overrun, pattern, origin } = cfg;

  const stepover = (bitDiameter * stepoverPct) / 100;
  const numDepthPasses = Math.ceil(targetDepth / depthPerPass);
  const isZigzagX = pattern === 'zigzagX';
  const isSpiral = pattern === 'spiral';

  // Where the origin corner puts the area
  let startX = 0, startY = 0;
  if (origin === 'bottom-right') startX = -xSize;
  else if (origin === 'top-left') startY = -ySize;
  else if (origin === 'top-right') { startX = -xSize; startY = -ySize; }
  else if (origin === 'center') { startX = -xSize / 2; startY = -ySize / 2; }

  const areaX = startX - overrun;
  const areaY = startY - overrun;
  const areaW = xSize + overrun * 2;
  const areaH = ySize + overrun * 2;

  const lines: string[] = [];
  lines.push('(Surfacing Operation)');
  lines.push(`(Area: ${xSize} x ${ySize} mm, Depth: ${targetDepth} mm in ${numDepthPasses} passes)`);
  lines.push(`(Bit: ${bitDiameter} mm, Stepover: ${stepoverPct}%, Overrun: ${overrun} mm)`);
  lines.push(`(Feed: ${feedRate} mm/min, Plunge: ${plungeRate} mm/min, RPM: ${spindleRpm})`);
  lines.push('');
  lines.push('G21 ; Metric');
  lines.push('G90 ; Absolute');
  lines.push('G94 ; Feed/min');
  if (cfg.startPos !== 'current') {
    lines.push(`${cfg.startPos} ; Select WCS`);
  }
  lines.push('');
  lines.push('G53 G0 Z0');
  lines.push(`G0 X${areaX.toFixed(3)} Y${areaY.toFixed(3)}`);
  if (spindleRpm > 0) lines.push(`M3 S${spindleRpm}`);
  if (spindleDelay > 0) lines.push(`G4 P${spindleDelay}`);
  lines.push('G0 Z5.000');
  lines.push('');

  let currentDepth = 0;
  for (let depthPass = 0; depthPass < numDepthPasses; depthPass++) {
    currentDepth = Math.min(currentDepth + depthPerPass, targetDepth);
    const z = -currentDepth;
    lines.push(`(Pass ${depthPass + 1}/${numDepthPasses} Z${z.toFixed(3)})`);
    lines.push(`G0 X${areaX.toFixed(3)} Y${areaY.toFixed(3)}`);
    lines.push(`G1 Z${z.toFixed(3)} F${plungeRate}`);

    if (isSpiral) {
      let left = areaX, right = areaX + areaW, top = areaY, bottom = areaY + areaH;
      const step = Math.max(stepover, 0.1);
      while (right - left > 0 && bottom - top > 0) {
        lines.push(`G1 X${right.toFixed(3)} Y${top.toFixed(3)} F${feedRate}`);
        top += step; if (top >= bottom) break;
        lines.push(`G1 X${right.toFixed(3)} Y${bottom.toFixed(3)} F${feedRate}`);
        right -= step; if (left >= right) break;
        lines.push(`G1 X${left.toFixed(3)} Y${bottom.toFixed(3)} F${feedRate}`);
        bottom -= step; if (top >= bottom) break;
        lines.push(`G1 X${left.toFixed(3)} Y${top.toFixed(3)} F${feedRate}`);
        left += step; if (left >= right) break;
        lines.push(`G1 X${left.toFixed(3)} Y${top.toFixed(3)} F${feedRate}`);
      }
    } else {
      const stepDim = isZigzagX ? areaW : areaH;
      const numPasses = Math.ceil(stepDim / stepover) + 1;
      let dir = 1;
      for (let p = 0; p < numPasses; p++) {
        if (isZigzagX) {
          const yp = areaY + p * stepover;
          if (p > 0) lines.push(`G1 Y${yp.toFixed(3)} F${feedRate}`);
          lines.push(`G1 X${(dir === 1 ? areaX + areaW : areaX).toFixed(3)} F${feedRate}`);
        } else {
          const xp = areaX + p * stepover;
          if (p > 0) lines.push(`G1 X${xp.toFixed(3)} F${feedRate}`);
          lines.push(`G1 Y${(dir === 1 ? areaY + areaH : areaY).toFixed(3)} F${feedRate}`);
        }
        dir *= -1;
      }
    }
    lines.push('G0 Z5.000');
    lines.push('');
  }

  lines.push('G53 G0 Z0');
  if (spindleRpm > 0) lines.push('M5');
  lines.push('M30');
  return lines.join('\n');
}

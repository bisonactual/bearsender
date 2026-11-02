// ═══════════════════════════════════════════════
// Surfacing (Planer) — G-code for fly-cutting / surface planing, and its preview waypoints
// ═══════════════════════════════════════════════

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

export function loadCfg(): SurfacingConfig { return { ...DEFAULTS, ...lsGet(SAVE_KEY, {}) }; }
export function saveCfg(c: SurfacingConfig): void { lsSet(SAVE_KEY, c); }

export interface Waypoint { x: number; y: number; z: number; type: string; label: string; }

export function generateWaypoints(cfg: SurfacingConfig): Waypoint[] {
  const { xSize, ySize, targetDepth, depthPerPass, stepoverPct, bitDiameter, overrun, pattern, origin } = cfg;
  const stepover = (bitDiameter * stepoverPct) / 100;
  const numDepthPasses = Math.ceil(targetDepth / depthPerPass);
  const isZigzagX = pattern === 'zigzagX';
  const isSpiral = pattern === 'spiral';

  // Origin corner offset
  let startX = 0, startY = 0;
  if (origin === 'bottom-right') startX = -xSize;
  else if (origin === 'top-left') startY = -ySize;
  else if (origin === 'top-right') { startX = -xSize; startY = -ySize; }
  else if (origin === 'center') { startX = -xSize / 2; startY = -ySize / 2; }

  // WCS offset — shift everything to the selected WCS zero
  const sp = resolveStartOffset(cfg);
  startX += sp.x;
  startY += sp.y;

  const ax = startX - overrun, ay = startY - overrun;
  const aw = xSize + overrun * 2, ah = ySize + overrun * 2;
  const wps: Waypoint[] = [{ x: ax, y: ay, z: 0, type: 'start', label: 'Start' }];

  let currentDepth = 0;
  for (let dp = 0; dp < numDepthPasses; dp++) {
    currentDepth = Math.min(currentDepth + depthPerPass, targetDepth);
    const z = -currentDepth;
    wps.push({ x: ax, y: ay, z: 0, type: 'rapid', label: `Move to start` });
    wps.push({ x: ax, y: ay, z, type: 'probe', label: `Pass ${dp + 1} Z${z.toFixed(2)}` });

    if (isSpiral) {
      let left = ax, right = ax + aw, top = ay, bottom = ay + ah;
      const step = Math.max(stepover, 0.1);
      while (right - left > 0 && bottom - top > 0) {
        wps.push({ x: right, y: top, z, type: 'probe', label: 'Spiral cut' });
        top += step; if (top >= bottom) break;
        wps.push({ x: right, y: bottom, z, type: 'probe', label: 'Spiral cut' });
        right -= step; if (left >= right) break;
        wps.push({ x: left, y: bottom, z, type: 'probe', label: 'Spiral cut' });
        bottom -= step; if (top >= bottom) break;
        wps.push({ x: left, y: top, z, type: 'probe', label: 'Spiral cut' });
        left += step; if (left >= right) break;
      }
    } else {
      const stepDim = isZigzagX ? aw : ah;
      const numPasses = Math.ceil(stepDim / stepover) + 1;
      let dir = 1;
      for (let p = 0; p < numPasses; p++) {
        if (isZigzagX) {
          const yp = ay + p * stepover;
          wps.push({ x: dir === 1 ? ax + aw : ax, y: yp, z, type: 'probe', label: `Row ${p + 1}` });
        } else {
          const xp = ax + p * stepover;
          wps.push({ x: xp, y: dir === 1 ? ay + ah : ay, z, type: 'probe', label: `Col ${p + 1}` });
        }
        dir *= -1;
      }
    }
    wps.push({ x: wps[wps.length - 1].x, y: wps[wps.length - 1].y, z: 0, type: 'retract', label: 'Retract' });
  }
  return wps;
}

/** Resolve the start position offset based on config */
function resolveStartOffset(cfg: SurfacingConfig): { x: number; y: number } {
  if (cfg.startPos === 'current') return { x: 0, y: 0 };
  const wcs = machine.offsets.value[cfg.startPos];
  if (!wcs) return { x: 0, y: 0 };
  // WCS offset is where zero is in machine coords — we want to position relative to it
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

  // Origin offset
  let startX = 0, startY = 0;
  if (origin === 'bottom-right') startX = -xSize;
  else if (origin === 'top-left') startY = -ySize;
  else if (origin === 'top-right') { startX = -xSize; startY = -ySize; }
  else if (origin === 'center') { startX = -xSize / 2; startY = -ySize / 2; }

  const ax = startX - overrun;
  const ay = startY - overrun;
  const aw = xSize + overrun * 2;
  const ah = ySize + overrun * 2;

  const g: string[] = [];
  g.push('(Surfacing Operation)');
  g.push(`(Area: ${xSize} x ${ySize} mm, Depth: ${targetDepth} mm in ${numDepthPasses} passes)`);
  g.push(`(Bit: ${bitDiameter} mm, Stepover: ${stepoverPct}%, Overrun: ${overrun} mm)`);
  g.push(`(Feed: ${feedRate} mm/min, Plunge: ${plungeRate} mm/min, RPM: ${spindleRpm})`);
  g.push('');
  g.push('G21 ; Metric');
  g.push('G90 ; Absolute');
  g.push('G94 ; Feed/min');
  if (cfg.startPos !== 'current') {
    g.push(`${cfg.startPos} ; Select WCS`);
  }
  g.push('');
  g.push('G53 G0 Z0');
  g.push(`G0 X${ax.toFixed(3)} Y${ay.toFixed(3)}`);
  if (spindleRpm > 0) g.push(`M3 S${spindleRpm}`);
  if (spindleDelay > 0) g.push(`G4 P${spindleDelay}`);
  g.push('G0 Z5.000');
  g.push('');

  let currentDepth = 0;
  for (let dp = 0; dp < numDepthPasses; dp++) {
    currentDepth = Math.min(currentDepth + depthPerPass, targetDepth);
    const z = -currentDepth;
    g.push(`(Pass ${dp + 1}/${numDepthPasses} Z${z.toFixed(3)})`);
    g.push(`G0 X${ax.toFixed(3)} Y${ay.toFixed(3)}`);
    g.push(`G1 Z${z.toFixed(3)} F${plungeRate}`);

    if (isSpiral) {
      let left = ax, right = ax + aw, top = ay, bottom = ay + ah;
      const step = Math.max(stepover, 0.1);
      while (right - left > 0 && bottom - top > 0) {
        g.push(`G1 X${right.toFixed(3)} Y${top.toFixed(3)} F${feedRate}`);
        top += step; if (top >= bottom) break;
        g.push(`G1 X${right.toFixed(3)} Y${bottom.toFixed(3)} F${feedRate}`);
        right -= step; if (left >= right) break;
        g.push(`G1 X${left.toFixed(3)} Y${bottom.toFixed(3)} F${feedRate}`);
        bottom -= step; if (top >= bottom) break;
        g.push(`G1 X${left.toFixed(3)} Y${top.toFixed(3)} F${feedRate}`);
        left += step; if (left >= right) break;
        g.push(`G1 X${left.toFixed(3)} Y${top.toFixed(3)} F${feedRate}`);
      }
    } else {
      const stepDim = isZigzagX ? aw : ah;
      const numPasses = Math.ceil(stepDim / stepover) + 1;
      let dir = 1;
      for (let p = 0; p < numPasses; p++) {
        if (isZigzagX) {
          const yp = ay + p * stepover;
          if (p > 0) g.push(`G1 Y${yp.toFixed(3)} F${feedRate}`);
          g.push(`G1 X${(dir === 1 ? ax + aw : ax).toFixed(3)} F${feedRate}`);
        } else {
          const xp = ax + p * stepover;
          if (p > 0) g.push(`G1 X${xp.toFixed(3)} F${feedRate}`);
          g.push(`G1 Y${(dir === 1 ? ay + ah : ay).toFixed(3)} F${feedRate}`);
        }
        dir *= -1;
      }
    }
    g.push('G0 Z5.000');
    g.push('');
  }

  g.push('G53 G0 Z0');
  if (spindleRpm > 0) g.push('M5');
  g.push('M30');
  return g.join('\n');
}

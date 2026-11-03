// ═══════════════════════════════════════════════
// Options — colours, jog steps, zone colours, kept in this browser
// ═══════════════════════════════════════════════
//
// Shown in Settings, Options (src/app/OptionsTab.tsx). The connection lives in stores/connection.ts,
// the job options in stores/options.ts, the 3D view's extents in viewport.ts.

import { signal, effect } from '@preact/signals';
import { OPT_COLOR_DEFAULTS, OPT_COLOR_CSS_VARS } from './state';
import { lsGet, lsSet } from './ui';
import { rebuildSteps, setMaxSpeeds } from './jog';
import { vpRefreshColors } from './viewport';

// ── Auto-load settings ────────────────────────────────────────────────────────
/** Read the controller's settings on connecting (connection.ts reads the stored value). */
export const autoloadSettings = signal(lsGet('fs-opt-autoload-settings', false));
effect(() => lsSet('fs-opt-autoload-settings', autoloadSettings.value));

// ── Colours ───────────────────────────────────────────────────────────────────
export const COLOR_ROWS: [string, string][] = [
  ['text', 'Primary Text'], ['text2', 'Secondary Text'], ['bg', 'Background'], ['surface', 'Surface'],
  ['accent', 'Accent'], ['tabActive', 'Active Tab'],
];
export const VP_COLOR_ROWS: [string, string][] = [
  ['vpCut', 'Cut Moves'], ['vpRapid', 'Rapid Moves'], ['vpExecuted', 'Executed Path'], ['vpTool', 'Tool Marker'],
];

export const colors = signal<Record<string, string>>({ ...OPT_COLOR_DEFAULTS, ...lsGet<Record<string, string>>('fs-opt-colors', {}) });

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Sets a theme colour: the page's CSS variable at once, and kept. */
export function optApplyColor(key: string, hex: string): void {
  if (!HEX.test(hex) || !(key in OPT_COLOR_DEFAULTS)) return;
  colors.value = { ...colors.value, [key]: hex };
  document.documentElement.style.setProperty(OPT_COLOR_CSS_VARS[key], hex);
  if (key.startsWith('vp')) vpRefreshColors();
  lsSet('fs-opt-colors', colors.value);
}

export function optResetColor(key: string): void { optApplyColor(key, OPT_COLOR_DEFAULTS[key]); }

export function optResetAllColors(): void { Object.keys(OPT_COLOR_DEFAULTS).forEach(k => optResetColor(k)); }

/** At start-up: the kept theme onto the page. */
export function optLoadColors(): void {
  for (const k of Object.keys(OPT_COLOR_DEFAULTS)) document.documentElement.style.setProperty(OPT_COLOR_CSS_VARS[k], colors.value[k]);
}

// ── Jog step sizes & max speeds ───────────────────────────────────────────────
/** As typed: comma-separated mm, and the speed caps in mm/min. Kept as typed; APPLY puts them in use. */
export const jogSteps = signal({
  xy: '0.01, 0.1, 1, 10, 50', z: '0.01, 0.1, 1, 5, 10', maxXY: '3000', maxZ: '500',
  ...lsGet<Partial<{ xy: string; z: string; maxXY: string; maxZ: string }>>('fs-opt-jogsteps', {}),
});
effect(() => lsSet('fs-opt-jogsteps', jogSteps.value));

function parseSteps(raw: string): number[] {
  return raw.split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n) && n > 0);
}

/** Puts the typed steps and speed caps in use. False if a list has no valid step. */
export function optApplyJogSteps(): boolean {
  const s = jogSteps.value;
  const xySteps = parseSteps(s.xy), zSteps = parseSteps(s.z);
  if (xySteps.length === 0 || zSteps.length === 0) return false;
  setMaxSpeeds(parseInt(s.maxXY) || 3000, parseInt(s.maxZ) || 500);
  rebuildSteps(xySteps, zSteps);
  return true;
}

/** "Show mm units on distance buttons". */
export const jogShowUnits = signal(lsGet<boolean>('fs-opt-jog-show-units', false));
effect(() => {
  document.body.classList.toggle('jog-show-units', jogShowUnits.value);
  lsSet('fs-opt-jog-show-units', jogShowUnits.value);
});

// ── Exclusion zone colours ─────────────────────────────────────────────────────
export const ZONE_COLOR_ROWS: [string, string][] = [
  ['optBearColorAll', 'Blocks All'], ['optBearColorGcode', 'Blocks G-code'], ['optBearColorJog', 'Blocks Jog'],
  ['optBearColorTool', 'Blocks Tool Chg'], ['optBearColorSafe', 'Allows All'],
];
const ZONE_DEFAULTS: Record<string, string> = {
  optBearColorAll: '#ff2222', optBearColorGcode: '#ff6600', optBearColorJog: '#ffcc00', optBearColorTool: '#cc44ff',
  optBearColorSafe: '#22cc66',
};
/** The colours by what a zone blocks, under the old field names. */
export const zoneColors = signal<Record<string, string>>({ ...ZONE_DEFAULTS, ...lsGet<Record<string, string>>('fs-opt-bearcolors', {}) });
effect(() => lsSet('fs-opt-bearcolors', zoneColors.value));

export function optGetBearColor(flags: number): string {
  const c = zoneColors.value;
  const en = !!(flags & 8);
  if (!en) return '#444444';
  const blocksGcode = !(flags & 1), blocksJog = !(flags & 2), blocksTool = !(flags & 4);
  if (!blocksGcode && !blocksJog && !blocksTool) return c.optBearColorSafe;
  if (blocksGcode && blocksJog && blocksTool) return c.optBearColorAll;
  if (blocksGcode) return c.optBearColorGcode;
  if (blocksJog) return c.optBearColorJog;
  if (blocksTool) return c.optBearColorTool;
  return c.optBearColorAll;
}

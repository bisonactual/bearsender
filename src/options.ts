// ═══════════════════════════════════════════════
// Options — colours, fonts, jog steps, zone colours, kept in this browser
// ═══════════════════════════════════════════════
//
// Shown in Settings, Options (src/app/OptionsTab.tsx). The connection lives in stores/connection.ts,
// the job options in stores/options.ts, the 3D view's extents in viewport.ts.

import { signal, effect } from '@preact/signals';
import { lsGet, lsSet } from './ui';
import { rebuildSteps, setMaxSpeeds } from './jog';
import { vpRefreshColors } from './viewport';

// ── Auto-load settings ────────────────────────────────────────────────────────
/** Read the controller's settings on connecting (connection.ts reads the stored value). */
export const autoloadSettings = signal(lsGet('fs-opt-autoload-settings', false));
effect(() => lsSet('fs-opt-autoload-settings', autoloadSettings.value));

// ── Colours ───────────────────────────────────────────────────────────────────
/** The theme's colours, and the CSS variable each sets. */
const OPT_COLOR_DEFAULTS: Record<string, string> = {
  text: '#f1f5f9', text2: '#94a3b8', bg: '#0f0e0c', surface: '#1a1814', accent: '#ff8c42', tabActive: '#ff8c42',
  vpCut: '#00d4ff', vpRapid: '#ff4444', vpExecuted: '#00ff88', vpTool: '#ffd740',
};
const OPT_COLOR_CSS_VARS: Record<string, string> = {
  text: '--text', text2: '--text2', bg: '--bg', surface: '--surface', accent: '--accent', tabActive: '--tab-active',
  vpCut: '--vp-cut', vpRapid: '--vp-rapid', vpExecuted: '--vp-executed', vpTool: '--vp-tool',
};

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

// ── Fonts ─────────────────────────────────────────────────────────────────────
// All bundled in the page (fonts/, inlined by build.ts), so they look the same with no internet. The text
// font brings its condensed cut for the labels; the numbers font is for the position, offsets and tables.

const SYSTEM_SANS = "system-ui, -apple-system, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";

/** The text fonts: the name shown, and the stacks for text (--sans) and labels (--cond). */
export const TEXT_FONTS: Record<string, { name: string; sans: string; cond: string }> = {
  barlow: { name: 'BARLOW', sans: "'Barlow', sans-serif", cond: "'Barlow Condensed', sans-serif" },
  plex: { name: 'IBM PLEX', sans: "'IBM Plex Sans', sans-serif", cond: "'IBM Plex Sans Condensed', sans-serif" },
  roboto: { name: 'ROBOTO', sans: "'Roboto', sans-serif", cond: "'Roboto Condensed', sans-serif" },
  system: { name: 'SYSTEM', sans: SYSTEM_SANS, cond: SYSTEM_SANS },
};
/** The numbers fonts (--mono). */
export const NUMBER_FONTS: Record<string, { name: string; mono: string }> = {
  'share-tech': { name: 'SHARE TECH MONO', mono: "'Share Tech Mono', monospace" },
  'plex-mono': { name: 'IBM PLEX MONO', mono: "'IBM Plex Mono', monospace" },
  'roboto-mono': { name: 'ROBOTO MONO', mono: "'Roboto Mono', monospace" },
  system: { name: 'SYSTEM', mono: "ui-monospace, 'Cascadia Mono', Consolas, Menlo, monospace" },
};

function keptChoice(key: string, choices: Record<string, unknown>, fallback: string): string {
  const v = lsGet<string>(key, fallback);
  return v in choices ? v : fallback;
}

export const textFont = signal(keptChoice('fs-opt-font-text', TEXT_FONTS, 'barlow'));
export const numberFont = signal(keptChoice('fs-opt-font-numbers', NUMBER_FONTS, 'share-tech'));

effect(() => {
  const t = TEXT_FONTS[textFont.value], n = NUMBER_FONTS[numberFont.value];
  const root = document.documentElement.style;
  root.setProperty('--sans', t.sans);
  root.setProperty('--cond', t.cond);
  root.setProperty('--mono', n.mono);
  lsSet('fs-opt-font-text', textFont.value);
  lsSet('fs-opt-font-numbers', numberFont.value);
});

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

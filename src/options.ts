// ═══════════════════════════════════════════════
// Options — connection, colours, jog steps, zone colours, jobs and the resume
// ═══════════════════════════════════════════════

import * as jobOptions from './stores/options';
import { state, OPT_COLOR_DEFAULTS, OPT_COLOR_CSS_VARS } from './state';
import { lsGet, lsSet } from './ui';
import { log } from './console';
import { rebuildSteps, setMaxSpeeds } from './jog';
import { vpRefreshColors } from './viewport';

// ── Connection mode ───────────────────────────────────────────────────────────
export function optSetConnMode(mode: 'websocket' | 'serial'): void {
  if (state.connected) { log('err', 'Disconnect before changing connection type'); return; }
  state.connMode = mode;
  document.body.classList.toggle('conn-serial', mode === 'serial');
  document.body.classList.toggle('conn-websocket', mode === 'websocket');
  document.getElementById('connBtnWs')!.classList.toggle('active', mode === 'websocket');
  document.getElementById('connBtnSerial')!.classList.toggle('active', mode === 'serial');
  document.getElementById('optWsSection')!.style.display = mode === 'websocket' ? '' : 'none';
  document.getElementById('optSerialSection')!.style.display = mode === 'serial' ? '' : 'none';
  document.body.classList.toggle('serial-unsupported', mode === 'serial' && !(navigator as any).serial);
  optSaveConnSettings();
}

export function optSaveConnSettings(): void {
  lsSet('fs-opt-conn', {
    mode: state.connMode,
    wsUrl: (document.getElementById('wsUrl') as HTMLInputElement).value,
    baud: (document.getElementById('optBaudRate') as HTMLSelectElement).value,
    dataBits: (document.getElementById('optDataBits') as HTMLSelectElement).value,
    stopBits: (document.getElementById('optStopBits') as HTMLSelectElement).value,
    parity: (document.getElementById('optParity') as HTMLSelectElement).value,
  });
}

export function optLoadConnSettings(): void {
  try {
    const s = lsGet('fs-opt-conn', {} as any);
    if (s.wsUrl) (document.getElementById('wsUrl') as HTMLInputElement).value = s.wsUrl;
    if (s.baud) (document.getElementById('optBaudRate') as HTMLSelectElement).value = s.baud;
    if (s.dataBits) (document.getElementById('optDataBits') as HTMLSelectElement).value = s.dataBits;
    if (s.stopBits) (document.getElementById('optStopBits') as HTMLSelectElement).value = s.stopBits;
    if (s.parity) (document.getElementById('optParity') as HTMLSelectElement).value = s.parity;
    optSetConnMode(s.mode || 'websocket');
  } catch (_) {
    optSetConnMode('websocket');
  }
}

// ── Colours ───────────────────────────────────────────────────────────────────
function capKey(key: string): string { return key.charAt(0).toUpperCase() + key.slice(1); }

export function optApplyColor(key: string, hex: string): void {
  document.documentElement.style.setProperty(OPT_COLOR_CSS_VARS[key], hex);
  const swatch = document.getElementById('optSwatch' + capKey(key));
  if (swatch) (swatch as HTMLElement).style.background = hex;
  const hexInput = document.getElementById('optHex' + capKey(key)) as HTMLInputElement | null;
  if (hexInput && hexInput !== document.activeElement) hexInput.value = hex;
  if (key.startsWith('vp')) vpRefreshColors();
  optSaveColors();
}

export function optHexChange(key: string, val: string): void {
  if (!/^#[0-9a-fA-F]{6}$/.test(val)) return;
  const picker = document.getElementById('optColor' + capKey(key)) as HTMLInputElement | null;
  if (picker) picker.value = val;
  optApplyColor(key, val);
}

export function optResetColor(key: string): void {
  const def = OPT_COLOR_DEFAULTS[key];
  const ck = capKey(key);
  const picker = document.getElementById('optColor' + ck) as HTMLInputElement | null;
  const hexInp = document.getElementById('optHex' + ck) as HTMLInputElement | null;
  if (picker) picker.value = def;
  if (hexInp) hexInp.value = def;
  optApplyColor(key, def);
}

export function optResetAllColors(): void {
  Object.keys(OPT_COLOR_DEFAULTS).forEach(k => optResetColor(k));
}

function optSaveColors(): void {
  const saved: Record<string, string> = {};
  Object.keys(OPT_COLOR_DEFAULTS).forEach(k => {
    saved[k] = getComputedStyle(document.documentElement).getPropertyValue(OPT_COLOR_CSS_VARS[k]).trim();
  });
  lsSet('fs-opt-colors', saved);
}

export function optLoadColors(): void {
  const saved = lsGet<Record<string, string>>('fs-opt-colors', {});
  Object.keys(OPT_COLOR_DEFAULTS).forEach(k => {
    const hex = saved[k] || OPT_COLOR_DEFAULTS[k];
    const ck = capKey(k);
    const picker = document.getElementById('optColor' + ck) as HTMLInputElement | null;
    const hexInp = document.getElementById('optHex' + ck) as HTMLInputElement | null;
    const swatch = document.getElementById('optSwatch' + ck) as HTMLElement | null;
    if (picker) picker.value = hex;
    if (hexInp) hexInp.value = hex;
    if (swatch) swatch.style.background = hex;
    document.documentElement.style.setProperty(OPT_COLOR_CSS_VARS[k], hex);
  });
}

// ── Jog step sizes & max speeds ───────────────────────────────────────────────
export function optSaveJogSteps(): void {
  lsSet('fs-opt-jogsteps', {
    xy:       (document.getElementById('optJogStepsXY') as HTMLInputElement).value,
    z:        (document.getElementById('optJogStepsZ') as HTMLInputElement).value,
    maxXY:    (document.getElementById('optJogMaxXY') as HTMLInputElement).value,
    maxZ:     (document.getElementById('optJogMaxZ') as HTMLInputElement).value,
  });
}

export function optLoadJogSteps(): void {
  const s = lsGet<any>('fs-opt-jogsteps', {});
  if (s.xy) (document.getElementById('optJogStepsXY') as HTMLInputElement).value = s.xy;
  if (s.z)  (document.getElementById('optJogStepsZ')  as HTMLInputElement).value = s.z;
  if (s.maxXY) (document.getElementById('optJogMaxXY') as HTMLInputElement).value = s.maxXY;
  if (s.maxZ)  (document.getElementById('optJogMaxZ')  as HTMLInputElement).value = s.maxZ;
}

function parseSteps(raw: string): number[] {
  return raw.split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n) && n > 0);
}

export function optApplyJogSteps(): void {
  const xySteps = parseSteps((document.getElementById('optJogStepsXY') as HTMLInputElement).value);
  const zSteps  = parseSteps((document.getElementById('optJogStepsZ')  as HTMLInputElement).value);
  if (xySteps.length === 0 || zSteps.length === 0) return;
  const maxXY = parseInt((document.getElementById('optJogMaxXY') as HTMLInputElement).value) || 3000;
  const maxZ  = parseInt((document.getElementById('optJogMaxZ')  as HTMLInputElement).value) || 500;
  setMaxSpeeds(maxXY, maxZ);
  rebuildSteps(xySteps, zSteps);
  optSaveJogSteps();
}

export function optApplyJogShowUnits(show: boolean): void {
  document.body.classList.toggle('jog-show-units', show);
  lsSet('fs-opt-jog-show-units', show);
}

export function optLoadJogShowUnits(): void {
  const show = lsGet<boolean>('fs-opt-jog-show-units', false);
  const cb = document.getElementById('optJogShowUnits') as HTMLInputElement | null;
  if (cb) cb.checked = show;
  document.body.classList.toggle('jog-show-units', show);
}

// ── Exclusion zone colours ─────────────────────────────────────────────────────
const BEAR_COLOR_IDS = ['optBearColorAll', 'optBearColorGcode', 'optBearColorJog', 'optBearColorTool', 'optBearColorSafe'];

export function optSaveBearColors(): void {
  const c: Record<string, string> = {};
  BEAR_COLOR_IDS.forEach(id => { c[id] = (document.getElementById(id) as HTMLInputElement).value; });
  c['optBearScale'] = (document.getElementById('optBearScale') as HTMLInputElement).value;
  lsSet('fs-opt-bearcolors', c);
}

export function optLoadBearColors(): void {
  const c = lsGet<Record<string, string>>('fs-opt-bearcolors', {});
  BEAR_COLOR_IDS.forEach(id => {
    if (c[id]) {
      const inp = document.getElementById(id) as HTMLInputElement;
      if (inp) { inp.value = c[id]; const swatch = inp.nextElementSibling as HTMLElement; if (swatch) swatch.style.background = c[id]; }
    }
  });
  if (c['optBearScale']) {
    const sl = document.getElementById('optBearScale') as HTMLInputElement;
    const disp = document.getElementById('optBearScaleVal');
    if (sl) sl.value = c['optBearScale'];
    if (disp) disp.textContent = parseFloat(c['optBearScale']).toFixed(3);
  }
}

// ── Jobs and the resume (stores/options.ts) ───────────────────────────────────
export function optInitJobOptions(): void {
  const box = (id: string, sig: { value: boolean }) => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (!el) return;
    el.checked = sig.value;
    el.addEventListener('change', () => { sig.value = el.checked; log('info', `${el.parentElement?.textContent?.trim() ?? id}: ${el.checked ? 'on' : 'off'}`); });
  };
  box('optHoldEveryM6', jobOptions.holdEveryM6);
  box('optRunAfterM30', jobOptions.runAfterM30);
  const lift = document.getElementById('optResumeLift') as HTMLInputElement | null;
  if (lift) {
    lift.value = String(jobOptions.resumeLiftMm.value);
    lift.addEventListener('change', () => { jobOptions.setResumeLift(parseFloat(lift.value)); lift.value = String(jobOptions.resumeLiftMm.value); });
  }
}

export function optGetBearScale(): number {
  const el = document.getElementById('optBearScale') as HTMLInputElement | null;
  return el ? parseFloat(el.value) || 0.0875 : 0.0875;
}

export function optGetBearColor(flags: number): string {
  const en = !!(flags & 8);
  if (!en) return '#444444';
  const blocksGcode = !(flags & 1), blocksJog = !(flags & 2), blocksTool = !(flags & 4);
  if (!blocksGcode && !blocksJog && !blocksTool) return (document.getElementById('optBearColorSafe') as HTMLInputElement)?.value || '#22cc66';
  if (blocksGcode && blocksJog && blocksTool) return (document.getElementById('optBearColorAll') as HTMLInputElement)?.value || '#ff2222';
  if (blocksGcode) return (document.getElementById('optBearColorGcode') as HTMLInputElement)?.value || '#ff6600';
  if (blocksJog) return (document.getElementById('optBearColorJog') as HTMLInputElement)?.value || '#ffcc00';
  if (blocksTool) return (document.getElementById('optBearColorTool') as HTMLInputElement)?.value || '#cc44ff';
  return (document.getElementById('optBearColorAll') as HTMLInputElement)?.value || '#ff2222';
}

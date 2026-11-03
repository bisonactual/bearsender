// ═══════════════════════════════════════════════
// Main entry point — wires the carried-over screens, then mounts the shell
// ═══════════════════════════════════════════════

import { render, h } from 'preact';
import { state } from './state';
import { lsGet, lsSet } from './ui';
import { log, clearConsole, sendManual, handleConInput, conAutoUpdate } from './console';
import { sendCmd } from './connection';
import * as command from './command';
import { initParser } from './parser';
import { initViewport, setView, fitView, toggleToolhead, vpApply, setProjection, toggleWcsMarkers } from './viewport';
import { loadFile } from './gcode';
import { updateRunButtons } from './streaming';
import { initKeyboardJog, jogStats } from './jog';
import { mount as mountMacros } from './modules/macros';
import { mount as mountSignals } from './modules/signals';
import { loadPreview3D, clearPreview3D, stepPreview3D, playPreview3D } from './probing/probe-preview-3d';
import { loadSettings, filterSettings, writeAllDirty } from './settings';
import { loadToolTable } from './tooltable';
import { selectCamera, startCamera, stopCamera, measureOffset, goToCamera, goToSpindle, zeroAtCrosshair, camMouseDown, camMouseMove, camMouseUp, setCrosshairStyle, setCrosshairColor, loadCamSettings, drawOverlay, initCameraListeners } from './camera';
import { kbdPress, kbdBackspace, kbdClear, kbdSend, toggleTouchKeyboard } from './keyboard';
import { optSetConnMode, optSaveConnSettings, optLoadConnSettings, optLoadColors, optApplyColor, optHexChange, optResetColor, optResetAllColors, optSaveJogSteps, optLoadJogSteps, optApplyJogSteps, optApplyJogShowUnits, optLoadJogShowUnits, optSaveBearColors, optLoadBearColors } from './options';
import { initExclusionZonesTab, rebuildZoneMeshes } from './exclusion-zones';
import { initFlightRecorderTab } from './flight-recorder';
import { App } from './app/App';
import * as machine from './stores/machine';

// ── Expose to window for HTML onclick handlers ────────────────────────────────
const w = window as any;
w.vpApply = vpApply;
w.setProjection = setProjection;

// Window globals for dynamically generated HTML onclick handlers
w.sendCmd = sendCmd;  // used by settings-widgets.ts generated HTML
w.loadPreview3D = loadPreview3D;
w.clearPreview3D = clearPreview3D;

// ── Shared event helper ───────────────────────────────────────────────────────
function on(id: string, evt: string, fn: (e: any) => void): void {
  const el = document.getElementById(id);
  if (el) el.addEventListener(evt, fn);
}

// ── Event wiring (chunk 3: settings, camera, options) ─────────────────────────
function initChunk3Events(): void {

  // Settings tab
  on('btnLoadSettings', 'click', () => loadSettings());
  on('btnWriteAll', 'click', () => writeAllDirty());
  on('settingsSearch', 'input', () => filterSettings((document.getElementById('settingsSearch') as HTMLInputElement).value));

  // Camera tab
  on('camSelect', 'change', () => selectCamera((document.getElementById('camSelect') as HTMLSelectElement).value));
  on('camStartBtn', 'click', () => startCamera());
  on('camStopBtn', 'click', () => stopCamera());
  on('camZoom', 'input', () => { const v = parseFloat((document.getElementById('camZoom') as HTMLInputElement).value); state.camZoomVal = v; document.getElementById('camZoomDisp')!.textContent = v.toFixed(1) + 'x'; drawOverlay(); });
  on('camCrossSize', 'input', () => { state.camCrossSizeVal = parseInt((document.getElementById('camCrossSize') as HTMLInputElement).value); drawOverlay(); });
  document.querySelectorAll<HTMLElement>('.ccs-btn[data-style]').forEach(btn => {
    btn.addEventListener('click', () => setCrosshairStyle(btn.dataset.style!));
  });
  document.querySelectorAll<HTMLElement>('.ccs-btn[data-color]').forEach(btn => {
    btn.addEventListener('click', () => setCrosshairColor(btn.dataset.color!));
  });
  on('camOffX', 'change', () => { state.camOffsetX = parseFloat((document.getElementById('camOffX') as HTMLInputElement).value) || 0; });
  on('camOffY', 'change', () => { state.camOffsetY = parseFloat((document.getElementById('camOffY') as HTMLInputElement).value) || 0; });
  on('camMeasureBtn', 'click', () => measureOffset());
  on('camGoCameraBtn', 'click', () => goToCamera());
  on('camGoSpindleBtn', 'click', () => goToSpindle());
  on('camZeroHereBtn', 'click', () => zeroAtCrosshair());
  const camDrag = document.getElementById('camDragLayer');
  if (camDrag) {
    camDrag.addEventListener('mousedown', e => camMouseDown(e));
    camDrag.addEventListener('mousemove', e => camMouseMove(e));
    camDrag.addEventListener('mouseup', e => camMouseUp(e));
    camDrag.addEventListener('contextmenu', e => e.preventDefault());
  }

  // Options — connection
  on('connBtnWs', 'click', () => optSetConnMode('websocket'));
  on('connBtnSerial', 'click', () => optSetConnMode('serial'));
  ['optBaudRate', 'optDataBits', 'optStopBits', 'optParity'].forEach(id => on(id, 'change', () => optSaveConnSettings()));
  on('optAutoLoadSettings', 'change', () => { lsSet('fs-opt-autoload-settings', (document.getElementById('optAutoLoadSettings') as HTMLInputElement).checked); });

  // Options — viewport extents
  ['vpXMin', 'vpXMax', 'vpYMin', 'vpYMax'].forEach(id => on(id, 'input', () => vpApply()));

  // Options — projection
  on('projBtnPersp', 'click', () => { setProjection(false); document.getElementById('projBtnPersp')!.classList.add('selected'); document.getElementById('projBtnOrtho')!.classList.remove('selected'); });
  on('projBtnOrtho', 'click', () => { setProjection(true); document.getElementById('projBtnOrtho')!.classList.add('selected'); document.getElementById('projBtnPersp')!.classList.remove('selected'); });

  // Options — colour theme
  const colorKeys = ['text', 'text2', 'bg', 'surface', 'accent', 'tabActive', 'vpCut', 'vpRapid', 'vpExecuted', 'vpTool'];
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  colorKeys.forEach(k => {
    on('optColor' + cap(k), 'input', () => optApplyColor(k, (document.getElementById('optColor' + cap(k)) as HTMLInputElement).value));
    on('optHex' + cap(k), 'input', () => optHexChange(k, (document.getElementById('optHex' + cap(k)) as HTMLInputElement).value));
    // Swatch click → open picker
    const swatch = document.getElementById('optSwatch' + cap(k));
    if (swatch) swatch.addEventListener('click', () => (document.getElementById('optColor' + cap(k)) as HTMLInputElement).click());
    // Reset button — find by sibling
    const row = swatch?.closest('.opt-color-row');
    const resetBtn = row?.querySelector('.opt-reset-btn');
    if (resetBtn) resetBtn.addEventListener('click', () => optResetColor(k));
  });
  on('btnResetAllColors', 'click', () => optResetAllColors());

  // Options — exclusion zone colours
  ['optBearColorAll', 'optBearColorGcode', 'optBearColorJog', 'optBearColorTool', 'optBearColorSafe'].forEach(id => {
    on(id, 'input', () => { optSaveBearColors(); rebuildZoneMeshes(); const p = document.getElementById(id) as HTMLInputElement; const s = p?.nextElementSibling as HTMLElement; if (s) s.style.background = p.value; });
    // Swatch click
    const picker = document.getElementById(id);
    const swatch = picker?.nextElementSibling as HTMLElement | null;
    if (swatch) swatch.addEventListener('click', () => (document.getElementById(id) as HTMLInputElement).click());
  });
  on('optBearScale', 'input', () => { optSaveBearColors(); rebuildZoneMeshes(); document.getElementById('optBearScaleVal')!.textContent = parseFloat((document.getElementById('optBearScale') as HTMLInputElement).value).toFixed(3); });

  // Options — jog steps
  on('optJogStepsXY', 'input', () => optSaveJogSteps());
  on('optJogStepsZ', 'input', () => optSaveJogSteps());
  on('optJogMaxXY', 'change', () => optSaveJogSteps());
  on('optJogMaxZ',  'change', () => optSaveJogSteps());
  on('btnApplyJogSteps', 'click', () => optApplyJogSteps());
  on('optJogShowUnits', 'change', () => {
    const cb = document.getElementById('optJogShowUnits') as HTMLInputElement;
    optApplyJogShowUnits(cb.checked);
  });
}

// ── Event wiring (chunk 2: console, limits, tool table, keyboard) ─────────────
function initChunk2Events(): void {

  // Console
  on('btnConClear', 'click', () => clearConsole());
  on('btnKeyboard', 'click', () => toggleTouchKeyboard());
  on('conInput', 'keydown', e => handleConInput(e));
  on('conInput', 'input', () => conAutoUpdate());
  on('btnConSend', 'click', () => sendManual());

  // Tool table
  on('modTTRefresh', 'click', () => loadToolTable());
  on('btnTTRefresh', 'click', () => loadToolTable());

  // Touch keyboard (delegated)
  const kbd = document.getElementById('touchKbdOverlay');
  if (kbd) {
    kbd.addEventListener('click', e => {
      const key = (e.target as HTMLElement).closest<HTMLElement>('[data-key]');
      if (key) { kbdPress(e, key.dataset.key!); return; }
      const action = (e.target as HTMLElement).closest<HTMLElement>('[data-kbd]');
      if (!action) return;
      const a = action.dataset.kbd!;
      if (a === 'backspace') kbdBackspace(e);
      else if (a === 'send') kbdSend(e);
      else if (a === 'clear') kbdClear(e);
      else if (a === 'close') toggleTouchKeyboard();
    });
    kbd.addEventListener('touchstart', e => {
      const key = (e.target as HTMLElement).closest<HTMLElement>('[data-key]');
      if (key) { e.preventDefault(); kbdPress(e, key.dataset.key!); return; }
      const action = (e.target as HTMLElement).closest<HTMLElement>('[data-kbd]');
      if (!action) return;
      e.preventDefault();
      const a = action.dataset.kbd!;
      if (a === 'backspace') kbdBackspace(e);
      else if (a === 'send') kbdSend(e);
      else if (a === 'clear') kbdClear(e);
      else if (a === 'close') toggleTouchKeyboard();
    }, { passive: false });
  }
}

// ── Event wiring (chunk 1: files, SD, viewport header) ────────────────────────
function initChunk1Events(): void {

  // Files
  on('fileInput', 'change', (e) => { loadFile(e.target as HTMLInputElement); (e.target as HTMLInputElement).value = ''; });

  // Viewport header
  document.querySelectorAll<HTMLElement>('.view-btn[data-view]').forEach(btn => {
    btn.addEventListener('click', () => setView(btn.dataset.view!));
  });
  on('btnFitView', 'click', () => fitView());
  on('btnToolhead', 'click', () => toggleToolhead());
  on('btnWcsVis', 'click', () => toggleWcsMarkers());
  on('vpCopyBtn', 'click', () => copyDebugStats());

  // Probe preview overlay controls
  on('ppStepBck', 'click', () => stepPreview3D(-1));
  on('ppStepFwd', 'click', () => stepPreview3D(1));
  on('ppPlay', 'click', () => playPreview3D());
  on('ppClose', 'click', () => clearPreview3D());
}

// ── Debug stats clipboard ─────────────────────────────────────────────────────
function copyDebugStats(): void {
  const snap = {
    ts: new Date().toISOString(),
    connected: state.connected,
    connMode: state.connMode,
    machineState: state._prevMachineStateSl,
    homed: state.machineHomed,
    pos: { x: state.machineX, y: state.machineY, z: state.machineZ },
    commands: command.stats(),
    job: { running: state.running, paused: state.paused, lineHead: state.lineHead, totalLines: state.gcodeLines.length },
    jog: { isJogging: state._isJogging, ...jogStats() },
    overrides: machine.overrides.value,
    axes: state.controllerAxes,
  };
  navigator.clipboard.writeText(JSON.stringify(snap, null, 2)).then(() => {
    const btn = document.getElementById('vpCopyBtn');
    if (btn) { btn.classList.add('copied'); btn.textContent = '✓'; setTimeout(() => { btn.classList.remove('copied'); btn.textContent = '📋'; }, 1500); }
  });
}

// The command layer, and its last 3000 events (lines sent and received, syncs), for debugging from the console.
w.command = command;
w.commandTrace = () => command.traceLog().map(e => new Date(e.t).toISOString().slice(11, 23) + ' ' + e.dir + ' ' + e.text).join('\n');

// ── Init ──────────────────────────────────────────────────────────────────────
// The carried-over panels are built into #legacy first; the shell then moves each into its screen.
initParser();
initChunk1Events();
initChunk2Events();
initChunk3Events();
initViewport();
const legacyEl = document.getElementById('legacy') as HTMLElement;
mountMacros(legacyEl);
mountSignals(legacyEl);
initKeyboardJog();

initCameraListeners();
loadCamSettings();

// The console keeps the line count chosen in the old MODULES tab.
state.consoleMaxLines = lsGet<Record<string, any>>('fs-modules', {})._consoleLines || state.consoleMaxLines;

log('info', 'BearSender ready — IOSender-compatible character-counting stream.');
log('info', 'Open a G-code file to preview the toolpath, then connect and run.');
updateRunButtons();

window.addEventListener('load', () => {
  const fields: Record<string, number> = { vpXMin: state.vpXMin, vpXMax: state.vpXMax, vpYMin: state.vpYMin, vpYMax: state.vpYMax };
  for (const [id, val] of Object.entries(fields)) {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) el.value = String(val);
  }
  optLoadConnSettings();
  optLoadColors();
  // Save WS URL on change
  const wsInput = document.getElementById('wsUrl') as HTMLInputElement | null;
  if (wsInput) wsInput.addEventListener('change', () => optSaveConnSettings());
  optLoadJogSteps();
  optApplyJogSteps();
  optLoadJogShowUnits();
  optLoadBearColors();
  initExclusionZonesTab();
  initFlightRecorderTab();
  import('./options').then(o => o.optInitJobOptions());
  // Restore auto-load settings toggle
  try { const al = document.getElementById('optAutoLoadSettings') as HTMLInputElement; if (al) al.checked = lsGet('fs-opt-autoload-settings', false); } catch (_) {}
  // Sync projection toggle
  const projPersp = document.getElementById('projBtnPersp');
  const projOrtho = document.getElementById('projBtnOrtho');
  if (projPersp && projOrtho) {
    projPersp.classList.toggle('selected', !state.vpOrtho);
    projOrtho.classList.toggle('selected', state.vpOrtho);
  }

  // ── Column selector ─────────────────────────────────────────────────────────
  const optColSel = document.getElementById('optColSelect') as HTMLSelectElement | null;
  const optGrid = document.querySelector('.options-grid') as HTMLElement | null;
  const savedOptCols = lsGet('fs-opt-cols', '2');
  if (optColSel) { optColSel.value = savedOptCols; if (optGrid) optGrid.style.setProperty('--opt-cols', savedOptCols); }
  if (optColSel) optColSel.addEventListener('change', () => { if (optGrid) optGrid.style.setProperty('--opt-cols', optColSel.value); lsSet('fs-opt-cols', optColSel.value); });

  // ── Options search ──────────────────────────────────────────────────────────
  const optSearchInput = document.getElementById('optSearch') as HTMLInputElement | null;
  if (optSearchInput) {
    optSearchInput.addEventListener('input', () => {
      const q = optSearchInput.value.toLowerCase().trim();
      document.querySelectorAll<HTMLElement>('.options-card').forEach(card => {
        const title = card.querySelector('.options-card-title')?.textContent?.toLowerCase() || '';
        const desc = card.querySelector('.options-card-desc')?.textContent?.toLowerCase() || '';
        const match = !q || title.includes(q) || desc.includes(q);
        card.style.display = match ? '' : 'none';
      });
    });
  }
});

render(h(App, null), document.getElementById('app')!);

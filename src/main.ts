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
import { initViewport, setView, fitView, toggleToolhead, setProjection, toggleWcsMarkers } from './viewport';
import { loadFile } from './gcode';
import { updateRunButtons } from './streaming';
import { initKeyboardJog, jogStats } from './jog';
import { mount as mountMacros } from './modules/macros';
import { mount as mountSignals } from './modules/signals';
import { loadPreview3D, clearPreview3D, stepPreview3D, playPreview3D } from './probing/probe-preview-3d';
import { selectCamera, startCamera, stopCamera, measureOffset, goToCamera, goToSpindle, zeroAtCrosshair, camMouseDown, camMouseMove, camMouseUp, setCrosshairStyle, setCrosshairColor, loadCamSettings, drawOverlay, initCameraListeners } from './camera';
import { kbdPress, kbdBackspace, kbdClear, kbdSend, toggleTouchKeyboard } from './keyboard';
import { optLoadColors, optApplyJogSteps } from './options';
import { initZones } from './exclusion-zones';
import { initFlightRecorderTab } from './flight-recorder';
import { App } from './app/App';
import * as machine from './stores/machine';
import * as connection from './stores/connection';

// ── Expose to window for HTML onclick handlers ────────────────────────────────
const w = window as any;
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

// ── Event wiring (chunk 3: camera) ────────────────────────────────────────────
function initChunk3Events(): void {

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
}

// ── Event wiring (chunk 2: console, limits, keyboard) ─────────────────────────
function initChunk2Events(): void {

  // Console
  on('btnConClear', 'click', () => clearConsole());
  on('btnKeyboard', 'click', () => toggleTouchKeyboard());
  on('conInput', 'keydown', e => handleConInput(e));
  on('conInput', 'input', () => conAutoUpdate());
  on('btnConSend', 'click', () => sendManual());

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
    connMode: connection.settings.value.mode,
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
  // The kept theme, jog steps and zone drawing (Settings, Options).
  optLoadColors();
  optApplyJogSteps();
  initZones();
  initFlightRecorderTab();
});

render(h(App, null), document.getElementById('app')!);

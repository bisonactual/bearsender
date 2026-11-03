// ═══════════════════════════════════════════════
// Main entry point — wires the carried-over screens, then mounts the shell
// ═══════════════════════════════════════════════

import { render, h } from 'preact';
import { state } from './state';
import { lsGet, lsSet } from './ui';
import { log } from './console';
import { sendCmd } from './connection';
import * as command from './command';
import { initParser } from './parser';
import { initViewport, setView, fitView, toggleToolhead, setProjection, toggleWcsMarkers } from './viewport';
import { loadFile } from './gcode';
import { updateRunButtons } from './streaming';
import { initKeyboardJog, jogStats } from './jog';
import { mount as mountSignals } from './modules/signals';
import { loadPreview3D, clearPreview3D, stepPreview3D, playPreview3D } from './probing/probe-preview-3d';
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
initViewport();
const legacyEl = document.getElementById('legacy') as HTMLElement;
mountSignals(legacyEl);
initKeyboardJog();

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

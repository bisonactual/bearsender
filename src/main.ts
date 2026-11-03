// The entry point: starts the parser, the 3D view and the keyboard jog, then mounts the shell.

import { render, h } from 'preact';
import { log } from './console';
import * as command from './command';
import { initParser } from './parser';
import { initViewport } from './viewport';
import { loadFile } from './gcode';
import { publishRunState } from './streaming';
import { initKeyboardJog } from './jog';
import { optLoadColors, optApplyJogSteps } from './options';
import { initZones } from './exclusion-zones';
import { initFlightRecorder } from './flight-recorder';
import { App } from './app/App';

const w = window as any;

function on(id: string, evt: string, fn: (e: any) => void): void {
  const el = document.getElementById(id);
  if (el) el.addEventListener(evt, fn);
}

// The file picker (LOAD JOB).
on('fileInput', 'change', (e) => { loadFile(e.target as HTMLInputElement); (e.target as HTMLInputElement).value = ''; });

// The command layer, and its last 3000 events (lines sent and received, syncs), for debugging from the console.
w.command = command;
w.commandTrace = () => command.traceLog().map(e => new Date(e.t).toISOString().slice(11, 23) + ' ' + e.dir + ' ' + e.text).join('\n');

initParser();
initViewport();
initKeyboardJog();

log('info', 'BearSender ready: IOSender-compatible character-counting stream.');
log('info', 'Open a G-code file to preview the toolpath, then connect and run.');
publishRunState();

window.addEventListener('load', () => {
  // The kept theme, jog steps and zone drawing (Settings, Options).
  optLoadColors();
  optApplyJogSteps();
  initZones();
  initFlightRecorder();
});

render(h(App, null), document.getElementById('app')!);

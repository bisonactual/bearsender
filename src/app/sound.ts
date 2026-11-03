// The chime at a tool change, made with WebAudio (no sound files).
//
// When a job reaches the hold at an M6, a chime plays if that tool's toggle is on. Toggles are
// kept per file contents and tool change line, in this browser; every one starts on.

import { signal, effect, untracked } from '@preact/signals';
import { lsGet, lsSet } from '../ui';
import { log } from '../console';
import { jobId } from '../flight-recorder-resume';
import * as job from '../stores/job';
import * as program from '../stores/program';

const KEY = 'fs-bells-off';

/** The toggles turned off, as "<job id>:<M6 line>". */
export const bellsOff = signal<Record<string, true>>(lsGet<Record<string, true>>(KEY, {}));
effect(() => lsSet(KEY, bellsOff.value));

export function bellOn(id: string, line: number): boolean {
  return !bellsOff.value[id + ':' + line];
}

export function toggleBell(id: string, line: number): void {
  const key = id + ':' + line;
  const next = { ...bellsOff.value };
  if (next[key]) delete next[key]; else next[key] = true;
  bellsOff.value = next;
}

// A browser lets a page make sound only after a tap: the first tap anywhere starts the audio.
let audio: AudioContext | null = null;
function unlock(): void {
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') audio.resume();
  } catch (_) { /* no WebAudio: no sound */ }
}
document.addEventListener('pointerdown', unlock, true);
document.addEventListener('keydown', unlock, true);

/** Two rising tones, twice: about a second and a half. */
export function chime(): boolean {
  if (!audio || audio.state !== 'running') return false;
  const t0 = audio.currentTime + 0.02;
  for (const [at, freq] of [[0, 660], [0.22, 880], [0.7, 660], [0.92, 880]]) {
    const osc = audio.createOscillator(), gain = audio.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t0 + at);
    gain.gain.exponentialRampToValueAtTime(0.35, t0 + at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.4);
    osc.connect(gain).connect(audio.destination);
    osc.start(t0 + at);
    osc.stop(t0 + at + 0.45);
  }
  return true;
}

// The hold at an M6: the run's newest tool change, if the controller stopped for it.
let heard = 0;
effect(() => {
  const list = job.changes.value;
  if (list.length <= heard) { heard = list.length; return; }
  heard = list.length;
  const c = list[list.length - 1];
  if (!c.held) return;
  untracked(() => {
    const v = program.view.value;
    const row = v?.rows.find(r => r.changeLine === c.line);
    const tool = row?.tool !== null && row?.tool !== undefined ? 'T' + row.tool : 'the next tool';
    if (!bellOn(jobId(job.lines.value), c.line)) { log('info', `♪ Tool change at line ${c.line} (${tool}): its sound is off`); return; }
    const played = chime();
    log('info', `♪ Tool change at line ${c.line} (${tool}): ${played ? 'sound played' : 'sound on, but the browser has no audio yet (tap the page once)'}`);
  });
});

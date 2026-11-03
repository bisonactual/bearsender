// ═══════════════════════════════════════════════
// What the job screen shows, worked out from the stores
// ═══════════════════════════════════════════════

import { computed, effect, untracked } from '@preact/signals';
import * as connection from '../stores/connection';
import * as machine from '../stores/machine';
import * as job from '../stores/job';
import * as messages from '../stores/messages';
import * as flight from '../stores/flight';
import * as camera from '../stores/camera';
import * as program from '../stores/program';
import type { ToolRow } from '../stores/program';
import * as ui from './ui';

/** The four states of the mockup (ready, running, change, alarm), plus hold and offline. */
export type Mode = 'offline' | 'ready' | 'running' | 'hold' | 'change' | 'alarm';

export const mode = computed<Mode>(() => {
  if (!connection.connected.value) return 'offline';
  const s = machine.stateName.value;
  if (s === 'alarm') return 'alarm';
  if (s === 'tool' || (job.heldAtM6.value && job.running.value)) return 'change';
  // The controller's hold or door, whoever started the motion (a job, the console, the SD card).
  if (s === 'hold' || s === 'door') return 'hold';
  if (job.running.value) return job.paused.value ? 'hold' : 'running';
  return 'ready';
});

/** The tool change mode, $341: 0 pause only, 1 manual, 2 manual at G59.3, 3 semi-automatic, 4 ignored. */
export function toolChangeMode(): number | null {
  const v = parseInt(machine.settings.value[341] ?? '');
  return isNaN(v) ? null : v;
}

/** The machine is moving or held in a move, whether or not BearSender is sending a job. */
export const moving = computed(() => ['run', 'jog', 'hold', 'home', 'door', 'tool'].includes(machine.stateName.value));

/** The last run stopped short (stopped, error, alarm, lost link) and nothing has started since. */
export const stoppedShort = computed(() => {
  const r = job.result.value;
  return r !== null && r !== 'completed';
});

// The reasons a job stops on its own, which the resume is offered for (as in flight-recorder.ts).
const UNEXPECTED = new Set(['timeout', 'usb', 'network', 'reboot']);

/** The flight record holds a job that stopped on its own part way through: one to resume. */
export const recordToResume = computed(() => {
  const r = flight.record.value;
  return !!r && flight.enabled.value && (r.state === 'Stopped' || r.state === 'Retracted') && r.ln > 0 && UNEXPECTED.has(r.why);
});

/** AUTO, right panel: Setup before a start and at a tool change; while running the Camera if one is set up,
 *  otherwise the Recorder; the Recorder after a stop. An alarm opens the Recorder only after a stop or a lost
 *  link this session, or with a job to resume; a power-up alarm such as 11 (homing required) opens Setup. */
export const autoPanel = computed<ui.Panel>(() => {
  const m = mode.value;
  if (m === 'running' || m === 'hold') return camera.device.value !== null ? 'camera' : 'recorder';
  if (m === 'change') return 'setup';
  if (stoppedShort.value || (m === 'alarm' && recordToResume.value)) return 'recorder';
  return 'setup';
});

export const panel = computed<ui.Panel>(() => ui.auto.value ? autoPanel.value : ui.pickedPanel.value);

/** AUTO, left panel: the Program while running, the Jobs list otherwise. */
export const leftPanel = computed<ui.LeftPanel>(() => {
  if (!ui.leftAuto.value) return ui.pickedLeft.value;
  const m = mode.value;
  return m === 'running' || m === 'hold' ? 'program' : 'jobs';
});

/** The loaded program's tools, from the interpreter: one row per tool use. Empty until it has been read. */
export const rows = computed<ToolRow[]>(() => program.view.value?.rows ?? []);

/** The line the job is at, for progress: the executing line while running, the start before. */
export const atLine = computed(() => job.executingLine.value || (job.running.value ? job.sentLine.value : 0));

export const sectionIndex = computed(() => program.rowAt(rows.value, atLine.value));

/** The tool row after the current one, for "next action". */
export const nextSection = computed(() => {
  const s = rows.value;
  const k = sectionIndex.value;
  return atLine.value > 0 && k + 1 < s.length ? s[k + 1] : null;
});

/** The tool the controller is waiting for at a tool change: the row of the M6 it stopped at. */
export const awaitedSection = computed(() => {
  const s = rows.value;
  if (!s.length) return null;
  const changes = job.changes.value;
  const last = changes[changes.length - 1];
  if (last && last.endedAt === null) return s.find(r => r.changeLine === last.line) ?? null;
  const line = Math.max(job.executingLine.value, job.ackedLine.value);
  for (let k = s.length - 1; k >= 0; k--) if (s[k].changeLine && s[k].changeLine <= line) return s[k];
  return s[0];
});

/** "T2 · 10 mm flat end mill": the tool table's name, else the program's header comment. */
export function toolLabel(tool: number | null): string {
  if (tool === null) return 'the tool in the spindle';
  const entry = machine.toolTable.value?.find(e => e.tool === tool);
  const desc = entry?.name || program.view.value?.described[tool];
  return 'T' + tool + (desc ? ' · ' + desc : '');
}

// The controller says nothing at an M6, so the messages get a line of their own.
let lastMode: Mode = 'offline';
effect(() => {
  const m = mode.value;
  if (m === 'change' && lastMode !== 'change') {
    untracked(() => {
      const s = awaitedSection.value;
      messages.push('job', 'Tool change: load ' + (s ? toolLabel(s.tool) : 'the next tool') + ', then press Resume.');
    });
  }
  lastMode = m;
});

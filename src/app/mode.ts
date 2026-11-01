// ═══════════════════════════════════════════════
// What the job screen shows, worked out from the stores
// ═══════════════════════════════════════════════

import { computed, effect, untracked } from '@preact/signals';
import * as connection from '../stores/connection';
import * as machine from '../stores/machine';
import * as job from '../stores/job';
import * as messages from '../stores/messages';
import * as ui from './ui';
import { scanTools, sectionAt } from './toolscan';

/** The four states of the mockup (ready, running, change, alarm), plus hold and offline. */
export type Mode = 'offline' | 'ready' | 'running' | 'hold' | 'change' | 'alarm';

export const mode = computed<Mode>(() => {
  if (!connection.connected.value) return 'offline';
  const s = machine.stateName.value;
  if (s === 'alarm') return 'alarm';
  if (s === 'tool') return 'change';
  if (job.running.value) return s === 'hold' || job.paused.value ? 'hold' : 'running';
  return 'ready';
});

/** The last run stopped short (stopped, error, alarm, lost link) and nothing has started since. */
export const stoppedShort = computed(() => {
  const r = job.result.value;
  return r !== null && r !== 'completed';
});

/** AUTO: Setup before a start and at a tool change, Program while running, Recorder after a stop. */
export const autoPanel = computed<ui.Panel>(() => {
  const m = mode.value;
  if (m === 'running' || m === 'hold') return 'program';
  if (m === 'change') return 'setup';
  if (m === 'alarm' || stoppedShort.value) return 'recorder';
  return 'setup';
});

export const panel = computed<ui.Panel>(() => ui.auto.value ? autoPanel.value : ui.pickedPanel.value);

export const scan = computed(() => scanTools(job.lines.value));

/** The line the job is at, for progress: the executing line while running, the start before. */
export const atLine = computed(() => job.executingLine.value || (job.running.value ? job.sentLine.value : 0));

export const sectionIndex = computed(() => sectionAt(scan.value.sections, atLine.value));

/** The tool section after the current one, for "next action". */
export const nextSection = computed(() => {
  const s = scan.value.sections;
  const k = sectionIndex.value;
  return atLine.value > 0 && k + 1 < s.length ? s[k + 1] : null;
});

/** The tool the controller is waiting for at a tool change: the section the executing line has reached. */
export const awaitedSection = computed(() => {
  const s = scan.value.sections;
  if (!s.length) return null;
  const line = Math.max(job.executingLine.value, job.ackedLine.value);
  for (let k = s.length - 1; k >= 0; k--) if (s[k].changeLine && s[k].changeLine <= line) return s[k];
  return s[0];
});

export function toolLabel(tool: number): string {
  const entry = machine.toolTable.value?.find(e => e.tool === tool);
  const desc = entry?.name || scan.value.described[tool];
  return 'T' + tool + (desc ? ' · ' + desc : '');
}

// The controller says nothing at an M6, so the Messages panel gets a line of its own.
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

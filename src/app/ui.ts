// ═══════════════════════════════════════════════
// Shell UI state — which screen and panel are showing
// ═══════════════════════════════════════════════

import { signal, effect } from '@preact/signals';
import { lsGet, lsSet } from '../ui';

export type Screen = 'job' | 'setup' | 'probing' | 'tools' | 'settings';
/** The job screen's right panel. */
export type Panel = 'setup' | 'run' | 'recorder' | 'preview' | 'camera' | 'console' | 'macros';
/** The job screen's left panel. */
export type LeftPanel = 'jobs' | 'program';
export type SetupTab = 'machine' | 'offsets' | 'warmup';
export type SettingsTab = 'grbl' | 'zones' | 'options' | 'probe' | 'flight';
/** The Probing screen's routine: tool length, edge finder, centre finder, rotation. */
export type ProbingTab = 'tl' | 'ef' | 'cf' | 'rot';

/** A saved choice, if it is still one of the choices (tabs move between versions). */
function saved<T extends string>(key: string, choices: readonly T[], fallback: T): T {
  const v = lsGet<string>(key, fallback);
  return (choices as readonly string[]).includes(v) ? v as T : fallback;
}

export const screen = signal<Screen>(saved<Screen>('fs-screen', ['job', 'setup', 'probing', 'tools', 'settings'], 'job'));
export const setupTab = signal<SetupTab>(saved<SetupTab>('fs-setup-tab', ['machine', 'offsets', 'warmup'], 'machine'));
export const settingsTab = signal<SettingsTab>(saved<SettingsTab>('fs-settings-tab', ['grbl', 'zones', 'options', 'probe', 'flight'], 'options'));
export const probingTab = signal<ProbingTab>(saved<ProbingTab>('fs-probing-sub', ['tl', 'ef', 'cf', 'rot'], 'tl'));

/** The right panel follows the job while auto is on; picking a tab turns it off. */
export const auto = signal(lsGet('fs-panel-auto', true));
/** The tab picked by hand, used while auto is off. */
export const pickedPanel = signal<Panel>(saved<Panel>('fs-panel', ['setup', 'run', 'recorder', 'preview', 'camera', 'console', 'macros'], 'setup'));
/** The left panel, the same way. */
export const leftAuto = signal(lsGet('fs-left-auto', true));
export const pickedLeft = signal<LeftPanel>(saved<LeftPanel>('fs-left', ['jobs', 'program'], 'jobs'));
/** Position line: work or machine coordinates. */
export const posRef = signal<'work' | 'machine'>(lsGet<'work' | 'machine'>('fs-pos-ref', 'work'));
/** The loaded program's tools are shown in the Jobs list. */
export const toolsOpen = signal(true);
/** The 3D view fills the window. */
export const fullView = signal(false);
/** The Recorder panel shows every event read, not just the last few. */
export const allEvents = signal(false);

export type Popup = 'jog' | 'offsets' | 'wcs' | 'probe' | 'measure' | 'frame' | 'tools' | 'recorder' | 'messages';
/** The popup panel open over the screen, if any. */
export const popup = signal<Popup | null>(null);
/** The input signals shown on the position line. */
export const signalsShown = signal(lsGet('fs-signals-shown', false));
/** Setup lines the operator has ticked, by line. Cleared when a file loads or the link drops. */
export const ticks = signal<Record<string, boolean>>({});

effect(() => lsSet('fs-signals-shown', signalsShown.value));

export function toggleTick(key: string): void {
  ticks.value = { ...ticks.value, [key]: !ticks.value[key] };
}

effect(() => lsSet('fs-screen', screen.value));
effect(() => lsSet('fs-setup-tab', setupTab.value));
effect(() => lsSet('fs-settings-tab', settingsTab.value));
effect(() => lsSet('fs-probing-sub', probingTab.value));
effect(() => lsSet('fs-panel-auto', auto.value));
effect(() => lsSet('fs-panel', pickedPanel.value));
effect(() => lsSet('fs-left-auto', leftAuto.value));
effect(() => lsSet('fs-left', pickedLeft.value));
effect(() => lsSet('fs-pos-ref', posRef.value));

export function pickPanel(p: Panel): void {
  pickedPanel.value = p;
  auto.value = false;
}

export function pickLeft(p: LeftPanel): void {
  pickedLeft.value = p;
  leftAuto.value = false;
}

export function openSettings(tab: SettingsTab): void {
  settingsTab.value = tab;
  screen.value = 'settings';
}

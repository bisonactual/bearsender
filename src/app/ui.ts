// ═══════════════════════════════════════════════
// Shell UI state — which screen and panel are showing
// ═══════════════════════════════════════════════

import { signal, effect } from '@preact/signals';
import { lsGet, lsSet } from '../ui';

export type Screen = 'job' | 'setup' | 'probing' | 'tools' | 'settings';
export type Panel = 'setup' | 'program' | 'recorder' | 'preview' | 'messages';
export type SetupTab = 'machine' | 'offsets' | 'camera';
export type SettingsTab = 'grbl' | 'zones' | 'options' | 'flight' | 'console';

export const screen = signal<Screen>(lsGet<Screen>('fs-screen', 'job'));
export const setupTab = signal<SetupTab>(lsGet<SetupTab>('fs-setup-tab', 'machine'));
export const settingsTab = signal<SettingsTab>(lsGet<SettingsTab>('fs-settings-tab', 'options'));

/** The job panel follows the job while auto is on; picking a tab turns it off. */
export const auto = signal(lsGet('fs-panel-auto', true));
/** The tab picked by hand, used while auto is off. */
export const pickedPanel = signal<Panel>(lsGet<Panel>('fs-panel', 'setup'));
/** Position line: work or machine coordinates. */
export const posRef = signal<'work' | 'machine'>(lsGet<'work' | 'machine'>('fs-pos-ref', 'work'));
/** The loaded program's tools are shown in the Jobs list. */
export const toolsOpen = signal(true);
/** The 3D view fills the window. */
export const fullView = signal(false);
/** The Recorder panel shows every event read, not just the last few. */
export const allEvents = signal(false);

export type Popup = 'jog' | 'offsets' | 'probe' | 'measure' | 'frame' | 'tools' | 'recorder';
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
effect(() => lsSet('fs-panel-auto', auto.value));
effect(() => lsSet('fs-panel', pickedPanel.value));
effect(() => lsSet('fs-pos-ref', posRef.value));

export function pickPanel(p: Panel): void {
  pickedPanel.value = p;
  auto.value = false;
}

export function openSettings(tab: SettingsTab): void {
  settingsTab.value = tab;
  screen.value = 'settings';
}

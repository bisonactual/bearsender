// ═══════════════════════════════════════════════
// The carried-over screens' start-up, run when they first show
// ═══════════════════════════════════════════════
//
// The old tab bar did this in switchTab(). This is the one place the shell calls into
// the old screens' own loading code.

import { effect } from '@preact/signals';
import { state } from '../state';
import { loadSettings } from '../settings';
import { initCameraTab } from '../camera';
import { initProbingTab } from '../probing/probing-tab';
import { loadToolTable } from '../tooltable';
import { loadOffsets } from '../offsets';
import { renderEzTab } from '../exclusion-zones';
import { renderFlightTab } from '../flight-recorder';
import * as ui from './ui';

/** Which old tab is in view: the same names switchTab() used. */
function showing(): string {
  switch (ui.screen.value) {
    case 'setup': return ui.setupTab.value === 'machine' ? 'run' : ui.setupTab.value;
    case 'probing': return 'probing';
    case 'tools': return 'tooltable';
    case 'settings': return ({ grbl: 'settings', zones: 'exclusions', options: 'options', flight: 'flight', console: 'console' } as const)[ui.settingsTab.value];
    default: return 'run';
  }
}

export function startCarriedScreens(): void {
  effect(() => {
    const tab = showing();
    if (tab === 'settings' && !state.settingsLoaded && state.connected) loadSettings();
    if (tab === 'camera' && !state._camTabInited) { state._camTabInited = true; initCameraTab(); }
    if (tab === 'probing' && !state._probingTabInited) { state._probingTabInited = true; initProbingTab(); }
    if (tab === 'tooltable') loadToolTable();
    if (tab === 'offsets') loadOffsets();
    if (tab === 'exclusions') renderEzTab();
    if (tab === 'flight') renderFlightTab();
  });
}

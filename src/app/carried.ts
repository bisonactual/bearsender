// ═══════════════════════════════════════════════
// The carried-over screens' start-up, run when they first show
// ═══════════════════════════════════════════════
//
// The old tab bar did this in switchTab(). This is the one place the shell calls into
// the old screens' own loading code.

import { effect, untracked } from '@preact/signals';
import { state } from '../state';
import { loadSettings } from '../settings';
import { showCamera, hideCamera } from '../camera';
import { renderEzTab } from '../exclusion-zones';
import { renderFlightTab } from '../flight-recorder';
import { panel } from './mode';
import * as ui from './ui';

/** Which old tab is in view: the same names switchTab() used. */
function showing(): string {
  switch (ui.screen.value) {
    case 'setup': return ui.setupTab.value === 'machine' ? 'run' : ui.setupTab.value;
    case 'settings': return ({ grbl: 'settings', zones: 'exclusions', options: 'options', flight: 'flight' } as const)[ui.settingsTab.value];
    default: return 'run';
  }
}

export function startCarriedScreens(): void {
  effect(() => {
    const tab = showing();
    if (tab === 'settings' && !state.settingsLoaded && state.connected) loadSettings();
    if (tab === 'exclusions') renderEzTab();
    if (tab === 'flight') renderFlightTab();
  });
  // The camera runs only while the job screen's Camera tab shows.
  effect(() => {
    const on = ui.screen.value === 'job' && panel.value === 'camera';
    untracked(() => { if (on) showCamera(); else hideCamera(); });
  });
}

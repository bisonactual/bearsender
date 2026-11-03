// ═══════════════════════════════════════════════
// The carried-over screens' start-up, run when they first show
// ═══════════════════════════════════════════════
//
// The old tab bar did this in switchTab(). This is the one place the shell calls into
// the old screens' own loading code; only the camera's is left.

import { effect, untracked } from '@preact/signals';
import { showCamera, hideCamera } from '../camera';
import { panel } from './mode';
import * as ui from './ui';

export function startCarriedScreens(): void {
  // The camera runs only while the job screen's Camera tab shows.
  effect(() => {
    const on = ui.screen.value === 'job' && panel.value === 'camera';
    untracked(() => { if (on) showCamera(); else hideCamera(); });
  });
}

// ═══════════════════════════════════════════════
// What the shell asks the controller for by itself, so the Setup list needn't say "not checked yet"
// ═══════════════════════════════════════════════
//
// $# (offsets and TLO) is read on connect by the old code, and the program limits when a file loads.
// This adds homing ($22), the travel ($130-$132) and the tool table ($TTLIST), once per connection.

import { effect } from '@preact/signals';
import * as connection from '../stores/connection';
import * as job from '../stores/job';
import { sendCmd } from '../connection';
import { loadToolTable } from '../tooltable';
import * as ui from './ui';

let asked = false;

export function startAsks(): void {
  effect(() => {
    // The controller has answered $I (and with the recorder on, the handshake is through).
    const ready = connection.connected.value && connection.firmware.value !== '';
    if (!connection.connected.value) asked = false;
    if (!ready || asked) return;
    asked = true;
    setTimeout(() => {
      if (!connection.connected.value) return;
      for (const id of [22, 130, 131, 132]) sendCmd('$' + id);
      loadToolTable();  // waits for the queue to drain by itself
    }, 1500);
  });

  // The operator's ticks belong to one job on one connection.
  effect(() => {
    void job.lines.value;
    void connection.connected.value;
    ui.ticks.value = {};
  });
}

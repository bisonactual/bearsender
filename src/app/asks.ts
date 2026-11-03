// ═══════════════════════════════════════════════
// What the shell asks the controller for by itself, so the Setup list needn't say "not checked yet"
// ═══════════════════════════════════════════════
//
// $# (offsets and TLO) is read on connect by the old code, and the program limits when a file loads.
// This adds homing ($22), the travel ($130-$132), what sets the travel's ends (hard limits $21, homing
// direction $23, pull-off $27), the tool change mode ($341), the G73 retract ($28), the modes a job
// starts from ($G) and the tool table ($TTLIST), once per connection, as the last of what is read on
// connecting (connection.ts). $G is read again whenever a file is loaded.

import { effect } from '@preact/signals';
import * as connection from '../stores/connection';
import * as job from '../stores/job';
import * as command from '../command';
import { loadToolTable } from '../tooltable';
import { readModesSoon } from '../parser';
import * as ui from './ui';

export async function readSetupState(): Promise<void> {
  await Promise.all([22, 130, 131, 132, 21, 23, 27, 341, 28].map(id => command.send('$' + id, { quiet: true })));
  await command.send('$G', { quiet: true });
  await loadToolTable();
}

export function startAsks(): void {
  // The operator's ticks belong to one job on one connection.
  effect(() => {
    void job.lines.value;
    void connection.connected.value;
    ui.ticks.value = {};
  });
  // The program is read from the modes the controller is in now.
  effect(() => {
    if (job.lines.value.length && connection.connected.value) readModesSoon();
  });
}

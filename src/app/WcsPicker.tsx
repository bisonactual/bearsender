// ═══════════════════════════════════════════════
// The work offset picker: the position line's G54 chip opens it
// ═══════════════════════════════════════════════
//
// A tap sends the code (G21 G55), as the other manual commands go; the chip then shows the work offset the
// controller reports (WCS: in the status report, or $G), not the one pressed. While a job runs, or a job
// waits in the flight record to be resumed, it shows the offsets and doesn't switch: a code sent then
// would go between the job's lines, or change where the resume goes back in.

import * as connection from '../stores/connection';
import * as machine from '../stores/machine';
import * as job from '../stores/job';
import * as ui from './ui';
import { recordToResume } from './mode';
import { sendCmd } from '../connection';
import { WCS_ENTRIES, offsetsWaitForHoming } from '../offsets';

const fix3 = (v: number) => v.toFixed(3);

export function WcsPicker() {
  const linked = connection.connected.value;
  const active = machine.wcs.value;
  const offsets = machine.offsets.value;
  const read = machine.offsetsRead.value;
  const why = !linked ? 'Not connected.'
    : job.running.value ? 'A job is running: a work offset sent now would go between its lines. This shows the offsets; switch once it has ended.'
    : recordToResume.value ? 'A job waits in the flight record to be resumed, and switching would change where it goes back in. Resume it, or press DISCARD RECORD in its resume dialog, then switch.'
    : machine.stateName.value === 'alarm' ? 'The controller takes a work offset once the alarm is cleared: HOME or UNLOCK.'
    : null;
  return (
    <div class="fs-popup-body fs-wcspick">
      <div class="fs-card-head">
        <span class="fs-dim">{why ?? 'Tap one to make it active. The chip shows what the controller reports.'}</span>
        <button type="button" class="fs-btn fs-btn-sm" onClick={() => { ui.popup.value = 'offsets'; }}>EDIT OFFSETS</button>
      </div>
      <div class="fs-wcspick-list" role="listbox" aria-label="Work offset">
        {WCS_ENTRIES.filter(e => e.id).map(e => {
          const o = offsets[e.code];
          const on = e.code === active;
          return (
            <button type="button" role="option" aria-selected={on ? 'true' : 'false'} class={'fs-wcspick-row' + (on ? ' is-on' : '')} disabled={!!why}
              onClick={() => { sendCmd('G21 ' + e.code); }}>
              <span class="fs-wcspick-code">{e.code}</span>
              <span class="fs-wcspick-what">{on ? 'ACTIVE' : e.code === 'G59.3' ? 'the toolsetter\'s place' : ''}</span>
              {o ? <span class="fs-wcspick-vals fs-mono">X {fix3(o.x)}  Y {fix3(o.y)}  Z {fix3(o.z)}</span>
                : <span class="fs-wcspick-vals fs-dim">{!linked ? '' : read ? 'not in $#' : offsetsWaitForHoming() ? 'read after homing' : 'not read yet'}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

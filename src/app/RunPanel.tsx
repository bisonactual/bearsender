// The job screen's Run tab: coolant and the overrides, which AUTO shows while a job runs
//
// Everything here is a real-time byte (command.realtime): it goes to the controller at once and never
// between a job's lines. What is lit is what the status report says (A: and Ov:), not what was pressed.
//
// grblHAL (protocol.c, protocol_execute_realtime; grbl.h):
//   - the coolant toggles, 0xA1 mist and 0xA0 flood, are taken only when idle, running or held, and only
//     for a coolant the board has;
//   - feed and spindle go from 10% to 200%, in steps of 10 and 1, and back to 100%;
//   - rapid goes to 100%, 50% (0x96) or its low (0x97), RAPID_OVERRIDE_LOW in the firmware: 25% unless
//     the firmware was built with 10;
//   - the override queue holds 15 bytes, so feed 10% is a reset to 100% then nine steps of −10%.

import type { ComponentChildren } from 'preact';
import * as connection from '../stores/connection';
import * as machine from '../stores/machine';
import * as options from '../stores/options';
import { rtSend } from '../connection';

const num = (v: number) => v.toLocaleString('en-GB', { maximumFractionDigits: 0 });

function send(bytes: string): void { for (const b of bytes) rtSend(b); }

function Coolant() {
  const linked = connection.connected.value;
  const kind = options.coolant.value;
  const a = machine.accessories.value;
  const on = a !== null && a.includes(kind === 'mist' ? 'M' : 'F');
  const other = a !== null && a.includes(kind === 'mist' ? 'F' : 'M');
  const s = machine.stateName.value;
  const takes = s === 'idle' || s === 'run' || s === 'hold';
  const name = kind === 'mist' ? 'MIST' : 'FLOOD';
  const note = !linked ? 'Not connected.'
    : !takes ? 'The controller takes the coolant toggle only when idle, running or held.'
    : a === null ? 'Not reported yet.'
    : (on ? 'On' : 'Off') + ', as the controller reports it.' + (other ? (kind === 'mist' ? ' Flood' : ' Mist') + ' is on too.' : '');
  return (
    <div class="fs-runrow">
      <div class="fs-run-head">
        <span class="fs-cap">COOLANT</span>
        <span class="fs-dim fs-small">{name} ({kind === 'mist' ? 'M7' : 'M8'}): Settings, Options picks mist or flood</span>
      </div>
      <div class="fs-run-ovr">
        <button type="button" class={'fs-btn fs-cool' + (on ? ' is-go' : '')} aria-pressed={on ? 'true' : 'false'} disabled={!linked || !takes}
          onClick={() => send(kind === 'mist' ? '\xA1' : '\xA0')}>{name} {on ? 'ON' : 'OFF'}</button>
        <span class="fs-note-sm">{note}</span>
      </div>
    </div>
  );
}

interface Btn { label: string; bytes: string; aria: string; lit?: boolean; }

function OverrideRow({ label, pct, reading, buttons, note }: { label: string; pct: number; reading?: ComponentChildren; buttons: Btn[]; note?: string | null }) {
  const off = !connection.connected.value;
  return (
    <div class="fs-runrow">
      <div class="fs-run-head"><span class="fs-cap">{label}</span>{reading}</div>
      <div class="fs-run-ovr">
        <span class="fs-run-pct fs-mono">{pct}%</span>
        <div class="fs-run-btns">
          {buttons.map(b => (
            <button type="button" class={'fs-btn fs-run-step' + (b.lit ? ' is-on' : '')} disabled={off} aria-label={b.aria} onClick={() => send(b.bytes)}>{b.label}</button>
          ))}
        </div>
      </div>
      {note && <div class="fs-note-sm is-warn">{note}</div>}
    </div>
  );
}

export function RunPanel() {
  const ov = machine.overrides.value;
  const reading = (v: number, unit: string) => <span><span class="fs-run-read fs-mono">{num(v)}</span> <span class="fs-unit">{unit}</span></span>;
  // The low rapid is RAPID_OVERRIDE_LOW in the firmware: say so when it gives something other than 10%.
  const low = ov.rapid !== 100 && ov.rapid !== 50;
  const rapidNote = low && ov.rapid !== 10 ? `${ov.rapid}%, not 10%: the controller's lowest rapid until its firmware is rebuilt with RAPID_OVERRIDE_LOW at 10.` : null;
  return (
    <div class="fs-run-panel">
      <Coolant />
      <OverrideRow label="FEED" pct={ov.feed} reading={reading(machine.feed.value, 'mm/min')} buttons={[
        { label: '10%', bytes: '\x90' + '\x92'.repeat(9), aria: 'Feed override to 10%', lit: ov.feed === 10 },
        { label: '−10', bytes: '\x92', aria: 'Feed override down 10%' },
        { label: '−1', bytes: '\x94', aria: 'Feed override down 1%' },
        { label: '100%', bytes: '\x90', aria: 'Feed override to 100%', lit: ov.feed === 100 },
        { label: '+1', bytes: '\x93', aria: 'Feed override up 1%' },
        { label: '+10', bytes: '\x91', aria: 'Feed override up 10%' },
      ]} />
      <OverrideRow label="RAPID" pct={ov.rapid} buttons={[
        { label: '10%', bytes: '\x97', aria: 'Rapid override to its lowest, 10% once the firmware is rebuilt', lit: low },
        { label: '50%', bytes: '\x96', aria: 'Rapid override to 50%', lit: ov.rapid === 50 },
        { label: '100%', bytes: '\x95', aria: 'Rapid override to 100%', lit: ov.rapid === 100 },
      ]} note={rapidNote} />
      <OverrideRow label="SPINDLE" pct={ov.spindle} reading={reading(machine.spindle.value, 'rpm')} buttons={[
        { label: '−10', bytes: '\x9B', aria: 'Spindle override down 10%' },
        { label: '−1', bytes: '\x9D', aria: 'Spindle override down 1%' },
        { label: '100%', bytes: '\x99', aria: 'Spindle override to 100%', lit: ov.spindle === 100 },
        { label: '+1', bytes: '\x9C', aria: 'Spindle override up 1%' },
        { label: '+10', bytes: '\x9A', aria: 'Spindle override up 10%' },
      ]} />
    </div>
  );
}

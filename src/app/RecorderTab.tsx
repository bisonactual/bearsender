// ═══════════════════════════════════════════════
// Settings, Flight recorder: switching it on, this job, and the plugin's own settings ($790-$793)
// ═══════════════════════════════════════════════
//
// The record and the event log are on the job screen, in the Recorder panel. Its SETTINGS button opens
// this tab in a popup.

import { useState } from 'preact/hooks';
import * as connection from '../stores/connection';
import * as machine from '../stores/machine';
import * as flight from '../stores/flight';
import { frSetEnabled, frRefresh, frSetUndercut, frWriteSetting } from '../flight-recorder';

interface SettingRow { id: number; name: string; unit: string; help: string; kind: 'bool' | 'number'; }

const SETTINGS: SettingRow[] = [
  { id: 790, name: 'Retract when the sender is lost', unit: '', kind: 'bool',
    help: 'Lift the tool straight up and stop the spindle if the sender goes quiet with the spindle on.' },
  { id: 791, name: 'Sender lost after', unit: 's', kind: 'number',
    help: 'How long the machine can sit with nothing to do and the spindle on before it retracts. Dwells don\'t count.' },
  { id: 792, name: 'Retract to', unit: 'mm below machine zero', kind: 'number',
    help: 'Machine Z, measured down from the top of the axis (never from work zero).' },
  { id: 793, name: 'Watchdog', unit: 's', kind: 'number',
    help: 'Resets the controller, which stops the spindle, if it hangs for this long. 3 to 10, 0 is off. Takes effect at the next restart.' },
];

function NumberSetting({ row, value, live }: { row: SettingRow; value: string; live: boolean }) {
  const [typed, setTyped] = useState<string | null>(null);
  const write = (raw: string) => { const v = raw.trim(); if (v !== '') frWriteSetting(row.id, v); setTyped(null); };
  return (
    <div class="fs-fr-input">
      <input type="number" step="any" class="fs-in fs-mono" aria-label={row.name} value={typed ?? value} disabled={!live}
        onInput={e => setTyped((e.target as HTMLInputElement).value)} onKeyDown={e => { if (e.key === 'Enter') write((e.target as HTMLInputElement).value); }} />
      <span class="fs-dim">{row.unit}</span>
      <button type="button" class={'fs-btn fs-btn-xs' + (typed !== null && typed !== value ? ' is-accent' : '')} disabled={!live} onClick={() => write(typed ?? value)}>WRITE</button>
    </div>
  );
}

export function RecorderTab() {
  const linked = connection.connected.value;
  const plugin = flight.plugin.value;
  const on = flight.enabled.value;
  const live = linked && !!plugin && plugin.storage;
  const values = machine.settings.value;
  const badge = !linked ? 'NOT CONNECTED' : !plugin ? 'NO PLUGIN FOUND' : !plugin.storage ? 'NO FRAM ON THE BOARD' : 'PLUGIN v' + plugin.version;
  return (
    <div class="fs-tools">
      <div class="fs-card-head">
        <span class="fs-zone-state">
          <span class={'fs-tt-pill' + (live ? ' is-go' : '')}>{badge}</span>
          <span class="fs-dim">{on ? 'On in BearSender: jobs are stamped and numbered.' : 'Off in BearSender: jobs go as they are.'}</span>
        </span>
        <div class="fs-head-end">
          <button type="button" class={'fs-btn fs-btn-sm' + (on ? ' is-go' : '')} title="Switch the flight recorder on or off" aria-pressed={on ? 'true' : 'false'}
            onClick={() => frSetEnabled(!on)}>{on ? 'ON' : 'OFF'}</button>
          <button type="button" class="fs-btn fs-btn-sm" disabled={!live} onClick={() => frRefresh()}>REFRESH</button>
        </div>
      </div>
      {!(plugin && plugin.storage) && <div class="fs-pstatus">Needs the Flight Recorder plugin for grblHAL on the controller (the Flexi-HAL A7 _FR firmware, with FRAM at U27).</div>}
      <div class="fs-fr-cards">
        <section class="fs-card fs-mcard" aria-label="This job">
          <h2 class="fs-h">THIS JOB</h2>
          <label class="fs-opt-check"><input type="checkbox" checked={flight.undercut.value} onChange={e => frSetUndercut((e.target as HTMLInputElement).checked)} />Uses undercut tools</label>
          <div class="fs-note">T-slot, dovetail, lollipop and the like can't come straight up out of the cut. Tick this and the controller won't lift the tool if the connection drops. The machine stops where it is and the spindle keeps running until you stop it, so stay with the machine.</div>
        </section>
        <section class="fs-card fs-mcard fs-fr-settings" aria-label="Controller settings">
          <h2 class="fs-h">CONTROLLER SETTINGS</h2>
          {live ? (
            <>
              {SETTINGS.filter(s => s.id !== 793 || flight.watchdog.value).map(s => (
                <div class="fs-fr-setting">
                  <div class="fs-gs-name">{s.name} <span class="fs-dim fs-mono">${s.id}</span></div>
                  <div class="fs-note">{s.help}</div>
                  {s.kind === 'bool'
                    ? <label class="fs-opt-check"><input type="checkbox" checked={values[s.id] === '1'} onChange={e => frWriteSetting(s.id, (e.target as HTMLInputElement).checked ? '1' : '0')} />On</label>
                    : <NumberSetting row={s} value={values[s.id] ?? ''} live={live} />}
                </div>
              ))}
              {flight.watchdog.value === false && <div class="fs-note">This firmware has no watchdog. The _FR_WD builds have it.</div>}
            </>
          ) : <div class="fs-empty-sm">Connect to a controller with the plugin to change these.</div>}
        </section>
      </div>
    </div>
  );
}

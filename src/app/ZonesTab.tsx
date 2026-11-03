// ═══════════════════════════════════════════════
// Settings, Exclusion zones: the plugin's zones and the ATCi travel
// ═══════════════════════════════════════════════

import { useEffect, useState } from 'preact/hooks';
import * as connection from '../stores/connection';
import * as ez from '../exclusion-zones';
import type { EzZone } from '../exclusion-zones';
import { optGetBearColor } from '../options';

/** The zones' state, as the status report's EZ field gives it. */
function badge(): [string, string] {
  if (!ez.plugin.value) return ['—', ''];
  if (!ez.enabled.value) return ['OFF', ''];
  if (ez.inside.value) return ez.isInsideBlockingZone() ? ['IN A ZONE', 'is-stop'] : ['APPROACHING', 'is-warn'];
  return ['ACTIVE', 'is-go'];
}

function Blocks({ flags }: { flags: number }) {
  const b = ez.blocked(flags);
  if (b === 'off') return <span class="fs-dim">off</span>;
  if (!b.length) return <span class="fs-go-text">ok</span>;
  return <span class="fs-stop-text">{b.join(' ')}</span>;
}

type Form = { slot: number; title: string; v: Record<'xmin' | 'ymin' | 'zmin' | 'xmax' | 'ymax' | 'zmax', string>; en: boolean; gcode: boolean; jog: boolean; tool: boolean };

function formFor(z?: EzZone): Form {
  const s = (n: number) => String(n);
  return z
    ? { slot: z.slot, title: 'EDIT ZONE ' + z.slot, v: { xmin: s(z.xmin), ymin: s(z.ymin), zmin: s(z.zmin), xmax: s(z.xmax), ymax: s(z.ymax), zmax: s(z.zmax) },
        en: ez.flagEnabled(z.flags), gcode: ez.flagAllowGcode(z.flags), jog: ez.flagAllowJog(z.flags), tool: ez.flagAllowToolchg(z.flags) }
    : { slot: ez.nextFreeSlot(), title: 'NEW ZONE', v: { xmin: '0', ymin: '0', zmin: '0', xmax: '0', ymax: '0', zmax: '0' }, en: true, gcode: false, jog: false, tool: false };
}

function ZoneForm({ form, set, close }: { form: Form; set: (f: Form) => void; close: () => void }) {
  const num = (k: keyof Form['v']) => (
    <input type="number" step="0.01" class="fs-in fs-mono" aria-label={k} value={form.v[k]}
      onInput={e => set({ ...form, v: { ...form.v, [k]: (e.target as HTMLInputElement).value } })} />
  );
  const flag = (k: 'en' | 'gcode' | 'jog' | 'tool', label: string) => (
    <label class="fs-opt-check"><input type="checkbox" checked={form[k]} onChange={e => set({ ...form, [k]: (e.target as HTMLInputElement).checked })} />{label}</label>
  );
  const save = () => {
    const f = (k: keyof Form['v']) => parseFloat(form.v[k]);
    const flags = (form.en ? ez.FLAG_ENABLED : 0) | (form.gcode ? ez.FLAG_GCODE : 0) | (form.jog ? ez.FLAG_JOG : 0) | (form.tool ? ez.FLAG_TOOLCHG : 0);
    ez.ezSaveZone({ slot: form.slot, xmin: f('xmin'), ymin: f('ymin'), zmin: f('zmin'), xmax: f('xmax'), ymax: f('ymax'), zmax: f('zmax'), flags });
    close();
  };
  return (
    <section class="fs-card fs-mcard fs-zone-form" aria-label={form.title}>
      <h2 class="fs-h">{form.title}</h2>
      <div class="fs-zone-axes">
        {(['x', 'y', 'z'] as const).map(a => (
          <div class="fs-zone-axis"><b>{a.toUpperCase()}</b>{num((a + 'min') as keyof Form['v'])}<span class="fs-dim">to</span>{num((a + 'max') as keyof Form['v'])}</div>
        ))}
      </div>
      <div class="fs-zone-flags">{flag('en', 'Enabled')}{flag('gcode', 'Allow G-code')}{flag('jog', 'Allow Jog')}{flag('tool', 'Allow Tool Chg')}</div>
      <div class="fs-zone-btns">
        <button type="button" class="fs-btn fs-btn-sm is-accent" disabled={!connection.connected.value} onClick={save}>SAVE</button>
        <button type="button" class="fs-btn fs-btn-sm" onClick={close}>CANCEL</button>
      </div>
    </section>
  );
}

export function ZonesTab() {
  const linked = connection.connected.value;
  const zones = ez.zones.value;
  const atci = ez.atciLimits();
  const [form, setForm] = useState<Form | null>(null);
  const [text, tone] = badge();
  // Read when it shows, as the old tab drew what was read.
  useEffect(() => { if (linked && (ez.plugin.peek() || ez.atci.peek())) ez.ezRefresh(); }, []);
  const plugins = [ez.plugin.value ? 'EZ' : '', ez.atci.value ? 'ATCi' : ''].filter(Boolean).join(' + ');
  return (
    <div class="fs-tools">
      <div class="fs-card-head">
        <span class="fs-zone-state">
          <span class={'fs-tt-pill ' + tone}>{text}</span>
          <span class="fs-dim">{linked ? (plugins ? 'Plugin: ' + plugins : 'No zone plugin found') : 'Not connected'}</span>
        </span>
        <div class="fs-head-end">
          <button type="button" class="fs-btn fs-btn-sm" disabled={!linked || !ez.plugin.value} title="Switch the zones on or off ($EXCLUSION)"
            onClick={() => ez.ezToggle()}>{ez.enabled.value ? 'DISABLE' : 'ENABLE'}</button>
          <button type="button" class="fs-btn fs-btn-sm" title="The zones' labels in the 3D view" onClick={() => ez.toggleShowLabels()}>
            {ez.showLabels.value ? 'LABELS ON' : 'LABELS OFF'}</button>
          <button type="button" class="fs-btn fs-btn-sm" disabled={!linked || ez.reading.value} onClick={() => ez.ezRefresh()}>
            {ez.reading.value ? 'READING…' : 'REFRESH'}</button>
        </div>
      </div>
      {!ez.plugin.value && !ez.atci.value && <div class="fs-pstatus">Requires the EZ — Exclusion Zones Plugin to function. Also compatible with the Sienci ATCI Plugin.</div>}
      <div class="fs-offsets-scroll">
        {zones.length || atci ? (
          <table class="fs-table fs-zonetable">
            <thead><tr><th>#</th><th>X MIN</th><th>Y MIN</th><th>Z MIN</th><th>X MAX</th><th>Y MAX</th><th>Z MAX</th><th class="fs-zone-blocks">BLOCKS</th><th /></tr></thead>
            <tbody>
              {atci && (
                <tr class="is-atci">
                  <td class="fs-zone-slot">ATCI</td>
                  <td class="fs-mono">-{atci.xMax}</td><td class="fs-mono">-{atci.yMax}</td><td class="fs-mono">-{atci.zMax}</td>
                  <td class="fs-mono">0</td><td class="fs-mono">0</td><td class="fs-mono">0</td>
                  <td class="fs-zone-blocks fs-dim">TRAVEL ($130-$132)</td><td />
                </tr>
              )}
              {zones.map(z => (
                <tr class={ez.flagEnabled(z.flags) ? '' : 'is-off'}>
                  <td class="fs-zone-slot" style={{ color: optGetBearColor(z.flags) }}>{z.slot}</td>
                  <td class="fs-mono">{z.xmin}</td><td class="fs-mono">{z.ymin}</td><td class="fs-mono">{z.zmin}</td>
                  <td class="fs-mono">{z.xmax}</td><td class="fs-mono">{z.ymax}</td><td class="fs-mono">{z.zmax}</td>
                  <td class="fs-zone-blocks"><Blocks flags={z.flags} /></td>
                  <td class="fs-zone-act"><span class="fs-zone-actbox">
                    <button type="button" class="fs-btn fs-btn-xs" onClick={() => setForm(formFor(z))}>EDIT</button>
                    <button type="button" class="fs-btn fs-btn-xs is-stop" disabled={!linked} onClick={() => ez.ezDeleteZone(z.slot)}>DELETE</button>
                  </span></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <div class="fs-empty-sm fs-pad">{linked ? 'No zones. REFRESH reads them ($ZONE).' : 'Connect, then REFRESH to read the zones.'}</div>}
      </div>
      {form
        ? <ZoneForm form={form} set={setForm} close={() => setForm(null)} />
        : <div><button type="button" class="fs-btn fs-btn-sm" onClick={() => setForm(formFor())}>+ ADD ZONE</button></div>}
    </div>
  );
}

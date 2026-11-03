// The Settings screen: the controller's settings, exclusion zones, options, probe and flight recorder.
// The controller's settings tab is here and the others are in their own files. Each tab is mounted only
// while it shows, so what it reads is read each time it opens.

import { useEffect, useState } from 'preact/hooks';
import * as connection from '../stores/connection';
import * as machine from '../stores/machine';
import * as settings from '../settings';
import type { SettingDef } from '../settings';
import { errorText } from '../errors';
import * as ui from './ui';
import { ZonesTab } from './ZonesTab';
import { OptionsTab } from './OptionsTab';
import { RecorderTab } from './RecorderTab';
import { ProbeSettingsCard } from './ProbeSettings';

// The controller's settings ($ settings)

/** The groups that hold settings, in the controller's tree order, with their depth. */
function groupList(): { id: number; name: string; depth: number }[] {
  const groups = Object.values(settings.groups.value), defs = Object.values(settings.defs.value);
  const out: { id: number; name: string; depth: number }[] = [];
  const add = (parentId: number, depth: number) => {
    groups.filter(g => g.parentId === parentId && g.id !== 0).sort((a, b) => a.name.localeCompare(b.name)).forEach(g => {
      if (defs.some(d => d.groupId === g.id)) out.push({ id: g.id, name: g.name, depth });
      add(g.id, depth + (defs.some(d => d.groupId === g.id) ? 1 : 0));
    });
  };
  add(0, 0);
  if (defs.some(d => d.groupId === 0)) out.push({ id: 0, name: 'Other', depth: 0 });
  return out;
}

function Bits({ def, value, set, mode }: { def: SettingDef; value: string; set: (v: string) => void; mode: 'bits' | 'exclusive' | 'radio' | 'axes' }) {
  const cur = parseInt(value) || 0;
  const labels = mode === 'axes' && !def.formatLabels.length ? machine.axes.value.map(a => a + ' axis') : def.formatLabels;
  return (
    <div class="fs-gs-bits" role={mode === 'radio' ? 'radiogroup' : 'group'} aria-label={def.name}>
      {labels.map((label, bit) => {
        if (label === 'N/A') return null;
        const on = mode === 'radio' ? cur === bit : !!((cur >> bit) & 1);
        // An exclusive bitfield: the first bit switches the feature on, and the others only with it.
        const off = mode === 'exclusive' && bit !== 0 && !(cur & 1);
        const pick = () => {
          if (mode === 'radio') { set(String(bit)); return; }
          let v = on ? cur & ~(1 << bit) : cur | (1 << bit);
          if (mode === 'exclusive' && !(v & 1)) v = 0;
          set(String(v));
        };
        return (
          <label class={off ? 'is-off' : ''}>
            <input type={mode === 'radio' ? 'radio' : 'checkbox'} name={'s' + def.id} checked={on} disabled={off} onChange={pick} />{label}
          </label>
        );
      })}
    </div>
  );
}

function Widget({ def, value }: { def: SettingDef; value: string }) {
  const set = (v: string) => settings.markDirty(def.id, v);
  if (def.dtype === 0) {
    return (
      <div role="radiogroup" aria-label={def.name} class="fs-seg fs-seg-sm">
        {(['1', '0'] as const).map(v => (
          <button type="button" role="radio" aria-checked={(value === '1') === (v === '1') ? 'true' : 'false'}
            class={(value === '1') === (v === '1') ? 'is-on' : ''} onClick={() => set(v)}>{v === '1' ? 'ON' : 'OFF'}</button>
        ))}
      </div>
    );
  }
  if (def.dtype === 1) return <Bits def={def} value={value} set={set} mode="bits" />;
  if (def.dtype === 2) return <Bits def={def} value={value} set={set} mode="exclusive" />;
  if (def.dtype === 3) return <Bits def={def} value={value} set={set} mode="radio" />;
  if (def.dtype === 4) return <Bits def={def} value={value} set={set} mode="axes" />;
  const placeholder = def.dtype === 9 ? '0.0.0.0' : def.dtype === 6 ? 'decimal' : def.dtype === 5 ? 'integer' : '';
  return (
    <input type={(def.dtype === 8 ? 'password' : 'text') as 'text'} class="fs-in fs-mono" aria-label={def.name} value={value} placeholder={placeholder}
      onInput={e => set((e.target as HTMLInputElement).value)}
      onKeyDown={e => { if (e.key === 'Enter') settings.writeSetting(def.id); }} />
  );
}

function SettingRow({ def }: { def: SettingDef }) {
  const stored = machine.settings.value[def.id] ?? '';
  const dirty = settings.dirty.value[def.id];
  const w = settings.writes.value[def.id];
  const linked = connection.connected.value;
  const label = w === 'pending' ? 'WRITING…' : w === 'ok' ? 'SAVED ✓' : typeof w === 'number' ? 'ERR: ' + w : 'WRITE $' + def.id;
  return (
    <div class={'fs-gs-row' + (dirty !== undefined ? ' is-dirty' : '')}>
      <div class="fs-gs-meta">
        <div class="fs-gs-name">{def.name}</div>
        <div class="fs-gs-id">${def.id}{def.unit ? ' · ' + def.unit : ''}{def.reboot ? ' · ⟳ reboot' : ''}</div>
        {def.description && <div class="fs-gs-desc">{def.description.replace(/\\n/g, '\n')}</div>}
        {(def.minV || def.maxV) && <div class="fs-gs-id">Range: {def.minV || '-'} … {def.maxV || '∞'}</div>}
      </div>
      <div class="fs-gs-ctrl">
        <Widget def={def} value={dirty ?? stored} />
        <button type="button" disabled={!linked || w === 'pending'} title={typeof w === 'number' ? errorText(w) : undefined}
          class={'fs-btn fs-btn-sm fs-gs-write' + (w === 'ok' ? ' is-go' : typeof w === 'number' ? ' is-stop' : dirty !== undefined ? ' is-accent' : '')}
          onClick={() => settings.writeSetting(def.id)}>{label}</button>
      </div>
    </div>
  );
}

function GrblSettings() {
  const linked = connection.connected.value;
  const loaded = settings.loaded.value;
  const defs = settings.defs.value;
  const groups = groupList();
  const [picked, setPicked] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  // Read when it shows, if not read since connecting.
  useEffect(() => { if (linked && !settings.loaded.peek()) settings.loadSettings(); }, []);
  const group = picked !== null && groups.some(g => g.id === picked) ? picked : groups[0]?.id ?? null;
  const q = query.trim().toLowerCase();
  const shown = Object.values(defs)
    .filter(d => q ? d.name.toLowerCase().includes(q) || String(d.id).includes(q) || d.description.toLowerCase().includes(q) : d.groupId === group)
    .sort((a, b) => a.id - b.id);
  const count = Object.keys(defs).length;
  const changed = Object.keys(settings.dirty.value).length;
  const status = settings.readNote.value
    ?? (count ? `${count} settings · ${Object.values(defs).filter(d => d.description).length} with descriptions` + (loaded ? '' : ' · read from the last controller')
      : linked ? 'Not read yet. READ FROM CONTROLLER reads them ($EG, $ESH, $ES, $$).' : 'Not connected. Connect, then READ FROM CONTROLLER.');
  const head = q ? 'SEARCH RESULTS' : group === null ? '' : (group === 0 ? 'OTHER' : settings.groups.value[group]?.name.toUpperCase() ?? 'GROUP ' + group);
  return (
    <div class="fs-gs">
      <div class="fs-gs-bar">
        <button type="button" class="fs-btn fs-btn-sm" disabled={!linked || settings.isReading.value} onClick={() => settings.loadSettings()}>
          {settings.isReading.value ? 'READING…' : 'READ FROM CONTROLLER'}
        </button>
        <button type="button" class={'fs-btn fs-btn-sm' + (changed ? ' is-accent' : '')} disabled={!linked || !changed} onClick={() => settings.writeAllDirty()}>
          WRITE ALL CHANGES{changed ? ' (' + changed + ')' : ''}
        </button>
        <input type="search" class="fs-in fs-gs-search" placeholder="Search settings…" aria-label="Search settings" value={query}
          onInput={e => setQuery((e.target as HTMLInputElement).value)} />
        <span class="fs-dim fs-gs-status">{status}</span>
      </div>
      {count ? (
        <div class="fs-gs-body">
          <nav class="fs-gs-groups" aria-label="Setting groups">
            {groups.map(g => (
              <button type="button" class={'fs-gs-group' + (!q && g.id === group ? ' is-on' : '')} style={{ paddingLeft: 10 + g.depth * 12 + 'px' }}
                onClick={() => { setPicked(g.id); setQuery(''); }}>{g.name}</button>
            ))}
          </nav>
          <div class="fs-gs-list">
            <div class="fs-gs-head">{head}</div>
            {shown.length ? shown.map(d => <SettingRow key={d.id} def={d} />) : <div class="fs-empty-sm fs-pad">No settings.</div>}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// The screen

const SETTINGS_TABS: [ui.SettingsTab, string][] = [
  ['grbl', 'GRBL SETTINGS'], ['zones', 'EXCLUSION ZONES'], ['options', 'OPTIONS'], ['probe', 'PROBE'], ['flight', 'FLIGHT RECORDER'],
];

export function SettingsScreen() {
  if (ui.screen.value !== 'settings') return null;
  const tab = ui.settingsTab.value;
  return (
    <section class="fs-screen">
      <div role="tablist" class="fs-subtabs">
        {SETTINGS_TABS.map(([id, label]) => (
          <button type="button" role="tab" aria-selected={tab === id ? 'true' : 'false'} class={tab === id ? 'is-on' : ''}
            onClick={() => { ui.settingsTab.value = id; }}>{label}</button>
        ))}
      </div>
      {tab === 'grbl' ? <GrblSettings />
        : tab === 'zones' ? <div class="fs-sub fs-pad"><ZonesTab /></div>
        : tab === 'options' ? <OptionsTab />
        : tab === 'probe' ? <div class="fs-setup"><div class="fs-col fs-col-probe"><ProbeSettingsCard /></div></div>
        : <div class="fs-sub fs-pad"><RecorderTab /></div>}
    </section>
  );
}

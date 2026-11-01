// ═══════════════════════════════════════════════
// Settings engine — load sequence
// ═══════════════════════════════════════════════

import { state, DTYPE_MAP } from './state';
import { log } from './console';
import * as command from './command';
import { renderSettingsUI } from './settings-render';
import * as machine from './stores/machine';

/** Reads the groups ($EG), the definitions ($ESH, $ES) and the values ($$), then shows them. */
export async function loadSettings(): Promise<void> {
  if (!state.connected) { log('info', 'Connect first'); return; }
  state.settingsGroups = {};
  state.settingsDefs = {};
  state.settingsValues = {};
  state.settingsDirty = {};
  state.activeGroupId = null;
  state.settingsLoaded = false;
  const status = document.getElementById('settingsStatus')!;
  status.textContent = 'Reading groups…';
  document.getElementById('settingsGroups')!.innerHTML =
    '<div class="settings-placeholder" style="height:200px"><div class="settings-placeholder-icon">↻</div><div>Loading…</div></div>';
  document.getElementById('settingsContent')!.innerHTML = '';
  try {
    readGroups((await command.send('$EG')).lines);
    status.textContent = 'Reading setting definitions…';
    readHalDefs((await command.send('$ESH')).lines);
    readDefs((await command.send('$ES')).lines);
    status.textContent = 'Reading current values…';
    readValues((await command.send('$$')).lines);
  } catch (e) {
    if (!(e instanceof command.CommandFailed)) throw e;
    status.textContent = 'The settings could not be read: ' + e.why;
    return;
  }
  state.settingsLoaded = true;
  renderSettingsUI();
}

// [SETTINGGROUP:id|parent|name]
function readGroups(lines: string[]): void {
  for (const raw of lines) {
    if (!raw.startsWith('[SETTINGGROUP:')) continue;
    const p = raw.slice(14, -1).split('|');
    if (p.length >= 3) {
      const id = parseInt(p[0]), parentId = parseInt(p[1]), name = p[2];
      state.settingsGroups[id] = { id, parentId, name };
    }
  }
}

// $ESH: id, name, unit, type, format, description, min, max, tab-separated
function readHalDefs(lines: string[]): void {
  for (const raw of lines) {
    if (!/^\d+\t/.test(raw)) continue;
    const p = raw.split('\t');
    if (p.length < 4) continue;
    const id = parseInt(p[0]);
    const name = p[1] || ('$' + id);
    const unit = p[2] || '';
    const dtypeStr = (p[3] || 'string').toLowerCase();
    const fmt = p[4] || '';
    const description = p[5] || '';
    const minV = p[6] || '';
    const maxV = p[7] || '';
    const dtype = DTYPE_MAP[dtypeStr] !== undefined ? DTYPE_MAP[dtypeStr] : 7;
    const formatLabels = (dtype >= 1 && dtype <= 3 && fmt) ? fmt.split(',') : [];
    state.settingsDefs[id] = { id, groupId: 0, name, unit, dtype, dtypeStr, fmt, formatLabels, description, minV, maxV, reboot: false, nullOk: false };
  }
}

// $ES: [SETTING:id|group|name|unit|type|format|min|max|reboot|null ok], for the group of each
function readDefs(lines: string[]): void {
  for (const raw of lines) {
    if (!raw.startsWith('[SETTING:')) continue;
    const p = raw.slice(9, -1).split('|');
    if (p.length < 2) continue;
    const id = parseInt(p[0]), groupId = parseInt(p[1]);
    const reboot = p[8] === '1', nullOk = p[9] === '1';
    if (state.settingsDefs[id]) {
      state.settingsDefs[id].groupId = groupId;
      state.settingsDefs[id].reboot = reboot;
      state.settingsDefs[id].nullOk = nullOk;
    } else {
      const name = p[2] || ('$' + id), unit = p[3] || '';
      const dtype = parseInt(p[4]) || 7;
      const fmt = p[5] || '', minV = p[6] || '', maxV = p[7] || '';
      const formatLabels = (dtype >= 1 && dtype <= 3 && fmt) ? fmt.split(',') : [];
      state.settingsDefs[id] = { id, groupId, name, unit, dtype, dtypeStr: '', fmt, formatLabels, description: '', minV, maxV, reboot, nullOk };
    }
  }
}

// $$: $id=value
function readValues(lines: string[]): void {
  for (const raw of lines) {
    if (!/^\$\d+=/.test(raw)) continue;
    const eq = raw.indexOf('=');
    state.settingsValues[parseInt(raw.slice(1, eq))] = raw.slice(eq + 1);
  }
  machine.settings.value = { ...state.settingsValues };
}

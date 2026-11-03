// ═══════════════════════════════════════════════
// Settings engine — load sequence
// ═══════════════════════════════════════════════
//
// The groups ($EG), the definitions with their descriptions ($ESH, $ES) and the values ($$), into
// signals for the Settings screen and the console's autocomplete. The values go to the machine store.

import { signal, batch } from '@preact/signals';
import { state, DTYPE_MAP } from './state';
import { log } from './console';
import * as command from './command';
import * as machine from './stores/machine';
import * as connection from './stores/connection';

export interface SettingGroup { id: number; parentId: number; name: string; }
/** dtype: 0 bool, 1 bitfield, 2 exclusive bitfield, 3 radio, 4 axis mask, 5 integer, 6 decimal, 7 string, 8 password, 9 IPv4. */
export interface SettingDef {
  id: number; groupId: number; name: string; unit: string; dtype: number; dtypeStr: string; fmt: string;
  formatLabels: string[]; description: string; minV: string; maxV: string; reboot: boolean; nullOk: boolean;
}

export const groups = signal<Record<number, SettingGroup>>({});
export const defs = signal<Record<number, SettingDef>>({});
/** A read is under way. */
export const reading = signal(false);
/** What the last read did: the step it is on, why it failed, or null once read. */
export const readNote = signal<string | null>(null);
/** The definitions and values have been read since connecting. */
export const loaded = signal(false);

/** Reads the groups ($EG), the definitions ($ESH, $ES) and the values ($$). */
export async function loadSettings(): Promise<void> {
  if (!connection.connected.value) { log('info', 'Connect first'); return; }
  if (reading.value) return;
  const g: Record<number, SettingGroup> = {}, d: Record<number, SettingDef> = {}, v: Record<number, string> = {};
  reading.value = true;
  try {
    readNote.value = 'Reading groups…';
    readGroups((await command.send('$EG')).lines, g);
    readNote.value = 'Reading setting definitions…';
    readHalDefs((await command.send('$ESH')).lines, d);
    readDefs((await command.send('$ES')).lines, d);
    readNote.value = 'Reading current values…';
    readValues((await command.send('$$')).lines, v);
  } catch (e) {
    if (!(e instanceof command.CommandFailed)) throw e;
    readNote.value = 'The settings could not be read: ' + e.why;
    reading.value = false;
    return;
  }
  state.settingsValues = { ...state.settingsValues, ...v };
  batch(() => {
    groups.value = g;
    defs.value = d;
    machine.settings.value = { ...state.settingsValues };
    loaded.value = true;
    readNote.value = null;
    reading.value = false;
  });
}

/** Forgets the definitions on disconnecting; they are read again from the next controller. */
export function forgetSettings(): void {
  batch(() => { loaded.value = false; readNote.value = null; });
}

// [SETTINGGROUP:id|parent|name]
function readGroups(lines: string[], out: Record<number, SettingGroup>): void {
  for (const raw of lines) {
    if (!raw.startsWith('[SETTINGGROUP:')) continue;
    const p = raw.slice(14, -1).split('|');
    if (p.length >= 3) {
      const id = parseInt(p[0]), parentId = parseInt(p[1]), name = p[2];
      out[id] = { id, parentId, name };
    }
  }
}

// $ESH: id, name, unit, type, format, description, min, max, tab-separated
function readHalDefs(lines: string[], out: Record<number, SettingDef>): void {
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
    out[id] = { id, groupId: 0, name, unit, dtype, dtypeStr, fmt, formatLabels, description, minV, maxV, reboot: false, nullOk: false };
  }
}

// $ES: [SETTING:id|group|name|unit|type|format|min|max|reboot|null ok], for the group of each
function readDefs(lines: string[], out: Record<number, SettingDef>): void {
  for (const raw of lines) {
    if (!raw.startsWith('[SETTING:')) continue;
    const p = raw.slice(9, -1).split('|');
    if (p.length < 2) continue;
    const id = parseInt(p[0]), groupId = parseInt(p[1]);
    const reboot = p[8] === '1', nullOk = p[9] === '1';
    if (out[id]) {
      out[id].groupId = groupId;
      out[id].reboot = reboot;
      out[id].nullOk = nullOk;
    } else {
      const name = p[2] || ('$' + id), unit = p[3] || '';
      const dtype = parseInt(p[4]) || 7;
      const fmt = p[5] || '', minV = p[6] || '', maxV = p[7] || '';
      const formatLabels = (dtype >= 1 && dtype <= 3 && fmt) ? fmt.split(',') : [];
      out[id] = { id, groupId, name, unit, dtype, dtypeStr: '', fmt, formatLabels, description: '', minV, maxV, reboot, nullOk };
    }
  }
}

// $$: $id=value
function readValues(lines: string[], out: Record<number, string>): void {
  for (const raw of lines) {
    if (!/^\$\d+=/.test(raw)) continue;
    const eq = raw.indexOf('=');
    out[parseInt(raw.slice(1, eq))] = raw.slice(eq + 1);
  }
}

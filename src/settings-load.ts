// Reads the controller's $ settings: the groups ($EG), the definitions with their descriptions ($ESH,
// $ES) and the values ($$), for the Settings screen and the console's autocomplete. The values go to
// the machine store.

import { signal, batch } from '@preact/signals';
import { log } from './console';
import * as command from './command';
import * as machine from './stores/machine';
import * as connection from './stores/connection';

// $ESH's type names, as the dtype numbers $ES uses.
const DTYPE_BY_NAME: Record<string, number> = {
  'bool': 0, 'boolean': 0, 'bitfield': 1, 'xbitfield': 2, 'radiobuttons': 3, 'radio': 3, 'axismask': 4,
  'integer': 5, 'int': 5, 'float': 6, 'decimal': 6, 'string': 7, 'text': 7, 'password': 8, 'ipv4': 9,
};

export interface SettingGroup { id: number; parentId: number; name: string; }
/** dtype: 0 bool, 1 bitfield, 2 exclusive bitfield, 3 radio, 4 axis mask, 5 integer, 6 decimal, 7 string, 8 password, 9 IPv4. */
export interface SettingDef {
  id: number; groupId: number; name: string; unit: string; dtype: number; dtypeStr: string; fmt: string;
  formatLabels: string[]; description: string; minV: string; maxV: string; reboot: boolean; nullOk: boolean;
}

export const groups = signal<Record<number, SettingGroup>>({});
export const defs = signal<Record<number, SettingDef>>({});
/** A read is under way. */
export const isReading = signal(false);
/** What the last read did: the step it is on, why it failed, or null once read. */
export const readNote = signal<string | null>(null);
/** The definitions and values have been read since connecting. */
export const loaded = signal(false);

/** Reads the groups ($EG), the definitions ($ESH, $ES) and the values ($$). */
export async function loadSettings(): Promise<void> {
  if (!connection.connected.value) { log('info', 'Connect first'); return; }
  if (isReading.value) return;
  const newGroups: Record<number, SettingGroup> = {}, newDefs: Record<number, SettingDef> = {}, newValues: Record<number, string> = {};
  isReading.value = true;
  try {
    readNote.value = 'Reading groups…';
    readGroups((await command.send('$EG')).lines, newGroups);
    readNote.value = 'Reading setting definitions…';
    readHalDefs((await command.send('$ESH')).lines, newDefs);
    readDefs((await command.send('$ES')).lines, newDefs);
    readNote.value = 'Reading current values…';
    readValues((await command.send('$$')).lines, newValues);
  } catch (e) {
    if (!(e instanceof command.CommandFailed)) throw e;
    readNote.value = 'The settings could not be read: ' + e.why;
    isReading.value = false;
    return;
  }
  batch(() => {
    groups.value = newGroups;
    defs.value = newDefs;
    machine.settings.value = { ...machine.settings.peek(), ...newValues };
    loaded.value = true;
    readNote.value = null;
    isReading.value = false;
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
    const fields = raw.slice(14, -1).split('|');
    if (fields.length >= 3) {
      const id = parseInt(fields[0]), parentId = parseInt(fields[1]), name = fields[2];
      out[id] = { id, parentId, name };
    }
  }
}

// $ESH: id, name, unit, type, format, description, min, max, tab-separated
function readHalDefs(lines: string[], out: Record<number, SettingDef>): void {
  for (const raw of lines) {
    if (!/^\d+\t/.test(raw)) continue;
    const fields = raw.split('\t');
    if (fields.length < 4) continue;
    const id = parseInt(fields[0]);
    const name = fields[1] || ('$' + id);
    const unit = fields[2] || '';
    const dtypeStr = (fields[3] || 'string').toLowerCase();
    const fmt = fields[4] || '';
    const description = fields[5] || '';
    const minV = fields[6] || '';
    const maxV = fields[7] || '';
    const dtype = DTYPE_BY_NAME[dtypeStr] !== undefined ? DTYPE_BY_NAME[dtypeStr] : 7;
    const formatLabels = (dtype >= 1 && dtype <= 3 && fmt) ? fmt.split(',') : [];
    out[id] = { id, groupId: 0, name, unit, dtype, dtypeStr, fmt, formatLabels, description, minV, maxV, reboot: false, nullOk: false };
  }
}

// $ES: [SETTING:id|group|name|unit|type|format|min|max|reboot|null ok], for the group of each
function readDefs(lines: string[], out: Record<number, SettingDef>): void {
  for (const raw of lines) {
    if (!raw.startsWith('[SETTING:')) continue;
    const fields = raw.slice(9, -1).split('|');
    if (fields.length < 2) continue;
    const id = parseInt(fields[0]), groupId = parseInt(fields[1]);
    const reboot = fields[8] === '1', nullOk = fields[9] === '1';
    if (out[id]) {
      out[id].groupId = groupId;
      out[id].reboot = reboot;
      out[id].nullOk = nullOk;
    } else {
      const name = fields[2] || ('$' + id), unit = fields[3] || '';
      const dtype = parseInt(fields[4]) || 7;
      const fmt = fields[5] || '', minV = fields[6] || '', maxV = fields[7] || '';
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

// ═══════════════════════════════════════════════
// Settings engine — dirty tracking & write
// ═══════════════════════════════════════════════

import { state } from './state';
import { log } from './console';
import * as command from './command';
import * as machine from './stores/machine';

export function markDirty(id: number, val: string): void {
  state.settingsDirty[id] = val;
  const row = document.getElementById('srow-' + id);
  if (row) row.classList.add('dirty');
  (document.getElementById('btnWriteAll') as HTMLButtonElement).disabled = false;
}

export async function writeSetting(id: number): Promise<void> {
  if (!state.connected) { log('err', 'Not connected'); return; }
  const val = state.settingsDirty[id] !== undefined ? state.settingsDirty[id] : state.settingsValues[id];
  if (val === undefined) return;
  const btn = document.getElementById('wbtn-' + id);
  if (btn) { btn.className = 'setting-write pending'; btn.textContent = 'WRITING…'; }
  let reply: command.Reply;
  try { reply = await command.send('$' + id + '=' + val, { log: true }); }
  catch (e) {
    if (!(e instanceof command.CommandFailed)) throw e;
    if (btn) { btn.className = 'setting-write'; btn.textContent = 'WRITE $' + id; }
    return;
  }
  if (reply.result === 'error') {
    if (btn) { btn.className = 'setting-write err'; btn.textContent = 'ERR: ' + reply.code; setTimeout(() => { if (btn) { btn.className = 'setting-write'; btn.textContent = 'WRITE $' + id; } }, 3000); }
    return;
  }
  if (state.settingsDirty[id] !== undefined) { state.settingsValues[id] = state.settingsDirty[id]; delete state.settingsDirty[id]; machine.settings.value = { ...state.settingsValues }; }
  const row = document.getElementById('srow-' + id); if (row) row.classList.remove('dirty');
  if (btn) { btn.className = 'setting-write ok'; btn.textContent = 'SAVED ✓'; setTimeout(() => { if (btn) { btn.className = 'setting-write'; btn.textContent = 'WRITE $' + id; } }, 2000); }
}

export function writeAllDirty(): void {
  Object.keys(state.settingsDirty).forEach(id => writeSetting(parseInt(id)));
}

/** Reads one setting ($n) into the store. Resolves with its value, or undefined if it has none. */
export async function readSetting(id: number): Promise<string | undefined> {
  await command.send('$' + id);
  return state.settingsValues[id];
}

// Any reply with $n=value lines in it (a read, $$, one typed in the console) updates the stored values.
command.onReply(reply => {
  let changed = false;
  for (const raw of reply.lines) {
    if (!/^\$\d+=/.test(raw)) continue;
    const eq = raw.indexOf('=');
    state.settingsValues[parseInt(raw.slice(1, eq))] = raw.slice(eq + 1);
    changed = true;
  }
  if (changed) machine.settings.value = { ...state.settingsValues };
});

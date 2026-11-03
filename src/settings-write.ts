// ═══════════════════════════════════════════════
// Settings engine — changes & write
// ═══════════════════════════════════════════════

import { signal } from '@preact/signals';
import { log } from './console';
import * as command from './command';
import * as machine from './stores/machine';
import * as connection from './stores/connection';

/** Values changed on the Settings screen and not written yet, by setting. */
export const dirty = signal<Record<number, string>>({});
/** Each setting's last write: under way, written, or the controller's error code. Cleared after a moment. */
export const writes = signal<Record<number, 'pending' | 'ok' | number>>({});

function setWrite(id: number, s: 'pending' | 'ok' | number | null, clearAfter = 0): void {
  const { [id]: _, ...rest } = writes.value;
  writes.value = s === null ? rest : { ...rest, [id]: s };
  if (clearAfter) setTimeout(() => { if (writes.value[id] === s) setWrite(id, null); }, clearAfter);
}

export function markDirty(id: number, val: string): void {
  if (val === (machine.settings.value[id] ?? '')) { const { [id]: _, ...rest } = dirty.value; dirty.value = rest; }
  else dirty.value = { ...dirty.value, [id]: val };
}

export async function writeSetting(id: number): Promise<void> {
  if (!connection.connected.value) { log('err', 'Not connected'); return; }
  const val = dirty.value[id] ?? machine.settings.value[id];
  if (val === undefined) return;
  setWrite(id, 'pending');
  let reply: command.Reply;
  try { reply = await command.send('$' + id + '=' + val, { log: true }); }
  catch (e) {
    if (!(e instanceof command.CommandFailed)) throw e;
    setWrite(id, null);
    return;
  }
  if (reply.result === 'error') { setWrite(id, reply.code ?? 0, 3000); return; }
  machine.settings.value = { ...machine.settings.peek(), [id]: val };
  if (dirty.value[id] === val) { const { [id]: _, ...rest } = dirty.value; dirty.value = rest; }
  setWrite(id, 'ok', 2000);
}

export function writeAllDirty(): void {
  Object.keys(dirty.value).forEach(id => writeSetting(parseInt(id)));
}

/** Reads one setting ($n) into the store. Resolves with its value, or undefined if it has none. */
export async function readSetting(id: number): Promise<string | undefined> {
  await command.send('$' + id);
  return machine.settings.peek()[id];
}

// Any reply with $n=value lines in it (a read, $$, one typed in the console) updates the stored values.
command.onReply(reply => {
  const got: Record<number, string> = {};
  let changed = false;
  for (const raw of reply.lines) {
    if (!/^\$\d+=/.test(raw)) continue;
    const eq = raw.indexOf('=');
    got[parseInt(raw.slice(1, eq))] = raw.slice(eq + 1);
    changed = true;
  }
  if (changed) machine.settings.value = { ...machine.settings.peek(), ...got };
});

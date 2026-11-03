// ═══════════════════════════════════════════════
// WCS Coordinate Offset Table
// ═══════════════════════════════════════════════

import { log } from './console';
import { sendCmd } from './connection';
import * as command from './command';
import { lsGet, lsSet } from './ui';
import { refreshWcsMarkers } from './viewport';
import { reportMm } from './units';
import * as machine from './stores/machine';
import * as connection from './stores/connection';
import * as job from './stores/job';

// ── Coordinate systems in display order ──────────────────────────────────────

export const WCS_ENTRIES = [
  { code: 'G54',   label: 'G54',   id: 1  },
  { code: 'G55',   label: 'G55',   id: 2  },
  { code: 'G56',   label: 'G56',   id: 3  },
  { code: 'G57',   label: 'G57',   id: 4  },
  { code: 'G58',   label: 'G58',   id: 5  },
  { code: 'G59',   label: 'G59',   id: 6  },
  { code: 'G59.1', label: 'G59.1', id: 7  },
  { code: 'G59.2', label: 'G59.2', id: 8  },
  { code: 'G59.3', label: 'G59.3 — Toolsetter', id: 9 },
  { code: 'G28',   label: 'G28 — Home 1', id: 0 },
  { code: 'G30',   label: 'G30 — Home 2', id: 0 },
  { code: 'TLO',   label: 'TLO — Tool Length Offset', id: 0 },
];

// ── Load / parse ──────────────────────────────────────────────────────────────

const OFFSET_KEYS = new Set(['G54','G55','G56','G57','G58','G59',
  'G59.1','G59.2','G59.3','G28','G28.1','G30','G30.1','G92']);

/** The controller is in an alarm, where it refuses $# (error:9, at every power-up in the homing alarm). */
export function offsetsWaitForHoming(): boolean { return machine.stateName.value === 'alarm'; }

/** Reads the work offsets ($#), and says whether it got them. The [TLO:] line in its reply is a push
 *  message (see below). In an alarm nothing is sent: they are read once the machine is idle, after
 *  homing or an unlock (parser.ts). */
export async function loadOffsets(): Promise<boolean> {
  if (!connection.connected.peek()) { log('err', 'Not connected'); return false; }
  if (machine.stateName.peek() === 'alarm') { log('info', 'Work offsets: read after homing (the controller refuses $# in an alarm).'); return false; }
  let reply: command.Reply;
  try { reply = await command.send('$#'); }
  catch (e) { if (e instanceof command.CommandFailed) return false; throw e; }
  const read: Record<string, machine.Vec3> = {};
  for (const raw of reply.lines) {
    // [G54:x,y,z] [G55:...] [G28:...]; [PRB:] is the last probe's, not an offset
    const m = raw.match(/^\[([A-Z0-9.]+):([^\]]+)\]$/);
    if (!m || !OFFSET_KEYS.has(m[1])) continue;
    const vals = m[2].split(',').map(v => reportMm(Number(v)));
    // Store normalised: x, y, z (pad with 0 if fewer axes reported)
    read[m[1]] = { x: vals[0] ?? 0, y: vals[1] ?? 0, z: vals[2] ?? 0 };
  }
  if (reply.result !== 'ok') return false;
  // The table first, then the flag, so whoever waits for the flag finds the table in.
  setOffsets(read);
  machine.offsetsRead.value = true;
  if (!machine.offsetsAtConnect.value) machine.offsetsAtConnect.value = { ...machine.offsets.peek() };
  _staleAfterReset = false;
  refreshLoadedProgramPreviewIfNeeded();
  return true;
}

// After a reset the tool length offset may be kept or cleared: on this build a warm reset keeps the
// numbers while $G says G49 (gcode.c gc_init), a cold start or another compatibility level clears
// them. So $# and $G are read again rather than assumed, now and, if the controller refuses them (in
// an alarm), once it is idle (parser.ts).
let _staleAfterReset = false;

/** A reset went (Stop, RESET, probe Cancel): read the offsets, the tool length and the modes again. */
export function rereadAfterReset(): void {
  _staleAfterReset = true;
  loadOffsets();
  command.send('$G').catch(e => { if (!(e instanceof command.CommandFailed)) throw e; });
}

/** The offsets are still to be read: never yet, or not since a reset. */
export function offsetsUnread(): boolean { return !machine.offsetsRead.value || _staleAfterReset; }

// [TLO:z] or [TLO:x,y,z], in the $# reply and pushed after a status report when it changes.
command.on('tlo', raw => {
  log('info', raw);
  const vals = raw.slice(5, -1).split(',').map(v => reportMm(Number(v)));
  machine.tloVector.value = vals.length === 1 ? { x: 0, y: 0, z: vals[0] } : { x: vals[0] ?? 0, y: vals[1] ?? 0, z: vals[2] ?? 0 };
  machine.tlo.value = vals.length === 1 ? vals[0] : (vals[2] ?? vals[0]);
});

function refreshLoadedProgramPreviewIfNeeded(): void {
  if (!job.lines.peek().length) return;
  import('./gcode').then(g => g.refreshLoadedProgramPreview());
}

// ── The store ─────────────────────────────────────────────────────────────────

/** Offsets read or written, into the store the views read, and the 3D view's markers. */
function setOffsets(changed: Record<string, machine.Vec3>): void {
  machine.offsets.value = { ...machine.offsets.peek(), ...changed };
  refreshWcsMarkers();
}

// ── Writes ────────────────────────────────────────────────────────────────────
// $# is read again once the controller has answered each one (parser.ts, noteOffsetWrite).

/** G10 L2 P<n>, in mm: a work offset as typed. The G28/G30 rows have no write (A6). */
export function writeOffset(code: string, vals: { x: number; y: number; z: number }): void {
  if (!connection.connected.peek()) { log('err', 'Not connected'); return; }
  const entry = WCS_ENTRIES.find(e => e.code === code);
  if (!entry || !entry.id) return;
  sendCmd(`G21G10L2P${entry.id}X${vals.x.toFixed(4)}Y${vals.y.toFixed(4)}Z${vals.z.toFixed(4)}`);
  setOffsets({ [code]: { x: vals.x, y: vals.y, z: vals.z } });
  refreshLoadedProgramPreviewIfNeeded();
  log('info', `Offset written: ${code} X${vals.x.toFixed(3)} Y${vals.y.toFixed(3)} Z${vals.z.toFixed(3)}`);
}

export function zeroOffset(code: string): void {
  if (!connection.connected.peek()) { log('err', 'Not connected'); return; }
  const entry = WCS_ENTRIES.find(e => e.code === code);
  if (!entry || !entry.id) return;
  sendCmd(`G10L2P${entry.id}X0Y0Z0`);
  setOffsets({ [code]: { x: 0, y: 0, z: 0 } });
  refreshLoadedProgramPreviewIfNeeded();
  log('info', `Offset zeroed: ${code}`);
}

/** The offset set to where the machine is now. */
export function setToCurrentPos(code: string): void {
  if (!connection.connected.peek()) { log('err', 'Not connected'); return; }
  const entry = WCS_ENTRIES.find(e => e.code === code);
  if (!entry || !entry.id) return;
  // The machine position, in mm (parser.ts), even when the controller reports WPos.
  const { x, y, z } = machine.mpos.value;
  sendCmd(`G21G10L2P${entry.id}X${x.toFixed(4)}Y${y.toFixed(4)}Z${z.toFixed(4)}`);
  setOffsets({ [code]: { x, y, z } });
  refreshLoadedProgramPreviewIfNeeded();
  log('info', `Offset set to machine pos: ${code} X${x.toFixed(3)} Y${y.toFixed(3)} Z${z.toFixed(3)}`);
}

/** G49: cancels the tool length offset. */
export function cancelTlo(): void {
  if (!connection.connected.peek()) { log('err', 'Not connected'); return; }
  sendCmd('G49');
  machine.tlo.value = 0;
}

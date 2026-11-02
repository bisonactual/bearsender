// ═══════════════════════════════════════════════
// WCS Coordinate Offset Table
// ═══════════════════════════════════════════════

import { state } from './state';
import { log } from './console';
import { sendCmd } from './connection';
import * as command from './command';
import { lsGet, lsSet } from './ui';
import { refreshWcsMarkers } from './viewport';
import { reportMm } from './units';
import * as machine from './stores/machine';

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

/** Reads the work offsets ($#). The [TLO:] line in its reply is a push message (see below). */
export async function loadOffsets(): Promise<void> {
  if (!state.connected) { log('err', 'Not connected'); return; }
  let reply: command.Reply;
  try { reply = await command.send('$#'); }
  catch (e) { if (e instanceof command.CommandFailed) return; throw e; }
  for (const raw of reply.lines) {
    // [G54:x,y,z] [G55:...] [G28:...]; [PRB:] is the last probe's, not an offset
    const m = raw.match(/^\[([A-Z0-9.]+):([^\]]+)\]$/);
    if (!m || !OFFSET_KEYS.has(m[1])) continue;
    const vals = m[2].split(',').map(v => reportMm(Number(v)));
    // Store normalised: x, y, z (pad with 0 if fewer axes reported)
    state.wcsOffsets[m[1]] = { x: vals[0] ?? 0, y: vals[1] ?? 0, z: vals[2] ?? 0 };
  }
  if (reply.result !== 'ok') return;
  machine.offsetsRead.value = true;
  if (!machine.offsetsAtConnect.value) machine.offsetsAtConnect.value = { ...state.wcsOffsets };
  renderOffsetsTable();
  refreshLoadedProgramPreviewIfNeeded();
}

// [TLO:z] or [TLO:x,y,z], in the $# reply and pushed after a status report when it changes.
command.on('tlo', raw => {
  log('info', raw);
  const vals = raw.slice(5, -1).split(',').map(v => reportMm(Number(v)));
  state.tloOffset = vals.length === 1 ? vals[0] : (vals[2] ?? vals[0]);
  state.tloActive = state.tloOffset !== 0;
  machine.tlo.value = state.tloOffset;
  renderOffsetsTable();
});

function refreshLoadedProgramPreviewIfNeeded(): void {
  if (!state.gcodeLines.length) return;
  import('./gcode').then(g => g.refreshLoadedProgramPreview());
}

// ── The store ─────────────────────────────────────────────────────────────────

/** Puts the offsets read or written into the store the views read, and the 3D view's markers. */
export function renderOffsetsTable(): void {
  machine.offsets.value = { ...state.wcsOffsets };
  refreshWcsMarkers();
}

// ── Writes ────────────────────────────────────────────────────────────────────
// $# is read again once the controller has answered each one (parser.ts, noteOffsetWrite).

/** G10 L2 P<n>, in mm: a work offset as typed. The G28/G30 rows have no write (A6). */
export function writeOffset(code: string, vals: { x: number; y: number; z: number }): void {
  if (!state.connected) { log('err', 'Not connected'); return; }
  const entry = WCS_ENTRIES.find(e => e.code === code);
  if (!entry || !entry.id) return;
  sendCmd(`G21G10L2P${entry.id}X${vals.x.toFixed(4)}Y${vals.y.toFixed(4)}Z${vals.z.toFixed(4)}`);
  state.wcsOffsets[code] = { x: vals.x, y: vals.y, z: vals.z };
  renderOffsetsTable();
  refreshLoadedProgramPreviewIfNeeded();
  log('info', `Offset written: ${code} X${vals.x.toFixed(3)} Y${vals.y.toFixed(3)} Z${vals.z.toFixed(3)}`);
}

export function zeroOffset(code: string): void {
  if (!state.connected) { log('err', 'Not connected'); return; }
  const entry = WCS_ENTRIES.find(e => e.code === code);
  if (!entry || !entry.id) return;
  sendCmd(`G10L2P${entry.id}X0Y0Z0`);
  state.wcsOffsets[code] = { x: 0, y: 0, z: 0 };
  renderOffsetsTable();
  refreshLoadedProgramPreviewIfNeeded();
  log('info', `Offset zeroed: ${code}`);
}

/** The offset set to where the machine is now. */
export function setToCurrentPos(code: string): void {
  if (!state.connected) { log('err', 'Not connected'); return; }
  const entry = WCS_ENTRIES.find(e => e.code === code);
  if (!entry || !entry.id) return;
  // The machine position, in mm (parser.ts), even when the controller reports WPos.
  const { x, y, z } = machine.mpos.value;
  sendCmd(`G21G10L2P${entry.id}X${x.toFixed(4)}Y${y.toFixed(4)}Z${z.toFixed(4)}`);
  state.wcsOffsets[code] = { x, y, z };
  renderOffsetsTable();
  refreshLoadedProgramPreviewIfNeeded();
  log('info', `Offset set to machine pos: ${code} X${x.toFixed(3)} Y${y.toFixed(3)} Z${z.toFixed(3)}`);
}

/** G49: cancels the tool length offset. */
export function cancelTlo(): void {
  if (!state.connected) { log('err', 'Not connected'); return; }
  sendCmd('G49');
  state.tloOffset = 0;
  state.tloActive = false;
  machine.tlo.value = 0;
  renderOffsetsTable();
}

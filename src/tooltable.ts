// ═══════════════════════════════════════════════
// Tool table — reads $TTLIST into the machine store
// ═══════════════════════════════════════════════
//
// The tool table comes from a plugin: the Expatria ATC plugin, or grblHAL's file based tooltable.c.
// $TTLIST answers a heading, a line per tool, then ok:
//   [TOOLTABLE: P=pocket T=tool offsets diameter name]
//   [TOOL: P1 T3 X0.000 Y0.000 Z-41.250 D6.000 ;6 mm flat]
// or [TOOL: table is empty]. [TOOL: file not accessible] comes with error:61. A controller without
// the plugin doesn't know the command, and answers error:3.

import { signal } from '@preact/signals';
import { log } from './console';
import * as command from './command';
import * as connection from './stores/connection';
import * as machine from './stores/machine';
import type { ToolEntry } from './stores/machine';

/** A read is under way. */
export const reading = signal(false);
/** What the controller said besides its tools on the last read: "table is empty", "file not accessible". */
export const said = signal<string[]>([]);
/** Why the last read got no answer (a reset, the link lost, a timeout); cleared by the next read. */
export const cutShort = signal<command.Failure | null>(null);
/** When the controller last answered $TTLIST. */
export const readAt = signal<number | null>(null);

function parseToolTableLine(line: string): ToolEntry {
  const text = line.replace(/^\[(TOOL:)?\s*/i, '').replace(/\]\s*$/, '');
  const semi = text.indexOf(';');
  const name = semi >= 0 ? text.slice(semi + 1).trim() : '';
  const body = semi >= 0 ? text.slice(0, semi) : text;
  const entry: ToolEntry = { pocket: 0, tool: 0, x: null, y: null, z: null, d: null, name };
  const re = /([PTXYZD])([+-]?[\d.]+)/gi;
  let m;
  while ((m = re.exec(body)) !== null) {
    const k = m[1].toUpperCase(), v = parseFloat(m[2]);
    if (k === 'P') entry.pocket = v;
    else if (k === 'T') entry.tool = v;
    else if (k === 'X') entry.x = v;
    else if (k === 'Y') entry.y = v;
    else if (k === 'Z') entry.z = v;
    else if (k === 'D') entry.d = v;
  }
  return entry;
}

let pending: Promise<string | null> | null = null;

/** Reads the tool table ($TTLIST). A read already under way is joined, not sent again. Resolves with
 *  null when the table came in, or why it didn't (the error, no answer, not connected): the table held
 *  is then the one from before. */
export function loadToolTable(): Promise<string | null> {
  if (!connection.connected.value) return Promise.resolve('not connected');
  if (!pending) pending = read().finally(() => { pending = null; reading.value = false; });
  return pending;
}

async function read(): Promise<string | null> {
  reading.value = true;
  cutShort.value = null;
  try {
    const reply = await command.send('$TTLIST', { log: true, quiet: true });
    readAt.value = Date.now();
    said.value = reply.lines
      .filter(l => /^\[TOOL:/i.test(l) && parseToolTableLine(l).tool <= 0)
      .map(l => l.replace(/^\[TOOL:\s*/i, '').replace(/\]\s*$/, ''));
    if (reply.result === 'ok') {
      const entries = reply.lines.map(parseToolTableLine).filter(e => e.tool > 0);
      machine.toolTable.value = entries;
      machine.toolTableError.value = null;
      log('info', 'Tool table: ' + entries.length + ' entr' + (entries.length === 1 ? 'y' : 'ies'));
      return null;
    }
    const raw = 'error:' + reply.code;
    machine.toolTableError.value = raw;
    log('err', '$TTLIST: ' + raw);
    return raw;
  } catch (e) {
    if (!(e instanceof command.CommandFailed)) throw e;
    cutShort.value = e.why;
    return e.why;
  }
}

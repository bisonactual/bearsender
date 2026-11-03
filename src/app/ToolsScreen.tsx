// ═══════════════════════════════════════════════
// The Tools screen: the controller's tool table
// ═══════════════════════════════════════════════
//
// The table $TTLIST answers (src/tooltable.ts), read when it shows. Each tool shows where it lives (a
// carousel pocket or none), whether it is in the spindle, and what the loaded program does with it.
// Tools the program names and the table lacks are listed under them. The Setup list's TOOLS popup
// shows the same table.

import { useEffect } from 'preact/hooks';
import * as connection from '../stores/connection';
import * as machine from '../stores/machine';
import type { ToolEntry } from '../stores/machine';
import * as program from '../stores/program';
import type { Failure } from '../command';
import { loadToolTable, reading, said, cutShort, readAt } from '../tooltable';
import { errorText } from '../errors';
import { rows } from './mode';
import { tintOf } from './JobScreen';
import * as ui from './ui';

const fix3 = (v: number | null) => v === null ? '—' : v.toFixed(3);
const clock = (t: number) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const plural = (n: number, one: string, many = one + 's') => n + ' ' + (n === 1 ? one : many);

const WHY: Partial<Record<Failure, string>> = {
  timeout: 'no answer came in time', reset: 'the controller was reset', disconnected: 'the link was lost',
  alarm: 'an alarm', 'jog cancel': "a jog cancel emptied the controller's input", banner: 'the controller restarted',
};

/** Pocketed tools by pocket, then the rest by number. */
function sorted(list: ToolEntry[]): ToolEntry[] {
  return [...list].sort((a, b) => {
    if (a.pocket > 0 && b.pocket > 0) return a.pocket - b.pocket;
    if (a.pocket > 0) return -1;
    if (b.pocket > 0) return 1;
    return a.tool - b.tool;
  });
}

/** The program's tools, in the order it uses them, with the names of the sections each one cuts. */
function programTools(): Map<number, string[]> {
  const use = new Map<number, string[]>();
  for (const r of rows.value) {
    if (r.tool === null) continue;
    const names = use.get(r.tool) ?? [];
    if (r.name && !names.includes(r.name)) names.push(r.name);
    use.set(r.tool, names);
  }
  return use;
}

/** What the last read found, as one or more lines over the table. */
function Notes({ missing }: { missing: number[] }) {
  const linked = connection.connected.value;
  const err = machine.toolTableError.value;
  const table = machine.toolTable.value;
  const cut = cutShort.value;
  const spindle = machine.tool.value;
  const notes: [string, string][] = [];
  if (!linked) notes.push(['', 'Not connected. The tool table is read when the controller connects.']);
  else if (reading.value && table === null && !err) notes.push(['is-run', 'Reading the tool table ($TTLIST)…']);
  if (linked && err === 'error:3') {
    notes.push(['is-warn', `No tool table on this controller: it doesn't know $TTLIST (error:3, ${errorText(3)}). `
      + "The table comes from a plugin, the Expatria ATC plugin or grblHAL's tooltable. Jobs still run; check the tools by hand."]);
  } else if (linked && err) {
    const code = parseInt(err.slice(6));
    const text = errorText(code);
    notes.push(['is-err', `$TTLIST was refused: ${err}${text ? ', ' + text : ''}.`
      + (said.value.length ? ' The controller said: ' + said.value.join('; ') + '.' : '')
      + (table ? ' The table below is from the read before.' : '')]);
  }
  if (linked && cut) {
    notes.push(['is-err', `The last read got no answer: ${WHY[cut] ?? cut}. REFRESH reads it again.`
      + (table?.length ? ' The table below is from the read before.' : '')]);
  }
  if (linked && table && !table.length) notes.push(['', 'The tool table is empty' + (said.value.length ? ': the controller said "' + said.value.join('; ') + '".' : '.')]);
  if (linked && table && spindle !== null && spindle > 0 && !table.some(e => e.tool === spindle)) {
    notes.push(['is-warn', `The spindle has T${spindle}, which isn't in the tool table.`]);
  }
  if (table && missing.length) {
    notes.push(['is-err', `${missing.length} of ${plural(programTools().size, 'tool')} the program uses ${missing.length === 1 ? "isn't" : "aren't"} in the tool table: `
      + missing.map(t => 'T' + t).join(', ') + '.']);
  }
  return <>{notes.map(([tone, text]) => <div class={'fs-pstatus ' + tone}>{text}</div>)}</>;
}

function Pill({ tone, children }: { tone: string; children: string }) {
  return <span class={'fs-tt-pill ' + tone}>{children}</span>;
}

/** The program column: the tool's tint as on the job screen, and the sections it cuts. */
function Use({ tool, use }: { tool: number; use: Map<number, string[]> }) {
  const names = use.get(tool);
  if (!names) return <td class="fs-tt-use fs-dim">—</td>;
  return (
    <td class="fs-tt-use">
      <span class="fs-tt-usebox">
        <span class="fs-tint" style={{ background: tintOf(tool).tint }} />
        <span class="fs-ellipsis">{names.length ? names.join(', ') : 'used'}</span>
      </span>
    </td>
  );
}

const zero = (v: number | null) => v === null || v === 0 ? 'fs-mono fs-tt-zero' : 'fs-mono';

export function ToolTable() {
  const linked = connection.connected.value;
  const table = machine.toolTable.value;
  const spindle = machine.tool.value;
  // Read when it shows. Connecting reads it as well (asks.ts), so a link made while it shows isn't read twice.
  useEffect(() => { if (linked) loadToolTable(); }, []);
  const use = programTools();
  const described = program.view.value?.described ?? {};
  const listed = table ? sorted(table) : [];
  const missing = [...use.keys()].filter(t => !table?.some(e => e.tool === t));
  const showUse = use.size > 0;
  const pocketed = listed.filter(e => e.pocket > 0).length;
  const summary = [
    table ? plural(table.length, 'tool') + ' · ' + pocketed + ' in the carousel' : '',
    showUse ? 'the program uses ' + plural(use.size, 'tool') : '',
    table && readAt.value ? 'read at ' + clock(readAt.value) : '',
  ].filter(Boolean).join(' · ');
  return (
    <div class="fs-tools">
      <div class="fs-card-head">
        <span class="fs-dim">{summary || "The controller's tool table, read with $TTLIST."}</span>
        <button type="button" class="fs-btn fs-btn-sm" disabled={!linked || reading.value} onClick={() => loadToolTable()}>
          {reading.value ? 'READING…' : 'REFRESH'}
        </button>
      </div>
      <Notes missing={table ? missing : []} />
      {listed.length || missing.length ? (
        <div class="fs-offsets-scroll">
          <table class="fs-table fs-tttable">
            <thead><tr>
              <th>POCKET</th><th>TOOL</th><th class="fs-tt-name">NAME</th><th>X</th><th>Y</th><th>Z</th><th>DIA</th>
              <th class="fs-tt-status">STATUS</th>{showUse && <th class="fs-tt-use">IN THE PROGRAM</th>}
            </tr></thead>
            <tbody>
              {listed.map(e => {
                const inSpindle = spindle !== null && spindle > 0 && e.tool === spindle;
                return (
                  <tr class={inSpindle ? 'is-spindle' : e.pocket > 0 ? 'is-pocket' : ''}>
                    <td class={'fs-mono fs-tt-pocket' + (e.pocket > 0 ? '' : ' fs-tt-zero')}>P{e.pocket}</td>
                    <td class="fs-mono fs-tt-tool">T{e.tool}</td>
                    <td class="fs-tt-name">{e.name || <span class="fs-dim">—</span>}</td>
                    <td class={zero(e.x)}>{fix3(e.x)}</td>
                    <td class={zero(e.y)}>{fix3(e.y)}</td>
                    <td class={zero(e.z)}>{fix3(e.z)}</td>
                    <td class={zero(e.d)}>{fix3(e.d)}</td>
                    <td class="fs-tt-status">
                      {inSpindle ? <Pill tone="is-go">IN THE SPINDLE</Pill> : e.pocket > 0 ? <Pill tone="is-pocket">{'POCKET ' + e.pocket}</Pill> : <Pill tone="">NO POCKET</Pill>}
                    </td>
                    {showUse && <Use tool={e.tool} use={use} />}
                  </tr>
                );
              })}
              {missing.map(t => (
                <tr class={table ? 'is-missing' : ''}>
                  <td class="fs-mono fs-tt-pocket fs-tt-zero">—</td>
                  <td class="fs-mono fs-tt-tool">T{t}</td>
                  <td class="fs-tt-name">{described[t] ? <span class="fs-dim">{described[t]} (from the program)</span> : <span class="fs-dim">—</span>}</td>
                  <td class="fs-dim">—</td><td class="fs-dim">—</td><td class="fs-dim">—</td><td class="fs-dim">—</td>
                  <td class="fs-tt-status">{table ? <Pill tone="is-stop">NOT IN THE TABLE</Pill> : <span class="fs-dim">—</span>}</td>
                  <Use tool={t} use={use} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <div class="fs-tt-legend">
        <span><Pill tone="is-pocket">POCKET</Pill> in the carousel (P1 and up)</span>
        <span><Pill tone="">NO POCKET</Pill> P0, loaded by hand</span>
        <span><Pill tone="is-go">IN THE SPINDLE</Pill> the tool the controller reports</span>
        <span class="fs-dim">Offsets and diameters in mm, as the controller lists them. The table comes from a tool table plugin (the Expatria ATC plugin, or grblHAL's tooltable).</span>
      </div>
    </div>
  );
}

export function ToolsScreen() {
  // Built only while it shows, so the table is read when it opens, as the old tab did.
  if (ui.screen.value !== 'tools') return null;
  return <section class="fs-screen"><div class="fs-sub fs-pad"><ToolTable /></div></section>;
}

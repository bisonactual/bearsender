// The Tools screen: the controller's tool table ($TTLIST), with where each tool is and what the loaded
// program does with it. The Setup list's TOOLS popup shows the same table.

import { useEffect } from 'preact/hooks';
import * as connection from '../stores/connection';
import * as machine from '../stores/machine';
import type { ToolEntry } from '../stores/machine';
import * as program from '../stores/program';
import type { Failure } from '../command';
import { loadToolTable, isReading, otherLines, lastFailure, lastReadAt } from '../tooltable';
import { errorText } from '../errors';
import { rows } from './mode';
import { tintOf } from './JobScreen';
import * as ui from './ui';

const formatMm = (v: number | null) => v === null ? '-' : v.toFixed(3);
const formatTime = (t: number) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const plural = (n: number, one: string, many = one + 's') => n + ' ' + (n === 1 ? one : many);

const FAILURE_TEXT: Partial<Record<Failure, string>> = {
  timeout: 'no answer came in time', reset: 'the controller was reset', disconnected: 'the link was lost',
  alarm: 'an alarm', 'jog cancel': "a jog cancel emptied the controller's input", banner: 'the controller restarted',
};

/** Pocketed tools by pocket, then the rest by number. */
function sortByPocket(list: ToolEntry[]): ToolEntry[] {
  return [...list].sort((a, b) => {
    if (a.pocket > 0 && b.pocket > 0) return a.pocket - b.pocket;
    if (a.pocket > 0) return -1;
    if (b.pocket > 0) return 1;
    return a.tool - b.tool;
  });
}

/** The program's tools, in the order it uses them, with the names of the sections each one cuts. */
function programTools(): Map<number, string[]> {
  const toolUse = new Map<number, string[]>();
  for (const r of rows.value) {
    if (r.tool === null) continue;
    const names = toolUse.get(r.tool) ?? [];
    if (r.name && !names.includes(r.name)) names.push(r.name);
    toolUse.set(r.tool, names);
  }
  return toolUse;
}

/** What the last read found, as one or more lines over the table. */
function TableNotes({ missing }: { missing: number[] }) {
  const isConnected = connection.connected.value;
  const error = machine.toolTableError.value;
  const table = machine.toolTable.value;
  const failure = lastFailure.value;
  const spindleTool = machine.tool.value;
  const notes: [string, string][] = [];
  if (!isConnected) notes.push(['', 'Not connected. The tool table is read when the controller connects.']);
  else if (isReading.value && table === null && !error) notes.push(['is-run', 'Reading the tool table ($TTLIST)…']);
  if (isConnected && error === 'error:3') {
    notes.push(['is-warn', `No tool table on this controller: it doesn't know $TTLIST (error:3, ${errorText(3)}). `
      + "The table comes from a plugin, the Expatria ATC plugin or grblHAL's tooltable. Jobs still run; check the tools by hand."]);
  } else if (isConnected && error) {
    const code = parseInt(error.slice(6));
    const text = errorText(code);
    notes.push(['is-err', `$TTLIST was refused: ${error}${text ? ', ' + text : ''}.`
      + (otherLines.value.length ? ' The controller said: ' + otherLines.value.join('; ') + '.' : '')
      + (table ? ' The table below is from the read before.' : '')]);
  }
  if (isConnected && failure) {
    notes.push(['is-err', `The last read got no answer: ${FAILURE_TEXT[failure] ?? failure}. REFRESH reads it again.`
      + (table?.length ? ' The table below is from the read before.' : '')]);
  }
  if (isConnected && table && !table.length) notes.push(['', 'The tool table is empty' + (otherLines.value.length ? ': the controller said "' + otherLines.value.join('; ') + '".' : '.')]);
  if (isConnected && table && spindleTool !== null && spindleTool > 0 && !table.some(e => e.tool === spindleTool)) {
    notes.push(['is-warn', `The spindle has T${spindleTool}, which isn't in the tool table.`]);
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
function ProgramCell({ tool, toolUse }: { tool: number; toolUse: Map<number, string[]> }) {
  const names = toolUse.get(tool);
  if (!names) return <td class="fs-tt-use fs-dim">-</td>;
  return (
    <td class="fs-tt-use">
      <span class="fs-tt-usebox">
        <span class="fs-tint" style={{ background: tintOf(tool).tint }} />
        <span class="fs-ellipsis">{names.length ? names.join(', ') : 'used'}</span>
      </span>
    </td>
  );
}

const numberClass = (v: number | null) => v === null || v === 0 ? 'fs-mono fs-tt-zero' : 'fs-mono';

export function ToolTable() {
  const isConnected = connection.connected.value;
  const table = machine.toolTable.value;
  const spindleTool = machine.tool.value;
  // Connecting reads it too (asks.ts), so it is read here only if already connected.
  useEffect(() => { if (isConnected) loadToolTable(); }, []);
  const toolUse = programTools();
  const programToolNames = program.view.value?.described ?? {};
  const sortedTools = table ? sortByPocket(table) : [];
  const missing = [...toolUse.keys()].filter(t => !table?.some(e => e.tool === t));
  const showsProgram = toolUse.size > 0;
  const pocketCount = sortedTools.filter(e => e.pocket > 0).length;
  const summary = [
    table ? plural(table.length, 'tool') + ' · ' + pocketCount + ' in the carousel' : '',
    showsProgram ? 'the program uses ' + plural(toolUse.size, 'tool') : '',
    table && lastReadAt.value ? 'read at ' + formatTime(lastReadAt.value) : '',
  ].filter(Boolean).join(' · ');
  return (
    <div class="fs-tools">
      <div class="fs-card-head">
        <span class="fs-dim">{summary || "The controller's tool table, read with $TTLIST."}</span>
        <button type="button" class="fs-btn fs-btn-sm" disabled={!isConnected || isReading.value} onClick={() => loadToolTable()}>
          {isReading.value ? 'READING…' : 'REFRESH'}
        </button>
      </div>
      <TableNotes missing={table ? missing : []} />
      {sortedTools.length || missing.length ? (
        <div class="fs-offsets-scroll">
          <table class="fs-table fs-tttable">
            <thead><tr>
              <th>POCKET</th><th>TOOL</th><th class="fs-tt-name">NAME</th><th>X</th><th>Y</th><th>Z</th><th>DIA</th>
              <th class="fs-tt-status">STATUS</th>{showsProgram && <th class="fs-tt-use">IN THE PROGRAM</th>}
            </tr></thead>
            <tbody>
              {sortedTools.map(e => {
                const isInSpindle = spindleTool !== null && spindleTool > 0 && e.tool === spindleTool;
                return (
                  <tr class={isInSpindle ? 'is-spindle' : e.pocket > 0 ? 'is-pocket' : ''}>
                    <td class={'fs-mono fs-tt-pocket' + (e.pocket > 0 ? '' : ' fs-tt-zero')}>P{e.pocket}</td>
                    <td class="fs-mono fs-tt-tool">T{e.tool}</td>
                    <td class="fs-tt-name">{e.name || <span class="fs-dim">-</span>}</td>
                    <td class={numberClass(e.x)}>{formatMm(e.x)}</td>
                    <td class={numberClass(e.y)}>{formatMm(e.y)}</td>
                    <td class={numberClass(e.z)}>{formatMm(e.z)}</td>
                    <td class={numberClass(e.d)}>{formatMm(e.d)}</td>
                    <td class="fs-tt-status">
                      {isInSpindle ? <Pill tone="is-go">IN THE SPINDLE</Pill> : e.pocket > 0 ? <Pill tone="is-pocket">{'POCKET ' + e.pocket}</Pill> : <Pill tone="">NO POCKET</Pill>}
                    </td>
                    {showsProgram && <ProgramCell tool={e.tool} toolUse={toolUse} />}
                  </tr>
                );
              })}
              {missing.map(t => (
                <tr class={table ? 'is-missing' : ''}>
                  <td class="fs-mono fs-tt-pocket fs-tt-zero">-</td>
                  <td class="fs-mono fs-tt-tool">T{t}</td>
                  <td class="fs-tt-name">{programToolNames[t] ? <span class="fs-dim">{programToolNames[t]} (from the program)</span> : <span class="fs-dim">-</span>}</td>
                  <td class="fs-dim">-</td><td class="fs-dim">-</td><td class="fs-dim">-</td><td class="fs-dim">-</td>
                  <td class="fs-tt-status">{table ? <Pill tone="is-stop">NOT IN THE TABLE</Pill> : <span class="fs-dim">-</span>}</td>
                  <ProgramCell tool={t} toolUse={toolUse} />
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
  // Mounted only while it shows, so the table is read each time the screen opens.
  if (ui.screen.value !== 'tools') return null;
  return <section class="fs-screen"><div class="fs-sub fs-pad"><ToolTable /></div></section>;
}

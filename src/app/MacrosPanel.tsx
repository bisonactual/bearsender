// The job screen's Macros tab: the built-in commands and the operator's own macros
//
// A macro's lines go one at a time, each waiting for the controller's ok; the first error stops the rest.
// What the controller answers shows under the buttons. The operator's macros are kept in this browser.

import { useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import * as command from '../command';
import { rtSend } from '../connection';
import { sendHome } from '../streaming';
import { errorText } from '../errors';
import * as connection from '../stores/connection';
import * as job from '../stores/job';
import * as macros from '../stores/macros';
import type { Macro } from '../stores/macros';
import { progress as warmupProgress } from '../warmup';

interface Result { title: string; note: string; tone: '' | 'is-run' | 'is-ok' | 'is-err'; lines: string[]; }
const result = signal<Result | null>(null);
const busy = signal(false);
const editing = signal<Macro | null>(null);
const arranging = signal(false);

/** Sends the lines one at a time, each after the last one's ok, and shows what came back. */
async function runLines(title: string, code: string[]): Promise<void> {
  const lines = code.map(l => l.trim()).filter(Boolean);
  if (busy.value || !lines.length) return;
  busy.value = true;
  const out: string[] = [];
  result.value = { title, note: 'Sending…', tone: 'is-run', lines: [] };
  const left = (i: number) => lines.length - i - 1 ? ` The ${lines.length - i - 1 === 1 ? 'line' : lines.length - i - 1 + ' lines'} after it ${lines.length - i - 1 === 1 ? 'was' : 'were'} not sent.` : '';
  try {
    // An empty line first: grblHAL keeps the last error and gives it to the next G-code line until a $
    // command or an empty line clears it, so an earlier refusal can't refuse this macro's first line.
    try { await command.send(''); }
    catch (e) {
      if (!(e instanceof command.CommandFailed)) throw e;
      result.value = { title, tone: 'is-err', note: `Nothing was sent: ${e.why}.`, lines: [] };
      return;
    }
    for (let i = 0; i < lines.length; i++) {
      let r: command.Reply;
      try { r = await command.send(lines[i], { log: true }); }
      catch (e) {
        if (!(e instanceof command.CommandFailed)) throw e;
        result.value = { title, tone: 'is-err', note: `${lines[i]} got no answer: ${e.why}.${left(i)}`, lines: out };
        return;
      }
      out.push(...r.lines);
      if (r.result === 'error') {
        const why = errorText(r.code);
        result.value = { title, tone: 'is-err', note: `${lines[i]}: error:${r.code}${why ? ', ' + why : ''}.${left(i)}`, lines: out };
        return;
      }
    }
    result.value = { title, tone: 'is-ok', note: lines.length === 1 ? `${lines[0]}: ok` : `All ${lines.length} lines sent, each answered ok.`, lines: out };
  } finally { busy.value = false; }
}

/** The next status report, for QUERY. */
function query(): void {
  const off = command.on('status', line => { off(); result.value = { title: 'QUERY', tone: 'is-ok', note: 'The status report (?):', lines: [line] }; });
  rtSend('?');
}

// Moves say G21 G90, so a job's G20 or a probe's G91 can't change them.
const BUILT_IN: [string, string, () => void][] = [
  ['HOME ALL', '$H', () => { sendHome(); result.value = { title: 'HOME ALL', tone: 'is-ok', note: '$H sent: the machine homes.', lines: [] }; }],
  ['HOME Z', '$HZ', () => runLines('HOME Z', ['$HZ'])],
  ['GOTO XY0', 'G21 G90 G0 X0 Y0', () => runLines('GOTO XY0', ['G21 G90 G0 X0 Y0'])],
  ['PARK Z', 'G21 G90 G0 Z5', () => runLines('PARK Z', ['G21 G90 G0 Z5'])],
  ['GRBL INFO', '$I', () => runLines('GRBL INFO', ['$I'])],
  ['SETTINGS', '$$', () => runLines('SETTINGS', ['$$'])],
  ['WCS TABLE', '$#', () => runLines('WCS TABLE', ['$#'])],
  ['QUERY', '?', query],
];

/** Why the macros can't go now, or '' if they can. */
function whyNot(): string {
  if (!connection.connected.value) return 'Not connected.';
  if (job.running.value) return 'A job is running: macros wait until it ends.';
  if (warmupProgress.value) return 'The machine warmup is running.';
  return '';
}

function Editor({ m }: { m: Macro }) {
  const [name, setName] = useState(m.name);
  const [code, setCode] = useState(m.code);
  const isNew = !macros.list.value.some(x => x.id === m.id);
  const ok = name.trim() !== '' && code.trim() !== '';
  return (
    <section class="fs-card fs-mcard fs-macro-edit" aria-label={isNew ? 'New macro' : 'Edit macro'}>
      <h2 class="fs-h">{isNew ? 'NEW MACRO' : 'EDIT MACRO'}</h2>
      <label class="fs-field"><span>Name, as on its button</span>
        <input type="text" class="fs-in" maxLength={24} value={name} onInput={e => setName((e.target as HTMLInputElement).value)} /></label>
      <label class="fs-field"><span>G-code or $ commands, one per line</span>
        <textarea class="fs-in fs-mono fs-macro-code" rows={6} spellcheck={false} value={code} onInput={e => setCode((e.target as HTMLTextAreaElement).value)} /></label>
      <div class="fs-note">Each line waits for the controller's ok, and the first error stops the rest. Say G21 and G90 where a move needs them: a job can leave G20 or G91.</div>
      <div class="fs-macro-btns">
        <button type="button" class="fs-btn fs-btn-sm is-accent" disabled={!ok}
          onClick={() => { macros.save({ id: m.id, name: name.trim(), code: code.replace(/\r/g, '').trim() }); editing.value = null; }}>SAVE</button>
        <button type="button" class="fs-btn fs-btn-sm" onClick={() => { editing.value = null; }}>CANCEL</button>
        {!isNew && <button type="button" class="fs-btn fs-btn-sm is-stop" onClick={() => { macros.remove(m.id); editing.value = null; }}>DELETE</button>}
      </div>
    </section>
  );
}

export function MacrosPanel() {
  const why = whyNot();
  const off = !!why || busy.value;
  const mine = macros.list.value;
  const r = result.value;
  return (
    <div class="fs-macros">
      <div class="fs-cap">BUILT IN</div>
      <div class="fs-macro-grid">
        {BUILT_IN.map(([label, cmd, run]) => (
          <button type="button" class="fs-btn fs-macro" disabled={off} title={cmd} onClick={run}>{label}</button>
        ))}
      </div>
      <div class="fs-card-head">
        <div class="fs-cap">YOUR MACROS</div>
        <div class="fs-head-end">
          <button type="button" class="fs-btn fs-btn-xs" onClick={() => { arranging.value = false; editing.value = { id: macros.newId(), name: '', code: '' }; }}>+ NEW</button>
          {mine.length > 0 && <button type="button" class={'fs-btn fs-btn-xs' + (arranging.value ? ' is-on' : '')} aria-pressed={arranging.value ? 'true' : 'false'}
            onClick={() => { arranging.value = !arranging.value; }}>{arranging.value ? 'DONE' : 'EDIT'}</button>}
        </div>
      </div>
      {arranging.value ? (
        <div class="fs-macro-list">
          {mine.map((m, i) => (
            <div class="fs-macro-item">
              <span class="fs-macro-name">{m.name}</span>
              <span class="fs-dim fs-mono fs-ellipsis">{m.code.split('\n').join(' · ')}</span>
              <button type="button" class="fs-btn fs-btn-xs" disabled={i === 0} aria-label={'Move ' + m.name + ' up'} onClick={() => macros.move(m.id, -1)}>↑</button>
              <button type="button" class="fs-btn fs-btn-xs" disabled={i === mine.length - 1} aria-label={'Move ' + m.name + ' down'} onClick={() => macros.move(m.id, 1)}>↓</button>
              <button type="button" class="fs-btn fs-btn-xs" onClick={() => { editing.value = m; }}>EDIT</button>
            </div>
          ))}
        </div>
      ) : mine.length ? (
        <div class="fs-macro-grid">
          {mine.map(m => (
            <button type="button" class="fs-btn fs-macro" disabled={off} title={m.code} onClick={() => runLines(m.name, m.code.split('\n'))}>{m.name}</button>
          ))}
        </div>
      ) : <div class="fs-empty-sm">None yet. + NEW makes one: a name and the lines it sends. They are kept in this browser, on this computer.</div>}
      {editing.value && <Editor key={editing.value.id} m={editing.value} />}
      {why && <div class="fs-pstatus">{why}</div>}
      {r && (
        <div class={'fs-macro-out fs-pstatus ' + r.tone}>
          <div><b>{r.title}</b> · {r.note}</div>
          {r.lines.length > 0 && <pre class="fs-mono">{r.lines.join('\n')}</pre>}
        </div>
      )}
    </div>
  );
}

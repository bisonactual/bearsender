// ═══════════════════════════════════════════════
// The job screen's Console tab: the log, a command line, and the touch keyboard
// ═══════════════════════════════════════════════
//
// The log keeps its last lines in console.ts; this draws them, and adds each new one as it comes.
// Typing $ and part of a setting's name offers the settings (once they have been read); $n= shows its name
// and value. Up and down go through the commands sent, and ; sends several.

import { useEffect, useRef, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import { logLines, onLog, clearConsole, history, LOG_MAX } from '../console';
import type { LogLine } from '../console';
import { sendCmd } from '../connection';
import * as settings from '../settings';
import * as machine from '../stores/machine';

const PRE: Record<string, string> = { tx: '→', rx: '←', ok: '✓', err: '✗', info: 'ℹ', alarm: '⚠' };

/** The command being typed, shared with the touch keyboard. */
const typed = signal('');
const keyboard = signal(false);

function lineEl(l: LogLine): HTMLElement {
  const div = document.createElement('div');
  div.className = 'fs-con-line is-' + (PRE[l.type] ? l.type : 'rx');
  div.textContent = (PRE[l.type] ?? '·') + ' ' + l.text;
  return div;
}

/** The log: drawn once from what is kept, then a line at a time, following the end unless scrolled up. */
function LogView() {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current!;
    el.replaceChildren(...logLines().map(lineEl));
    el.scrollTop = el.scrollHeight;
    let frame = 0;
    return onLog(line => {
      if (!line) { el.replaceChildren(); return; }
      const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      el.appendChild(lineEl(line));
      while (el.childElementCount > LOG_MAX) el.firstElementChild!.remove();
      if (atEnd && !frame) frame = requestAnimationFrame(() => { frame = 0; el.scrollTop = el.scrollHeight; });
    });
  }, []);
  return <div ref={box} class="fs-con-out" role="log" aria-label="Console" />;
}

/** Sends what was typed: each part between ; as its own command. */
function send(): void {
  const raw = typed.value.trim();
  if (!raw) return;
  history.unshift(raw);
  typed.value = '';
  for (const cmd of raw.split(';').map(s => s.trim()).filter(Boolean)) sendCmd(cmd);
}

/** The part after the last ;. */
const segmentOf = (v: string) => v.slice(v.lastIndexOf(';') + 1).trimStart();

/** Settings whose name matches what follows a $, up to 12. */
function matches(v: string): { id: number; name: string }[] {
  const seg = segmentOf(v);
  if (!seg.startsWith('$') || seg.includes('=') || !settings.loaded.value) return [];
  const q = seg.slice(1).toLowerCase().replace(/\s+/g, '_');
  if (!q) return [];
  return Object.values(settings.defs.value)
    .filter(d => d.name.toLowerCase().replace(/\s+/g, '_').includes(q))
    .slice(0, 12).map(d => ({ id: d.id, name: d.name }));
}

/** For $n=: the setting's name and its value now, or that the controller has no such setting. */
function hint(v: string): { text: string; warn: boolean } | null {
  const m = segmentOf(v).match(/^\$(\d+)=/);
  if (!m || !settings.loaded.value) return null;
  const id = parseInt(m[1]);
  const def = settings.defs.value[id];
  if (!def) return { text: 'Unknown setting $' + id, warn: true };
  const cur = machine.settings.value[id];
  return { text: def.name + (cur !== undefined ? ` (now ${cur})` : ''), warn: false };
}

function CommandLine() {
  const input = useRef<HTMLInputElement>(null);
  // The setting picked in the list with the arrow keys; -1 until one is, so Enter still sends.
  const [pick, setPick] = useState(-1);
  const [hist, setHist] = useState(-1);
  const [closed, setClosed] = useState(false);
  const v = typed.value;
  const list = closed ? [] : matches(v);
  const h = hint(v);
  const accept = (i: number) => {
    const item = list[i];
    if (!item) return;
    const semi = v.lastIndexOf(';');
    typed.value = (semi >= 0 ? v.slice(0, semi + 1) + ' ' : '') + '$' + item.id + '=';
    input.current?.focus();
  };
  const set = (s: string) => { typed.value = s; setClosed(false); setPick(-1); };
  const onKey = (e: KeyboardEvent) => {
    const el = e.target as HTMLInputElement;
    // The list offers settings; Tab takes the picked one (or the first), Enter only one picked with the arrows.
    if (list.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setPick((pick + 1) % list.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setPick(pick <= 0 ? list.length - 1 : pick - 1); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && pick >= 0)) { e.preventDefault(); accept(Math.max(0, pick)); return; }
      if (e.key === 'Escape') { setClosed(true); return; }
    }
    if (e.key === 'Enter') { typed.value = el.value; send(); setHist(-1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); const i = Math.min(hist + 1, history.length - 1); setHist(i); set(history[i] ?? ''); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); const i = Math.max(hist - 1, -1); setHist(i); set(i >= 0 ? history[i] : ''); return; }
    // Readline: ctrl+U to the start, ctrl+K to the end, ctrl+C all, ctrl+W the word before.
    if (!e.ctrlKey) return;
    const at = el.selectionStart ?? el.value.length;
    if (e.key === 'u') { e.preventDefault(); set(el.value.slice(at)); requestAnimationFrame(() => el.setSelectionRange(0, 0)); }
    if (e.key === 'k') { e.preventDefault(); set(el.value.slice(0, at)); }
    if (e.key === 'c' && el.selectionStart === el.selectionEnd) { e.preventDefault(); set(''); setHist(-1); }
    if (e.key === 'w') {
      e.preventDefault();
      const before = el.value.slice(0, at).replace(/\s*\S+\s*$/, '');
      set(before + el.value.slice(at));
      requestAnimationFrame(() => el.setSelectionRange(before.length, before.length));
    }
  };
  return (
    <div class="fs-con-cmd">
      {list.length > 0 && (
        <div class="fs-con-ac" role="listbox" aria-label="Settings">
          {list.map((item, i) => (
            <div role="option" aria-selected={i === pick ? 'true' : 'false'} class={'fs-con-ac-item' + (i === pick ? ' is-on' : '')}
              onMouseDown={e => { e.preventDefault(); accept(i); }}>
              <span>{item.name.replace(/\s+/g, '_')}</span><span class="fs-mono fs-dim">${item.id}</span>
            </div>
          ))}
        </div>
      )}
      {h && <div class={'fs-con-hint' + (h.warn ? ' fs-warn-text' : '')}>{h.text}</div>}
      <div class="fs-con-row">
        <span class="fs-con-prompt">›</span>
        <input ref={input} class="fs-in fs-mono fs-con-input" aria-label="Command" placeholder="Send a command: G-code or $…" autocomplete="off" spellcheck={false}
          value={v} onInput={e => set((e.target as HTMLInputElement).value)} onKeyDown={onKey} />
        <button type="button" class="fs-btn fs-btn-sm" onClick={send}>SEND</button>
      </div>
    </div>
  );
}

const ROWS = ['1234567890-.#$', 'QWERTYUIOP', 'ASDFGHJKL;', 'ZXCVBNM /=*'];
const PAD = ['(', ')', '7', '8', '9', '4', '5', '6', '1', '2', '3', '0', '.'];

/** The touch keyboard: types into the command line, sends it, and closes. */
function TouchKeyboard() {
  const key = (k: string) => { typed.value += k; };
  const btn = (label: string, act: () => void, cls = '') => (
    <button type="button" class={'fs-kbd-key ' + cls} onPointerDown={e => e.preventDefault()} onClick={act}>{label}</button>
  );
  return (
    <div class="fs-kbd" role="group" aria-label="Touch keyboard">
      <div class="fs-kbd-main">
        <div class="fs-kbd-row">
          <div class="fs-kbd-show fs-mono">› {typed.value}</div>
          {btn('SEND', send, 'is-send')}
          {btn('✕', () => { keyboard.value = false; }, 'is-close')}
        </div>
        {ROWS.map((row, r) => (
          <div class="fs-kbd-row">
            {[...row].map(k => btn(k === ' ' ? 'SPC' : k, () => key(k)))}
            {r === 1 && btn('⌫ DEL', () => { typed.value = typed.value.slice(0, -1); }, 'is-action')}
            {r === 2 && btn('↵ SEND', send, 'is-send')}
          </div>
        ))}
      </div>
      <div class="fs-kbd-pad">
        {btn('CLR', () => { typed.value = ''; }, 'is-action')}
        {PAD.map(k => btn(k, () => key(k), k === '0' ? 'fs-kbd-wide2' : ''))}
      </div>
    </div>
  );
}

export function ConsolePanel() {
  return (
    <div class="fs-con">
      <LogView />
      <CommandLine />
      <div class="fs-con-tools">
        <button type="button" class="fs-btn fs-btn-sm" onClick={() => clearConsole()}>CLEAR</button>
        <button type="button" class={'fs-btn fs-btn-sm' + (keyboard.value ? ' is-on' : '')} aria-pressed={keyboard.value ? 'true' : 'false'}
          title="Touch keyboard" onClick={() => { keyboard.value = !keyboard.value; }}>⌨ KEYBOARD</button>
        <span class="fs-dim fs-small">Keeps the last {LOG_MAX} lines. ↑ ↓ go through the commands sent; ; sends several.</span>
      </div>
      {keyboard.value && <TouchKeyboard />}
    </div>
  );
}

// ═══════════════════════════════════════════════
// Shared UI helpers
// ═══════════════════════════════════════════════

const _enc = new TextEncoder();

export function byteLen(s: string): number {
  return _enc.encode(s).length;
}

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function fmtPos(v: string): string {
  return (parseFloat(v) || 0).toFixed(3);
}

export function fmtBytes(b: number): string {
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(1) + ' KB';
  return b + ' B';
}

export function fmtOffset(v: number | null | undefined): string {
  if (v === null || v === undefined) return '<span style="color:var(--text3)">—</span>';
  const s = v.toFixed(3);
  if (v === 0) return '<span style="color:var(--text3)">' + s + '</span>';
  return s;
}

export function isInputFocused(): boolean {
  const tag = document.activeElement?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA';
}

export function lsGet<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v !== null ? JSON.parse(v) : fallback; }
  catch (_) { return fallback; }
}

export function lsSet(key: string, val: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) {}
}

export function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

const _armed = new WeakMap<HTMLElement, { text: string; timer: ReturnType<typeof setTimeout> }>();

/** A guard for one-click zeros: the first tap turns the button into the prompt for 3 s, the second runs it. */
export function confirmTap(btn: HTMLElement, prompt: string, run: () => void): void {
  const armed = _armed.get(btn);
  const disarm = (text: string) => { btn.textContent = text; btn.classList.remove('is-arming'); _armed.delete(btn); };
  if (armed) { clearTimeout(armed.timer); disarm(armed.text); run(); return; }
  const text = btn.textContent || '';
  btn.textContent = prompt;
  btn.classList.add('is-arming');
  _armed.set(btn, { text, timer: setTimeout(() => disarm(text), 3000) });
}

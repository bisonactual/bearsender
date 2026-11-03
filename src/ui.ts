// Small helpers: byte length, HTML escaping, input focus, and localStorage that never throws.

const encoder = new TextEncoder();

export function byteLen(s: string): number {
  return encoder.encode(s).length;
}

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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


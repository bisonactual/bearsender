// ═══════════════════════════════════════════════
// Macros store — the operator's own macros, kept in this browser
// ═══════════════════════════════════════════════
//
// A macro is a name and some lines of G-code or $ commands. They live on this computer, in the browser,
// like the queue and the options: nothing is stored on the controller.

import { signal, effect } from '@preact/signals';
import { lsGet, lsSet } from '../ui';

export interface Macro { id: string; name: string; code: string; }

export const list = signal<Macro[]>(lsGet<Macro[]>('fs-macros', []).filter(m => m && typeof m.name === 'string' && typeof m.code === 'string'));
effect(() => lsSet('fs-macros', list.value));

export function save(m: Macro): void {
  const i = list.value.findIndex(x => x.id === m.id);
  list.value = i >= 0 ? list.value.map(x => x.id === m.id ? m : x) : [...list.value, m];
}

export function remove(id: string): void { list.value = list.value.filter(m => m.id !== id); }

/** Moves a macro one place earlier (-1) or later (+1). */
export function move(id: string, by: -1 | 1): void {
  const a = [...list.value], i = a.findIndex(m => m.id === id), j = i + by;
  if (i < 0 || j < 0 || j >= a.length) return;
  [a[i], a[j]] = [a[j], a[i]];
  list.value = a;
}

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

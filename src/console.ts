// ═══════════════════════════════════════════════
// Console logging
// ═══════════════════════════════════════════════
//
// The log is kept here, the last LOG_MAX lines, whether or not the job screen's Console tab shows; the
// tab (src/app/ConsolePanel.tsx) draws them and the lines added after.

import { signal } from '@preact/signals';

/** The last error logged, so a screen can say why something it started failed. */
export const lastError = signal<{ at: number; text: string } | null>(null);

export interface LogLine { type: string; text: string; }

/** How many lines the console keeps. */
export const LOG_MAX = 1000;
const lines: LogLine[] = [];
const listeners = new Set<(line: LogLine | null) => void>();

export function log(type: string, msg: string): void {
  if (type === 'err') lastError.value = { at: Date.now(), text: msg };
  const line = { type, text: msg };
  lines.push(line);
  if (lines.length > LOG_MAX) lines.shift();
  for (const fn of listeners) fn(line);
}

export function clearConsole(): void {
  lines.length = 0;
  for (const fn of listeners) fn(null);
}

/** The lines kept, oldest first. */
export function logLines(): readonly LogLine[] { return lines; }

/** Called with each line logged, and with null when the console is cleared. Returns the unsubscribe. */
export function onLog(fn: (line: LogLine | null) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Commands typed in the console, newest first, for the up and down keys. */
export const history: string[] = [];

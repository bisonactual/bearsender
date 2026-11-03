// The message line's history: [MSG:] lines, alarms, errors and job events. Not the raw console, only
// what the operator should read.

import { signal } from '@preact/signals';

export type MessageKind = 'msg' | 'alarm' | 'error' | 'job' | 'link';

export interface Message { at: number; kind: MessageKind; text: string; }

const LIMIT = 200;

/** Newest first. */
export const list = signal<Message[]>([]);

export function push(kind: MessageKind, text: string): void {
  list.value = [{ at: Date.now(), kind, text }, ...list.value].slice(0, LIMIT);
}

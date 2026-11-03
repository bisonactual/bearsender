// ═══════════════════════════════════════════════
// Connection store — the link to the controller
// ═══════════════════════════════════════════════

import { signal, computed, effect } from '@preact/signals';
import { lsGet, lsSet } from '../ui';

export type LinkStatus = 'disconnected' | 'connecting' | 'connected';

export const status = signal<LinkStatus>('disconnected');
export const transport = signal<'websocket' | 'serial'>('websocket');
/** The WebSocket URL, or a label for the serial port. */
export const address = signal('');
/** The firmware version from the [VER:] line of $I, once it has answered. */
export const firmware = signal('');

export const connected = computed(() => status.value === 'connected');

/** How CONNECT links up, set in Settings, Options, and kept in this browser. */
export interface LinkSettings {
  mode: 'websocket' | 'serial';
  wsUrl: string;
  baud: string; dataBits: string; stopBits: string; parity: string;
}
const LINK_DEFAULTS: LinkSettings = { mode: 'websocket', wsUrl: 'ws://192.168.5.1:80', baud: '115200', dataBits: '8', stopBits: '1', parity: 'none' };
export const settings = signal<LinkSettings>({ ...LINK_DEFAULTS, ...lsGet<Partial<LinkSettings>>('fs-opt-conn', {}) });
effect(() => lsSet('fs-opt-conn', settings.value));

/** Web Serial is in this browser (Chrome and Edge). */
export const serialSupported = typeof navigator !== 'undefined' && !!(navigator as any).serial;

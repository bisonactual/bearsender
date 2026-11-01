// ═══════════════════════════════════════════════
// Connection store — the link to the controller
// ═══════════════════════════════════════════════

import { signal, computed } from '@preact/signals';

export type LinkStatus = 'disconnected' | 'connecting' | 'connected';

export const status = signal<LinkStatus>('disconnected');
export const transport = signal<'websocket' | 'serial'>('websocket');
/** The WebSocket URL, or a label for the serial port. */
export const address = signal('');
/** The firmware version from the [VER:] line of $I, once it has answered. */
export const firmware = signal('');

export const connected = computed(() => status.value === 'connected');

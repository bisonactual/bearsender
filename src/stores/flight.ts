// What the flight recorder knows, for the screens (flight-recorder.ts sets it).

import { signal } from '@preact/signals';
import type { FlightRecord } from '../flight-recorder';

/** Switched on in BearSender (Settings, Flight recorder). */
export const enabled = signal(false);
/** The plugin the controller lists in $I, or null if it lists none. */
export const plugin = signal<{ version: string; storage: boolean } | null>(null);
/** The last [FLIGHT:] record read from the controller. */
export const record = signal<FlightRecord | null>(null);
/** [EVENT:] lines from the last $EVENTS read, oldest first. */
export const events = signal<string[]>([]);
export const eventsLoading = signal(false);
/** When the events were last read, or null if not read since connecting. */
export const eventsReadAt = signal<number | null>(null);
/** Whether the firmware has the watchdog ($793); null until known. */
export const watchdog = signal<boolean | null>(null);
/** "Uses undercut tools" is ticked for the loaded job. */
export const undercut = signal(false);

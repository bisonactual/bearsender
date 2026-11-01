// ═══════════════════════════════════════════════
// Camera store — the camera chosen in this browser, fed by camera.ts
// ═══════════════════════════════════════════════

import { signal, effect } from '@preact/signals';
import { lsGet, lsSet } from '../ui';

/** The camera last started here ('' for the browser's default), or null if none has been: no camera set up. */
export const device = signal<string | null>(lsGet<string | null>('fs-cam-device', null));
/** The camera is showing its picture. */
export const active = signal(false);

effect(() => lsSet('fs-cam-device', device.value));

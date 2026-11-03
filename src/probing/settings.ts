// ═══════════════════════════════════════════════
// The probe settings: one set for every routine (the owner, 3 Nov), kept per browser like the other
// options. Settings, Probe shows them (ProbeSettingsCard); the Probing screen opens it in a popup.
// ═══════════════════════════════════════════════

import { signal } from '@preact/signals';
import { lsGet, lsSet } from '../ui';

export interface ProbeSettings {
  /** Tip diameter, mm. */
  tip: number;
  /** Fast feed for the first touch and slow feed for the second, mm/min. */
  fast: number;
  slow: number;
  /** How far it backs off between the touches, mm. */
  back: number;
  /** How far clear of a side it goes down, mm (to the tip's edge). */
  clear: number;
  /** How far a touch searches, mm: the edges, the centre and rotation. Tool length has its own. */
  search: number;
}

const KEY = 'fs-probe-settings';
const DEFAULTS: ProbeSettings = { tip: 2, fast: 100, slow: 25, back: 1, clear: 5, search: 10 };

/** Before, each routine kept its own copy (fs-probing-tab-ef, -cf, -rot, -tl). The first time, the set is
 *  taken from the edge finder's, then the centre finder's, then rotation's, whichever was kept; tool
 *  length's feeds only if none of those was. */
function carried(): ProbeSettings {
  for (const sub of ['ef', 'cf', 'rot', 'tl']) {
    const o = lsGet<Record<string, unknown> | null>(`fs-probing-tab-${sub}`, null);
    if (!o) continue;
    const n = (k: string, d: number) => typeof o[k] === 'number' && Number.isFinite(o[k] as number) ? o[k] as number : d;
    const set = { ...DEFAULTS, fast: n('probeFeedRate', DEFAULTS.fast), slow: n('latchFeedRate', DEFAULTS.slow), back: n('latchDistance', DEFAULTS.back) };
    // Tool length's probe distance was its own search down (50 mm), not the edges' search.
    return sub === 'tl' ? set : { ...set, tip: n('probeDiameter', DEFAULTS.tip), clear: n('xyClr', DEFAULTS.clear), search: n('probeDistance', DEFAULTS.search) };
  }
  return DEFAULTS;
}

export const probe = signal<ProbeSettings>({ ...DEFAULTS, ...lsGet<Partial<ProbeSettings>>(KEY, carried()) });

export function setProbe(patch: Partial<ProbeSettings>): void {
  probe.value = { ...probe.value, ...patch };
  lsSet(KEY, probe.value);
}

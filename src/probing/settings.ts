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

/** The kept set, each value as a number: what isn't one becomes NaN, so it shows as unusable rather than
 *  as some other number. Values are kept as they were, right or wrong, and checked where they are used. */
function asNumbers(o: Record<string, unknown>): ProbeSettings {
  const n = (k: keyof ProbeSettings) => {
    const v = o[k] ?? DEFAULTS[k];
    return typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  };
  return { tip: n('tip'), fast: n('fast'), slow: n('slow'), back: n('back'), clear: n('clear'), search: n('search') };
}

export const probe = signal<ProbeSettings>(asNumbers(lsGet<Record<string, unknown>>(KEY, carried() as unknown as Record<string, unknown>) ?? {}));

/** What makes the settings unusable, in words; empty when they can be used. A routine never sends
 *  settings that can't be used: a back-off of 0 or below, say, would rapid into the wall it touched.
 *  Tool length uses the feeds and the back-off only. */
export function probeProblems(P: ProbeSettings, toolLength = false): string[] {
  const out: string[] = [];
  const need = (ok: boolean, v: number, what: string, rule: string) => {
    if (!ok) out.push(`${what} is ${Number.isFinite(v) ? v : 'not a number'} (${rule})`);
  };
  if (!toolLength) need(P.tip > 0, P.tip, 'the tip diameter', 'it must be above 0');
  need(P.fast > 0, P.fast, 'the fast feed', 'it must be above 0');
  need(P.slow > 0, P.slow, 'the slow feed', 'it must be above 0');
  need(P.back > 0, P.back, 'the back-off', 'it must be above 0');
  if (!toolLength) {
    need(P.clear > 0, P.clear, 'the clearance', 'it must be above 0');
    need(P.search > P.clear, P.search, 'the search distance', `it must be more than the clearance${Number.isFinite(P.clear) ? `, ${P.clear} mm` : ''}`);
  }
  return out;
}

export function setProbe(patch: Partial<ProbeSettings>): void {
  probe.value = { ...probe.value, ...patch };
  lsSet(KEY, probe.value);
}

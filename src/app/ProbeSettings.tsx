// ═══════════════════════════════════════════════
// Settings, Probe: the one set of probe settings every routine uses (src/probing/settings.ts). The
// Probing screen opens it in a popup from its one-line summary; the Settings screen can mount it too.
// ═══════════════════════════════════════════════

import * as ps from '../probing/settings';
import { Card, NumIn } from './SetupScreen';

/** A number field with its unit inside the box, as the Probing screen's fields are. */
export function UnitField({ label, value, unit, step, min, set }: { label: string; value: number; unit: string; step?: number; min?: number; set: (v: number) => void }) {
  return (
    <label class="fs-pfld"><span>{label}</span>
      <span class="fs-pin"><NumIn value={value} step={step} min={min} label={label} set={set} /><i>{unit}</i></span>
    </label>
  );
}

export function ProbeSettingsCard() {
  const P = ps.probe.value;
  const f = (k: keyof ps.ProbeSettings, label: string, unit: string, step: number, min: number) =>
    <UnitField label={label} value={P[k]} unit={unit} step={step} min={min} set={v => ps.setProbe({ [k]: Math.max(min, v) })} />;
  return (
    <Card title="PROBE" class="fs-probeset">
      <div class="fs-note">Every routine uses these. They rarely change, so they live here, in Settings, Probe. Changes are kept.</div>
      <div class="fs-prow">{f('tip', 'Tip diameter', 'mm', 0.001, 0)}{f('clear', 'Clearance from the side', 'mm', 0.5, 0)}</div>
      <div class="fs-prow">{f('fast', 'Fast feed, first touch', 'mm/min', 10, 1)}{f('slow', 'Slow feed, second touch', 'mm/min', 5, 1)}</div>
      <div class="fs-prow">{f('back', 'Back off between touches', 'mm', 0.1, 0.1)}{f('search', 'Search up to', 'mm', 1, 1)}</div>
      {ps.probeProblems(P).map(p => <div class="fs-note is-warn">Can't be used, so no routine sends it: {p}.</div>)}
      <div class="fs-note">Tool length keeps its own search distance and plate thickness on its card, and the edge finder's Z keeps its own plate.</div>
    </Card>
  );
}

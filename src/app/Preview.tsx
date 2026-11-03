// The Preview: the program in 3D, from the G-code interpreter.
//
// Machine coordinates: the work offsets, G92 and the tool length offset as the controller has them.
// Arcs draw as curves; the done part of the path follows the line being cut; the cone is the tool,
// at the machine position the controller reports.

import { useEffect, useRef, useState } from 'preact/hooks';
import { computed, effect } from '@preact/signals';
import * as program from '../stores/program';
import * as job from '../stores/job';
import * as machine from '../stores/machine';
import * as connection from '../stores/connection';
import { atLine } from './mode';
import { attachViewport, showProgram, showExecuted, setView, fitView, toggleToolhead, toolGroup } from '../viewport';
import { overlay, stepPreview3D, playPreview3D, clearPreview3D } from '../probing/probe-preview-3d';

const VIEWS: [string, string][] = [['iso', 'ISO'], ['top', 'TOP'], ['front', 'FRONT'], ['side', 'SIDE']];
const num = (v: number) => v.toLocaleString('en-GB');
const arcCount = computed(() => program.view.value?.program.moves.reduce((n, m) => n + (m.kind === 'arc' ? 1 : 0), 0) ?? 0);

/** The probe or surfacing preview over the 3D view: the step's machine position and name, stepped or played. */
function ProbeOverlay() {
  const o = overlay.value;
  if (!o) return null;
  return (
    <div class="fs-pv-probe">
      <div class="pp-overlay" style={{ display: 'flex' }}>
        <div class="pp-dro">
          {(['x', 'y', 'z'] as const).map(a => (
            <div class="pp-dro-row"><span class="pp-axis">{a.toUpperCase()}</span><span class="pp-val">{o[a].toFixed(3)}</span></div>
          ))}
          <div class="pp-label">{o.label}</div>
        </div>
        <div class="pp-controls">
          <button type="button" class="pp-btn" title="Previous step" disabled={o.step <= 0} onClick={() => stepPreview3D(-1)}>◀</button>
          <button type="button" class="pp-btn pp-btn-play" title={o.playing ? 'Pause' : 'Play'} onClick={() => playPreview3D()}>{o.playing ? '⏸' : '▶'}</button>
          <button type="button" class="pp-btn" title="Next step" disabled={o.step >= o.total - 1} onClick={() => stepPreview3D(1)}>▶|</button>
          <span class="pp-counter">{o.step + 1} / {o.total}</span>
          <button type="button" class="pp-btn pp-btn-close" title="Close preview" onClick={() => clearPreview3D()}>✕</button>
        </div>
      </div>
    </div>
  );
}

export function Preview() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [view, pickView] = useState('iso');
  const [tool, showTool] = useState(true);

  useEffect(() => {
    attachViewport(canvas.current!);
    let drawn: program.ProgramView | null | undefined;
    let fittedFor: string[] | null = null;
    return effect(() => {
      const v = program.view.value;
      if (v !== drawn) {
        drawn = v;
        showProgram(v?.program ?? null);
        // Fit a new file; a new reading of the same file (offsets read on connect) keeps the view.
        const lines = job.lines.peek();
        if (v && lines !== fittedFor) { fittedFor = lines; fitView(); }
      }
      if (!v) return;
      const lines = v.program.lines;
      const at = job.result.value === 'completed' ? lines.length : atLine.value;
      showExecuted(at > 0 ? lines[Math.min(at, lines.length) - 1].moveRange[1] : 0);
    });
  }, []);

  const v = program.view.value;
  const p = v?.program;
  const pos = machine.mpos.value;
  const arcs = arcCount.value;
  return (
    <div class="fs-pv">
      <div class="fs-pv-head">
        {VIEWS.map(([id, label]) => (
          <button type="button" class={'fs-pv-btn' + (view === id ? ' is-on' : '')} aria-pressed={view === id ? 'true' : 'false'}
            onClick={() => { setView(id); pickView(id); }}>{label}</button>
        ))}
        <button type="button" class="fs-pv-btn" onClick={() => fitView()}>FIT</button>
        <button type="button" class={'fs-pv-btn' + (tool ? ' is-on' : '')} aria-pressed={tool ? 'true' : 'false'} title="Show the tool at the machine position"
          onClick={() => { toggleToolhead(); showTool(toolGroup.visible); }}>TOOL</button>
        <span class="fs-grow" />
        <span class="fs-pv-legend">
          <span><i style={{ background: 'var(--vp-cut)' }} />CUT</span>
          <span><i style={{ background: 'var(--vp-rapid)' }} />RAPID</span>
          <span><i style={{ background: 'var(--vp-executed)' }} />DONE</span>
          <span><i style={{ background: 'var(--vp-tool)' }} />TOOL</span>
        </span>
      </div>
      <div class="fs-pv-wrap">
        <canvas ref={canvas} class="fs-pv-canvas" />
        <div class="fs-pv-stats fs-mono">
          {!job.file.value ? 'No program loaded'
            : !v ? 'Reading the program…'
            : <>
                {num(p!.moves.length)} moves, {num(arcs)} arcs · read in {num(Math.round(v.readMs))} ms<br />
                {v.stopped ? <>read up to line {num(v.stopped.line)}<br /></> : null}
                {connection.connected.value ? <>tool at machine X {pos.x.toFixed(3)} Y {pos.y.toFixed(3)} Z {pos.z.toFixed(3)}</> : 'connect to see the tool'}
              </>}
        </div>
        <ProbeOverlay />
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════
// The job screen's Camera tab: the webcam with a crosshair, and the camera's offset from the spindle
// ═══════════════════════════════════════════════
//
// The camera runs only while this tab shows on the job screen. Drag the picture (mouse or finger) to move
// the crosshair; CENTRE, or a right-click, puts it back in the middle.

import { useEffect, useRef } from 'preact/hooks';
import { effect, untracked } from '@preact/signals';
import * as cam from '../camera';
import * as camera from '../stores/camera';
import * as connection from '../stores/connection';
import * as machine from '../stores/machine';
import { panel } from './mode';
import * as ui from './ui';

const STYLES: [cam.CrossStyle, string, string][] = [['cross', '+', 'Cross'], ['circle', '○', 'Circle'], ['both', '⊕', 'Cross and circle'], ['dot', '·', 'Dot']];
const COLOURS: [string, string][] = [['#00d4ff', 'CYN'], ['#00e676', 'GRN'], ['#ff3d3d', 'RED'], ['#ffffff', 'WHT']];
const fix = (v: number) => v.toFixed(3);

function Picture() {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => cam.attachCamera(video.current!, canvas.current!), []);
  // Runs the camera while this tab shows on the job screen.
  useEffect(() => effect(() => {
    const on = ui.screen.value === 'job' && panel.value === 'camera';
    untracked(() => { if (on) cam.showCamera(); else cam.hideCamera(); });
  }), []);
  const drag = useRef<{ id: number; x: number; y: number; cx: number; cy: number } | null>(null);
  const frac = (e: PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };
  const active = camera.active.value;
  return (
    <div class="fs-cam-main">
      {!active && <div class="fs-cam-off">{camera.device.value === null ? 'No camera started yet.' : 'Camera off.'} Pick a camera and press START.</div>}
      <div class="fs-cam-wrap" hidden={!active}>
        <video ref={video} autoplay playsinline muted />
        <canvas ref={canvas}
          onPointerDown={e => {
            const p = frac(e);
            drag.current = { id: e.pointerId, x: p.x, y: p.y, cx: cam.cross.value.x, cy: cam.cross.value.y };
            try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch (_) {}
          }}
          onPointerMove={e => {
            const d = drag.current;
            if (!d || d.id !== e.pointerId) return;
            const p = frac(e);
            cam.setCross(d.cx + p.x - d.x, d.cy + p.y - d.y);
          }}
          onPointerUp={() => { drag.current = null; }}
          onPointerCancel={() => { drag.current = null; }}
          onContextMenu={e => { e.preventDefault(); cam.setCross(0.5, 0.5); }} />
      </div>
    </div>
  );
}

function Controls() {
  const v = cam.view.value;
  const active = camera.active.value;
  const linked = connection.connected.value;
  const m = machine.mpos.value;
  const measuring = cam.measuring.value;
  const canMove = linked && active;
  return (
    <div class="fs-cam-side">
      <label class="fs-field"><span>Camera source</span>
        <select class="fs-in" value={cam.picked.value} onChange={e => { if (active) cam.stopCamera(); cam.picked.value = (e.target as HTMLSelectElement).value; }}>
          <option value="">— select camera —</option>
          {cam.devices.value.map(d => <option value={d.id}>{d.label}</option>)}
        </select>
      </label>
      <div class="fs-cam-pair">
        <button type="button" class="fs-btn fs-btn-sm" disabled={active} onClick={() => cam.startCamera()}>START</button>
        <button type="button" class="fs-btn fs-btn-sm is-stop" disabled={!active} onClick={() => cam.stopCamera()}>STOP</button>
      </div>
      <label class="fs-field"><span>Zoom <b class="fs-mono">{v.zoom.toFixed(1)}x</b></span>
        <input type="range" class="fs-range" min="1" max="8" step="0.1" value={v.zoom} onInput={e => cam.setView({ zoom: parseFloat((e.target as HTMLInputElement).value) })} />
      </label>
      <div class="fs-field"><span>Crosshair</span>
        <div class="fs-seg fs-seg-sm" role="radiogroup" aria-label="Crosshair style">
          {STYLES.map(([s, mark, name]) => (
            <button type="button" role="radio" aria-checked={v.crossStyle === s ? 'true' : 'false'} aria-label={name} title={name}
              class={v.crossStyle === s ? 'is-on' : ''} onClick={() => cam.setView({ crossStyle: s })}>{mark}</button>
          ))}
        </div>
      </div>
      <label class="fs-field"><span>Crosshair size <b class="fs-mono">{v.crossSize}</b></span>
        <input type="range" class="fs-range" min="20" max="300" value={v.crossSize} onInput={e => cam.setView({ crossSize: parseInt((e.target as HTMLInputElement).value) })} />
      </label>
      <div class="fs-cam-colours" role="radiogroup" aria-label="Crosshair colour">
        {COLOURS.map(([c, name]) => (
          <button type="button" role="radio" aria-checked={v.crossColor === c ? 'true' : 'false'} class={'fs-btn fs-btn-xs' + (v.crossColor === c ? ' is-on' : '')}
            style={{ color: c, borderColor: v.crossColor === c ? c : undefined }} onClick={() => cam.setView({ crossColor: c })}>{name}</button>
        ))}
        <button type="button" class="fs-btn fs-btn-xs" title="Put the crosshair back in the middle (right-click does too)" onClick={() => cam.setCross(0.5, 0.5)}>CENTRE</button>
      </div>
      <div class="fs-field"><span>Camera offset from the spindle (mm)</span>
        <div class="fs-cam-pair">
          {(['offsetX', 'offsetY'] as const).map(k => (
            <label class="fs-cam-off-in"><b>{k === 'offsetX' ? 'X' : 'Y'}</b>
              <input type="number" step="0.001" class="fs-in fs-mono" aria-label={'Camera offset ' + (k === 'offsetX' ? 'X' : 'Y')} value={v[k]}
                onChange={e => { const n = parseFloat((e.target as HTMLInputElement).value); if (Number.isFinite(n)) cam.setView({ [k]: n }); }} /></label>
          ))}
        </div>
      </div>
      <div class="fs-cam-pair">
        <button type="button" class={'fs-btn fs-btn-sm' + (measuring ? ' is-accent' : '')} disabled={!linked} onClick={() => cam.measureOffset()}>
          {measuring ? 'CONFIRM OFFSET' : 'MEASURE OFFSET'}</button>
        {measuring && <button type="button" class="fs-btn fs-btn-sm" onClick={() => cam.cancelMeasure()}>CANCEL</button>}
      </div>
      {measuring && <div class="fs-note">Spindle taken at X {fix(measuring.x)} Y {fix(measuring.y)}. Jog until the crosshair is over the same mark, then CONFIRM OFFSET.</div>}
      <div class="fs-cam-pos fs-mono">
        <div><span class="fs-dim">Spindle</span> X {fix(m.x)} Y {fix(m.y)}</div>
        <div><span class="fs-dim">Camera</span> X {fix(m.x + v.offsetX)} Y {fix(m.y + v.offsetY)}</div>
      </div>
      <button type="button" class="fs-btn fs-btn-sm" disabled={!canMove} onClick={() => cam.goToCamera()}>→ MOVE TO CAMERA POS</button>
      <button type="button" class="fs-btn fs-btn-sm" disabled={!canMove} onClick={() => cam.goToSpindle()}>← MOVE TO SPINDLE POS</button>
      <button type="button" class="fs-btn fs-btn-sm is-go" disabled={!canMove} onClick={() => cam.zeroAtCrosshair()}>⊕ ZERO WCS HERE</button>
    </div>
  );
}

export function CameraPanel() {
  return (
    <div class="fs-cam">
      <Controls />
      <Picture />
    </div>
  );
}

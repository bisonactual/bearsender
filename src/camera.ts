// ═══════════════════════════════════════════════
// Camera engine — the webcam, the crosshair over it, and the camera's offset from the spindle
// ═══════════════════════════════════════════════
//
// The job screen's Camera tab (src/app/CameraPanel.tsx) hands over its video and canvas, and runs the
// camera only while it shows. The offset is where the spindle goes to put the crosshair over the point the
// spindle was over: MEASURE OFFSET takes it from two machine positions.

import { signal, effect } from '@preact/signals';
import { lsGet, lsSet } from './ui';
import { log } from './console';
import { sendCmd } from './connection';
import * as machine from './stores/machine';
import * as connection from './stores/connection';
import * as camera from './stores/camera';

export type CrossStyle = 'cross' | 'circle' | 'both' | 'dot';
interface CamSettings { offsetX: number; offsetY: number; crossStyle: CrossStyle; crossColor: string; crossSize: number; zoom: number; }

/** The cameras this browser can see, once it has been allowed to. */
export const devices = signal<{ id: string; label: string }[]>([]);
/** The camera picked in the list ('' for the browser's default). */
export const picked = signal<string>(camera.device.value ?? '');
/** The overlay and the offset, kept in this browser. */
export const view = signal<CamSettings>({
  offsetX: 0, offsetY: 0, crossStyle: 'cross', crossColor: '#00d4ff', crossSize: 80, zoom: 1,
  ...lsGet<Partial<CamSettings>>('flexisender_cam', {}),
});
effect(() => lsSet('flexisender_cam', view.value));
/** The crosshair, as a fraction of the picture: 0.5, 0.5 is the middle. */
export const cross = signal({ x: 0.5, y: 0.5 });
/** The spindle position MEASURE OFFSET took first, while it waits for CONFIRM OFFSET. */
export const measuring = signal<{ x: number; y: number } | null>(null);

export function setView(patch: Partial<CamSettings>): void { view.value = { ...view.value, ...patch }; }

let video: HTMLVideoElement | null = null;
let canvas: HTMLCanvasElement | null = null;
let stream: MediaStream | null = null;
let listed = false;

/** The Camera tab's video and canvas. */
export function attachCamera(v: HTMLVideoElement, c: HTMLCanvasElement): () => void {
  video = v; canvas = c;
  const observer = new ResizeObserver(resizeCanvas);
  observer.observe(v);
  return () => { observer.disconnect(); if (video === v) { video = null; canvas = null; } };
}

/** Asks for the camera once, so the list has names, then lists the cameras. */
async function listCameras(): Promise<void> {
  try { (await navigator.mediaDevices.getUserMedia({ video: true })).getTracks().forEach(t => t.stop()); } catch (_) {}
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
  devices.value = cams.map((d, i) => ({ id: d.deviceId, label: d.label || 'Camera ' + (i + 1) }));
  if (!picked.value && cams.length === 1) picked.value = cams[0].deviceId;
  listed = true;
}

// The Camera tab runs the camera only while it shows.
let wanted = false;
let starting = false;

/** The Camera tab is showing: start the camera chosen before, if it is plugged in. */
export async function showCamera(): Promise<void> {
  wanted = true;
  if (!listed) await listCameras();
  const id = camera.device.value;
  if (!wanted || starting || camera.active.value || id === null) return;
  if (id && !devices.value.some(d => d.id === id)) return;
  picked.value = id;
  starting = true;
  try { await startCamera(); } finally { starting = false; }
  if (!wanted) stopCamera();
}

/** The Camera tab is hidden: stop the camera. */
export function hideCamera(): void {
  wanted = false;
  if (camera.active.value) stopCamera();
}

export async function startCamera(): Promise<void> {
  if (!video) return;
  const id = picked.value;
  const size = { width: { ideal: 1920 }, height: { ideal: 1080 } };
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: id ? { deviceId: { exact: id }, ...size } : size });
    video.srcObject = stream;
    await new Promise(res => { video!.onloadedmetadata = res; });
    video.play();
    camera.active.value = true;
    camera.device.value = id;
    resizeCanvas();
    requestAnimationFrame(loop);
  } catch (e: any) {
    log('err', 'Camera error: ' + e.message);
  }
}

export function stopCamera(): void {
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  if (video) video.srcObject = null;
  camera.active.value = false;
}

function resizeCanvas(): void {
  if (!video || !canvas) return;
  canvas.width = video.offsetWidth;
  canvas.height = video.offsetHeight;
}

function loop(): void {
  if (!camera.active.value) return;
  drawOverlay();
  requestAnimationFrame(loop);
}

/** The zoomed picture around the crosshair, and the crosshair. */
function drawOverlay(): void {
  if (!video || !canvas || !canvas.width || !canvas.height) return;
  const ctx = canvas.getContext('2d')!;
  const w = canvas.width, h = canvas.height;
  const v = view.value, c = cross.value;
  ctx.clearRect(0, 0, w, h);

  if (v.zoom > 1) {
    const vw = video.videoWidth || w, vh = video.videoHeight || h;
    const zw = vw / v.zoom, zh = vh / v.zoom;
    ctx.drawImage(video, Math.max(0, c.x * vw - zw / 2), Math.max(0, c.y * vh - zh / 2), zw, zh, 0, 0, w, h);
  }

  const cx = c.x * w, cy = c.y * h, sz = v.crossSize;
  ctx.save();
  ctx.strokeStyle = v.crossColor;
  ctx.lineWidth = 1.5;
  ctx.shadowColor = 'rgba(0,0,0,0.8)';
  ctx.shadowBlur = 3;
  if (v.crossStyle === 'cross' || v.crossStyle === 'both') {
    const gap = 8;
    ctx.beginPath(); ctx.moveTo(cx - sz, cy); ctx.lineTo(cx - gap, cy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx + gap, cy); ctx.lineTo(cx + sz, cy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, cy - sz); ctx.lineTo(cx, cy - gap); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, cy + gap); ctx.lineTo(cx, cy + sz); ctx.stroke();
  }
  if (v.crossStyle === 'circle' || v.crossStyle === 'both') {
    ctx.beginPath(); ctx.arc(cx, cy, sz * 0.5, 0, Math.PI * 2); ctx.stroke();
  }
  if (v.crossStyle === 'dot') {
    ctx.fillStyle = v.crossColor;
    ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.moveTo(cx - 12, cy); ctx.lineTo(cx + 12, cy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, cy - 12); ctx.lineTo(cx, cy + 12); ctx.stroke();
  }
  ctx.restore();
}

/** Moves the crosshair to a point of the picture, as fractions; kept off the very edge. */
export function setCross(x: number, y: number): void {
  cross.value = { x: Math.max(0.05, Math.min(0.95, x)), y: Math.max(0.05, Math.min(0.95, y)) };
}

// ── The offset, and moves by it ───────────────────────────────────────────────

/** First press: the spindle's position, over a mark. Second press, with the crosshair jogged over the same
 *  mark: the offset is how far the machine moved. */
export function measureOffset(): void {
  if (!connection.connected.value) { log('err', 'Not connected'); return; }
  const m = machine.mpos.value;
  const start = measuring.value;
  if (!start) {
    measuring.value = { x: m.x, y: m.y };
    log('info', 'Camera offset: spindle position recorded at X:' + m.x.toFixed(3) + ' Y:' + m.y.toFixed(3));
    log('info', 'Now jog so the camera crosshair is over the same point, then press CONFIRM OFFSET.');
    return;
  }
  setView({ offsetX: +(m.x - start.x).toFixed(4), offsetY: +(m.y - start.y).toFixed(4) });
  measuring.value = null;
  log('info', 'Camera offset set: X:' + view.value.offsetX + ' Y:' + view.value.offsetY + ' mm');
}

export function cancelMeasure(): void { measuring.value = null; }

// A machine position, so machine-coordinate moves (G53), in mm.
export function goToCamera(): void {
  const m = machine.mpos.value, v = view.value;
  sendCmd('G21 G53 G0 X' + (m.x + v.offsetX).toFixed(4) + ' Y' + (m.y + v.offsetY).toFixed(4));
  log('info', 'Moving spindle to camera position');
}

export function goToSpindle(): void {
  const m = machine.mpos.value, v = view.value;
  sendCmd('G21 G53 G0 X' + (m.x - v.offsetX).toFixed(4) + ' Y' + (m.y - v.offsetY).toFixed(4));
  log('info', 'Moving spindle back from camera position');
}

/** Work X0 Y0 where the crosshair is: the spindle is the offset away from it. */
export function zeroAtCrosshair(): void {
  const v = view.value;
  sendCmd('G21 G10 L20 P' + machine.activeP.value + ' X' + v.offsetX.toFixed(4) + ' Y' + v.offsetY.toFixed(4));
  log('info', 'WCS zeroed at camera position');
}

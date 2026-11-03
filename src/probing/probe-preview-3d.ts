// A probing or surfacing plan in the job screen's 3D view, stepped through or played.

import { signal } from '@preact/signals';
import * as machine from '../stores/machine';
import { scene, cutLines, rapidLines, executedLine } from '../viewport';
import type { Waypoint } from '../surfacing';

import * as THREE from 'three';

let waypoints: Waypoint[] = [];
let step = 0;
let playing = false;
let playTimer: ReturnType<typeof setInterval> | null = null;
let autoTimer: ReturnType<typeof setTimeout> | null = null;
let pathGroup: any = null;
let probeGhost: any = null;

const STEP_INTERVAL = 400;

export interface Overlay { step: number; total: number; playing: boolean; x: number; y: number; z: number; label: string; }
/** What the Preview's overlay shows (src/app/Preview.tsx): the step, its machine position and name; null with
 *  no preview. */
export const overlay = signal<Overlay | null>(null);

const SEG_COLOR: Record<string, number> = {
  rapid: 0x3B82F6,    // blue
  probe: 0xF97316,    // orange
  retract: 0x6366F1,  // indigo
  contact: 0x22C55E,  // green
  start: 0x94A3B8,    // slate
};

function toThree(mx: number, my: number, mz: number): any {
  return new THREE.Vector3(mx, mz, -my);
}

function buildPathLines(wps: Waypoint[], upTo: number): void {
  if (pathGroup) {
    scene.remove(pathGroup);
    pathGroup.traverse((c: any) => { c.geometry?.dispose(); c.material?.dispose(); });
  }
  pathGroup = new THREE.Group();
  const { x: ox, y: oy, z: oz } = machine.mpos.peek();

  for (let i = 1; i < wps.length; i++) {
    const a = wps[i - 1], b = wps[i];
    const pa = toThree(ox + a.x, oy + a.y, oz + a.z);
    const pb = toThree(ox + b.x, oy + b.y, oz + b.z);
    const geo = new THREE.BufferGeometry().setFromPoints([pa, pb]);
    const isPast = i <= upTo;
    const color = SEG_COLOR[b.type] ?? 0x888888;
    const mat = new THREE.LineDashedMaterial({
      color,
      dashSize: b.type === 'probe' ? 0 : 3,
      gapSize: b.type === 'probe' ? 0 : 2,
      transparent: true,
      opacity: isPast ? 0.85 : 0.2,
    });
    const line = new THREE.Line(geo, mat);
    line.computeLineDistances();
    pathGroup.add(line);
  }

  for (let i = 0; i <= upTo && i < wps.length; i++) {
    const wp = wps[i];
    if (wp.type !== 'contact') continue;
    const pos = toThree(ox + wp.x, oy + wp.y, oz + wp.z);
    const geo = new THREE.SphereGeometry(1.2, 8, 8);
    const mat = new THREE.MeshBasicMaterial({ color: 0x22C55E, transparent: true, opacity: 0.9 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(pos);
    pathGroup.add(mesh);
  }

  scene.add(pathGroup);
}

function updateGhost(wp: Waypoint): void {
  if (!probeGhost) {
    const mat = new THREE.MeshBasicMaterial({ color: 0xF97316, transparent: true, opacity: 0.5, depthWrite: false });
    probeGhost = new THREE.Group();
    const cone = new THREE.Mesh(new THREE.CylinderGeometry(0, 1.5, 4, 8), mat);
    cone.rotation.x = Math.PI;
    cone.position.y = 2;
    probeGhost.add(cone);
    const body = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 6, 8), mat);
    body.position.y = 7;
    probeGhost.add(body);
    scene.add(probeGhost);
  }
  const { x: ox, y: oy, z: oz } = machine.mpos.peek();
  probeGhost.position.copy(toThree(ox + wp.x, oy + wp.y, oz + wp.z));
}

function dimToolpath(dim: boolean): void {
  [cutLines, rapidLines, executedLine].forEach((obj: any) => {
    if (!obj) return;
    if (dim) {
      obj.material.opacity = 0.12;
      obj.material.transparent = true;
    } else {
      if (obj === cutLines) { obj.material.opacity = 0.85; obj.material.transparent = true; }
      if (obj === rapidLines) { obj.material.opacity = 0.5; obj.material.transparent = true; }
      if (obj === executedLine) { obj.material.opacity = 1; obj.material.transparent = false; }
    }
    obj.material.needsUpdate = true;
  });
}

export function loadPreview3D(wps: Waypoint[]): void {
  clearPreview3D();
  if (!wps.length) return;
  waypoints = wps;
  step = 0;
  dimToolpath(true);
  buildPathLines(waypoints, step);
  updateGhost(waypoints[0]);
  publishOverlay();
  playPreview3D();
}

export function clearPreview3D(): void {
  stopPlay();
  if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
  if (pathGroup) {
    scene.remove(pathGroup);
    pathGroup.traverse((c: any) => { c.geometry?.dispose(); c.material?.dispose(); });
    pathGroup = null;
  }
  if (probeGhost) {
    scene.remove(probeGhost);
    probeGhost.traverse((c: any) => { c.geometry?.dispose(); c.material?.dispose(); });
    probeGhost = null;
  }
  dimToolpath(false);
  waypoints = [];
  step = 0;
  publishOverlay();
}

export function stepPreview3D(dir: number): void {
  if (!waypoints.length) return;
  step = Math.max(0, Math.min(waypoints.length - 1, step + dir));
  buildPathLines(waypoints, step);
  updateGhost(waypoints[step]);
  publishOverlay();
}

export function playPreview3D(): void {
  if (!waypoints.length) return;
  if (playing) { stopPlay(); return; }
  if (step >= waypoints.length - 1) step = 0;
  playing = true;
  publishOverlay();
  playTimer = setInterval(() => {
    step++;
    buildPathLines(waypoints, step);
    updateGhost(waypoints[step]);
    if (step >= waypoints.length - 1) stopPlay();
    else publishOverlay();
  }, STEP_INTERVAL);
}

function stopPlay(): void {
  if (playTimer) { clearInterval(playTimer); playTimer = null; }
  playing = false;
  publishOverlay();
}

/** The overlay's state now, or null when no preview shows. */
function publishOverlay(): void {
  const wp = waypoints[step];
  if (!wp) { overlay.value = null; return; }
  const o = machine.mpos.peek();
  overlay.value = { step, total: waypoints.length, playing, x: o.x + wp.x, y: o.y + wp.y, z: o.z + wp.z, label: wp.label || typeLabel(wp.type) };
}

function typeLabel(type: string): string {
  switch (type) {
    case 'start': return 'Start position';
    case 'rapid': return 'Rapid move';
    case 'probe': return 'Probing…';
    case 'retract': return 'Retract';
    case 'contact': return '⊕ Contact';
    default: return '';
  }
}

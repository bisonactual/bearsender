// Jogging by click, hold and keyboard, and the jog preview in the 3D view. The views (the Setup
// screen, the jog popup) read these signals and call startJog and stopJog.

import { signal, effect } from '@preact/signals';
import * as THREE from 'three';
import { isInputFocused, lsGet, lsSet } from './ui';
import { sendCmd, rtSend, setJogging } from './connection';
import { scene, toolGroup } from './viewport';
import * as command from './command';
import * as connection from './stores/connection';
import * as machine from './stores/machine';
import * as job from './stores/job';

// Arrow keys and Page Up/Down jog while held: a long jog, cancelled on release.
const KEY_DIRECTIONS: Record<string, string> = {
  'ArrowLeft': 'X-', 'ArrowRight': 'X+',
  'ArrowDown': 'Y-', 'ArrowUp': 'Y+',
  'PageDown': 'Z-', 'PageUp': 'Z+',
};
const KEY_JOG_DISTANCE = 100000;

// What the views show

/** Hold mode: a jog runs while its button is held, and stops on release. Click mode: one step per tap. */
export const holdMode = signal(false);
export const stepXY = signal(10);
export const stepZ = signal(1);
/** The step sizes offered, from Settings, Options. */
export const stepsXY = signal<number[]>([0.01, 0.1, 1, 10, 50]);
export const stepsZ = signal<number[]>([0.01, 0.1, 1, 5, 10]);
/** Jog feed (mm/min), clamped to the axis maximum when sent. */
export const feed = signal(lsGet('fs-jog-feed', 1000));
export const maxXY = signal(3000);
export const maxZ = signal(500);
/** The direction a held arrow key is jogging, to light its button. */
export const keyDir = signal<string | null>(null);

effect(() => lsSet('fs-jog-feed', feed.value));

let isHolding = false;

// The jog preview in the 3D view
let hoverGhost: any = null;       // where the next click would go
let previewLines: any[] = [];     // dashed line segments
let previewFrame = 0;
let hoverTarget: any = null;      // the hover ghost's position (THREE.Vector3)
let hoverColor = 0;

interface Waypoint { pos: any; ghost: any; color: number; }
const waypoints: Waypoint[] = [];

// Where the tool will be once the queued click-mode jogs are done, in three.js coordinates
const predicted = { x: 0, y: 0, z: 0 };
let predictedDirty = false;

const WAYPOINT_ARRIVE_DIST = 1.0;

function makeGhost(color: number, opacity: number): any {
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
  const ghost = new THREE.Group();
  const cone = new THREE.Mesh(new THREE.CylinderGeometry(0, 1.5, 4, 8), mat);
  cone.rotation.x = Math.PI;
  cone.position.y = 2;
  ghost.add(cone);
  const body = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 6, 8), mat);
  body.position.y = 7;
  ghost.add(body);
  return ghost;
}

function removeGhost(ghost: any): void {
  if (!ghost) return;
  scene.remove(ghost);
  ghost.traverse?.((c: any) => { c.geometry?.dispose(); c.material?.dispose(); });
}

function syncPredicted(): void {
  if (!toolGroup) return;  // the 3D view isn't built yet
  if (!predictedDirty) {
    predicted.x = toolGroup.position.x;
    predicted.y = toolGroup.position.y;
    predicted.z = toolGroup.position.z;
  }
  // The waypoints the tool has reached go.
  while (waypoints.length > 0) {
    const wp = waypoints[0];
    const dx = toolGroup.position.x - wp.pos.x;
    const dy = toolGroup.position.y - wp.pos.y;
    const dz = toolGroup.position.z - wp.pos.z;
    if (Math.sqrt(dx * dx + dy * dy + dz * dz) >= WAYPOINT_ARRIVE_DIST) break;
    removeGhost(wp.ghost);
    waypoints.shift();
  }
}

function clearPredictionAtRest(stateName: string): void {
  if (!predictedDirty || !toolGroup) return;
  if (stateName === 'idle' || stateName === 'alarm') {
    for (const wp of waypoints) removeGhost(wp.ghost);
    waypoints.length = 0;
    predicted.x = toolGroup.position.x;
    predicted.y = toolGroup.position.y;
    predicted.z = toolGroup.position.z;
    predictedDirty = false;
  }
}

// The machine position moves the tool in the 3D view (parser.ts); the preview follows it.
effect(() => { machine.mpos.value; syncPredicted(); });
effect(() => clearPredictionAtRest(machine.stateName.value));

function addWaypoint(pos: any, color: number): void {
  const ghost = makeGhost(color, 0.2);
  ghost.position.copy(pos);
  scene.add(ghost);
  waypoints.push({ pos: pos.clone(), ghost, color });
}

export function clearHoverPreview(): void {
  if (previewFrame) { cancelAnimationFrame(previewFrame); previewFrame = 0; }
  hoverTarget = null;
  removeGhost(hoverGhost);
  hoverGhost = null;
  clearPreviewLines();
}

function clearPreviewLines(): void {
  for (const l of previewLines) { scene.remove(l); l.geometry?.dispose(); l.material?.dispose(); }
  previewLines = [];
}

/** The colour of a direction, shared by the buttons and the 3D preview: X red, Y green, Z blue, diagonals amber. */
export function directionColor(v: { x: number; y: number; z: number }): number {
  return v.z !== 0 ? 0x3399ff : v.x !== 0 && v.y !== 0 ? 0xffaa00 : v.x !== 0 ? 0xff3333 : 0x33ff66;
}

export function directionVector(dir: string): { x: number; y: number; z: number } {
  let x = 0, y = 0, z = 0;
  if (dir.includes('X+')) x = 1; if (dir.includes('X-')) x = -1;
  if (dir.includes('Y+')) y = 1; if (dir.includes('Y-')) y = -1;
  if (dir.includes('Z+')) z = 1; if (dir.includes('Z-')) z = -1;
  return { x, y, z };
}

/** Shows where a tap would go (click mode) or which way a hold would run (hold mode). */
export function showJogPreview(dir: string): void {
  clearHoverPreview();
  const v = directionVector(dir);
  const color = directionColor(v);
  hoverColor = color;

  if (holdMode.value) {
    const pos = toolGroup.position;
    const len = 30;
    const arrowDir = new THREE.Vector3(v.x, v.z, -v.y).normalize();
    const arrow = new THREE.ArrowHelper(arrowDir, pos.clone(), len, color, len * 0.3, len * 0.15);
    scene.add(arrow);
    hoverGhost = arrow;
    return;
  }
  const sx = v.x * (v.z !== 0 ? 0 : stepXY.value);
  const sy = v.y * (v.z !== 0 ? 0 : stepXY.value);
  const sz = v.z * stepZ.value;
  hoverTarget = new THREE.Vector3(predicted.x + sx, predicted.y + sz, predicted.z - sy);
  hoverGhost = makeGhost(color, 0.35);
  hoverGhost.position.copy(hoverTarget);
  scene.add(hoverGhost);
  updatePreviewLines();
  startPreviewAnim();
}

function updatePreviewLines(): void {
  clearPreviewLines();
  // From the tool through each waypoint to the hover target
  const points: any[] = [toolGroup.position.clone()];
  for (const wp of waypoints) points.push(wp.pos.clone());
  if (hoverTarget) points.push(hoverTarget.clone());
  if (points.length < 2) return;
  for (let i = 0; i < points.length - 1; i++) {
    const isHoverSegment = hoverTarget && i === points.length - 2;
    const color = isHoverSegment ? hoverColor : (waypoints[i - 1]?.color ?? hoverColor);
    const geo = new THREE.BufferGeometry().setFromPoints([points[i], points[i + 1]]);
    const line = new THREE.Line(geo, new THREE.LineDashedMaterial({ color, dashSize: 3, gapSize: 2, transparent: true, opacity: isHoverSegment ? 0.6 : 0.8 }));
    line.computeLineDistances();
    scene.add(line);
    previewLines.push(line);
  }
}

function startPreviewAnim(): void {
  if (previewFrame) return;
  const tick = () => {
    if (!hoverTarget && waypoints.length === 0) { previewFrame = 0; return; }
    updatePreviewLines();
    previewFrame = requestAnimationFrame(tick);
  };
  previewFrame = requestAnimationFrame(tick);
}

// Steps and speeds, from Settings, Options

export function setSteps(xy: number[], z: number[]): void {
  stepsXY.value = xy;
  stepsZ.value = z;
}

export function setMaxSpeeds(xy: number, z: number): void {
  maxXY.value = Math.max(1, xy);
  maxZ.value = Math.max(1, z);
  feed.value = Math.min(feed.value, Math.max(maxXY.value, maxZ.value));
}

// Jog commands

function feedFor(isZ: boolean): number {
  return Math.min(Math.max(1, Math.round(feed.value) || 1), isZ ? maxZ.value : maxXY.value);
}

export function startJog(dir: string): void {
  if (!connection.connected.value) return;
  const v = directionVector(dir);
  const jogFeed = feedFor(v.z !== 0);
  const step = stepXY.value;
  const color = directionColor(v);
  const hold = holdMode.value;

  if (!predictedDirty) {
    predicted.x = toolGroup.position.x;
    predicted.y = toolGroup.position.y;
    predicted.z = toolGroup.position.z;
  }

  // The hover ghost becomes a waypoint.
  if (hoverGhost && hoverTarget && !hold) {
    hoverGhost.traverse?.((c: any) => { if (c.material) { c.material.opacity = 0.2; c.material.needsUpdate = true; } });
    waypoints.push({ pos: hoverTarget.clone(), ghost: hoverGhost, color: hoverColor });
    hoverGhost = null;
    hoverTarget = null;
  }

  // Both modes jog one step; in hold mode the release cancels what is left of it.
  const diagonal = dir.match(/^(X[+-])(Y[+-])$/);
  if (diagonal) {
    const xSign = diagonal[1][1] === '+' ? '' : '-';
    const ySign = diagonal[2][1] === '+' ? '' : '-';
    if (!hold) {
      predicted.x += xSign === '-' ? -step : step;
      predicted.z += ySign === '-' ? step : -step;
      predictedDirty = true;
      if (!hoverTarget) { addWaypoint(new THREE.Vector3(predicted.x, predicted.y, predicted.z), color); startPreviewAnim(); }
    }
    setJogging(true);
    sendCmd('$J=G21G91 X' + xSign + step + ' Y' + ySign + step + ' F' + jogFeed);
    return;
  }

  const axis = dir[0], sign = dir[1] === '+' ? '' : '-';
  const axisStep = axis === 'Z' ? stepZ.value : step;
  if (!hold) {
    const delta = sign === '-' ? -axisStep : axisStep;
    if (axis === 'X') predicted.x += delta;
    else if (axis === 'Y') predicted.z -= delta;
    else if (axis === 'Z') predicted.y += delta;
    predictedDirty = true;
    if (!hoverTarget) { addWaypoint(new THREE.Vector3(predicted.x, predicted.y, predicted.z), color); startPreviewAnim(); }
  }
  setJogging(true);
  // G21: the steps are mm, whatever the last job left. A jog doesn't change the modal state.
  sendCmd('$J=G21G91 ' + axis + sign + axisStep + ' F' + jogFeed);
}

export function clearWaypoints(): void {
  for (const wp of waypoints) removeGhost(wp.ghost);
  waypoints.length = 0;
  clearHoverPreview();
  predictedDirty = false;
}

export function stopJog(): void {
  // grblHAL empties its input on a jog cancel. The command layer syncs again and drops the jogs it
  // hasn't sent, so none starts after the key or button is let go.
  rtSend('\x85');
  setJogging(false);
  clearWaypoints();
}

export function goToXY0(): void {
  clearWaypoints();
  sendCmd('G21G90G0X0Y0');
}

// Hold mode: press starts the jog, release stops it

export function setHoldMode(on: boolean): void {
  holdMode.value = on;
  if (!on && isHolding) { isHolding = false; stopJog(); }
}

/** Pointer down on a jog button. In click mode the jog goes on the click instead. */
export function pressJog(dir: string): void {
  if (!holdMode.value || isHolding) return;
  isHolding = true;
  startJog(dir);
}

/** Pointer up, leave or cancel on a jog button. */
export function releaseJog(): void {
  if (!holdMode.value || !isHolding) return;
  isHolding = false;
  stopJog();
}

export function clickJog(dir: string): void {
  if (!holdMode.value) startJog(dir);
}

// Keyboard jog

let heldKey: string | null = null;

export function initKeyboardJog(): void {
  document.addEventListener('keydown', e => {
    if (!connection.connected.value || job.running.peek()) return;
    if (isInputFocused()) return;
    const dir = KEY_DIRECTIONS[e.key];
    if (!dir) return;
    e.preventDefault();
    if (heldKey === e.key) return;
    if (heldKey) cancelKeyJog();
    heldKey = e.key;
    keyDir.value = dir;
    setJogging(true);
    const axis = dir[0], sign = dir[1] === '+' ? '' : '-';
    sendCmd('$J=G21G91 ' + axis + sign + KEY_JOG_DISTANCE + ' F' + feedFor(axis === 'Z'));
  });
  document.addEventListener('keyup', e => {
    if (!heldKey || e.key !== heldKey) return;
    e.preventDefault();
    cancelKeyJog();
  });
}

function cancelKeyJog(): void {
  if (!heldKey) return;
  heldKey = null;
  keyDir.value = null;
  stopJog();
}

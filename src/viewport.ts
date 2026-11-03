// The 3D view (three.js).
//
// The scene is made at start-up, so the jog ghosts, exclusion zones and probe preview can add to it
// at any time. It is drawn on the canvas of the job screen's Preview (src/app/Preview.tsx), from the
// G-code interpreter's moves: machine coordinates, arcs sampled as curves.

import * as machine from './stores/machine';
import { lsGet, lsSet } from './ui';
import { scaleZoneLabels } from './exclusion-zones';
import { sampleMove } from './gcode/index';
import type { Program } from './gcode/index';

import * as THREE from 'three';

// Scene objects
export let renderer: any;
export let scene: any;
export let camera: any;
// The workspace bounds (Settings, Options) and the projection, kept in this browser; the toolhead shown.
const EXTENTS_KEY = 'fs-viewport-extents';
const extents = { xMin: -300, xMax: 0, yMin: -300, yMax: 0, ortho: false };
let showToolhead = true;

/** The bounds and projection now, for Settings, Options. */
export function viewportExtents(): typeof extents { return { ...extents }; }

let perspCamera: any;
let orthoCamera: any;
export let gridHelper: any = null;
export let boundary: any = null;
export let originAxes: any[] = [];
export let toolGroup: any;
export let toolMesh: any;
export let ringMat: any;
export let rapidLines: any = null;
export let cutLines: any = null;
export let executedLine: any = null;
let gridLabels: any[] = [];
let wcsMarkers: any[] = [];
let wcsMarkersVisible = false;

// Orbit state
let isOrbiting = false;
let isPanning = false;
let lastMouse = { x: 0, y: 0 };
export let spherical = { theta: -0.8, phi: 0.7, radius: 180 };
export let target: any;

let lastTouches: Touch[] | null = null;
let viewCanvas: HTMLCanvasElement;

// A CSS colour variable as a three.js hex number
function cssColorToHex(varName: string, fallback: number): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  if (raw && raw.startsWith('#') && raw.length === 7) {
    const n = parseInt(raw.slice(1), 16);
    return isNaN(n) ? fallback : n;
  }
  return fallback;
}

export function initViewport(): void {
  scene = new THREE.Scene();

  perspCamera = new THREE.PerspectiveCamera(45, 1, 0.01, 10000);
  orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 10000);

  loadExtents();

  camera = extents.ortho ? orthoCamera : perspCamera;
  camera.position.set(80, 60, 100);
  camera.lookAt(0, 0, 0);

  // three.js lights are physically based since r155; × π keeps the r128 look.
  scene.add(new THREE.AmbientLight(0x223355, 2.5 * Math.PI));
  const dlight = new THREE.DirectionalLight(0xffffff, 0.5 * Math.PI);
  dlight.position.set(1, 2, 1);
  scene.add(dlight);

  target = new THREE.Vector3(0, 0, 0);

  // Toolhead marker
  const toolGeo = new THREE.CylinderGeometry(0, 1.5, 4, 8);
  const toolMat = new THREE.MeshPhongMaterial({ color: cssColorToHex('--vp-tool', 0xffd740), emissive: 0x2a1000 });
  toolMesh = new THREE.Mesh(toolGeo, toolMat);
  toolMesh.rotation.x = Math.PI;
  toolMesh.position.y = 2;
  toolGroup = new THREE.Group();
  toolGroup.add(toolMesh);

  const bodyGeo = new THREE.CylinderGeometry(1, 1, 6, 8);
  const bodyMat = new THREE.MeshPhongMaterial({ color: 0x778899 });
  const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
  bodyMesh.position.y = 7;
  toolGroup.add(bodyMesh);
  toolGroup.position.set(0, 0, 0);
  scene.add(toolGroup);

  const ringGeo = new THREE.RingGeometry(1.5, 2.5, 16);
  ringMat = new THREE.MeshBasicMaterial({ color: cssColorToHex('--vp-tool', 0xffd740), side: THREE.DoubleSide, transparent: true, opacity: 0.4 });
  const ringMesh = new THREE.Mesh(ringGeo, ringMat);
  ringMesh.rotation.x = -Math.PI / 2;
  toolGroup.add(ringMesh);

  updateCamera();
  rebuildViewportGrid();
}

/** Draw the scene on this canvas, which fills its parent. Once, from the Preview. */
export function attachViewport(canvas: HTMLCanvasElement): void {
  if (renderer) return;
  viewCanvas = canvas;
  renderer = new THREE.WebGLRenderer({ canvas: viewCanvas, antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setClearColor(0x0f0f17, 1);
  setupOrbitControls(viewCanvas);
  setupTouchControls(viewCanvas);

  function resizeRenderer() {
    const wrap = viewCanvas.parentElement!;
    const w = wrap.clientWidth, h = wrap.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h);
    perspCamera.aspect = w / h;
    perspCamera.updateProjectionMatrix();
    syncOrthoFrustum();
  }
  new ResizeObserver(resizeRenderer).observe(viewCanvas.parentElement!);
  resizeRenderer();

  animate();
}

function animate(): void {
  requestAnimationFrame(animate);
  // Nothing to draw while the Preview is hidden.
  if (!viewCanvas.offsetParent && !viewCanvas.closest('.is-full')) return;
  const t = Date.now() * 0.002;
  if (ringMat) ringMat.opacity = 0.2 + 0.2 * Math.sin(t);
  scaleZoneLabels(spherical.radius);
  renderer.render(scene, camera);
}

export function updateCamera(): void {
  const sp = Math.sin(spherical.phi), cp = Math.cos(spherical.phi);
  const st = Math.sin(spherical.theta), ct = Math.cos(spherical.theta);
  const x = target.x + spherical.radius * sp * st;
  const y = target.y + spherical.radius * cp;
  const z = target.z + spherical.radius * sp * ct;
  if (extents.ortho) {
    orthoCamera.position.set(x, y, z);
    orthoCamera.up.set(0, 1, 0);
    orthoCamera.lookAt(target);
    syncOrthoFrustum();
  } else {
    perspCamera.position.set(x, y, z);
    perspCamera.lookAt(target);
  }
}

function syncOrthoFrustum(): void {
  const size = renderer ? renderer.getSize(new THREE.Vector2()) : new THREE.Vector2(1, 1);
  const aspect = (size.x || 1) / (size.y || 1);
  const halfH = spherical.radius * 0.5;
  const halfW = halfH * aspect;
  orthoCamera.left = -halfW;
  orthoCamera.right = halfW;
  orthoCamera.top = halfH;
  orthoCamera.bottom = -halfH;
  orthoCamera.updateProjectionMatrix();
}

export function setProjection(ortho: boolean): void {
  extents.ortho = ortho;
  camera = ortho ? orthoCamera : perspCamera;
  updateCamera();
  saveExtents();
}

// The point under the cursor on the plane through `target`, facing the camera
function screenToWorld(clientX: number, clientY: number): any {
  const rect = viewCanvas.getBoundingClientRect();
  const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
  const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;

  const viewDir = new THREE.Vector3();
  camera.getWorldDirection(viewDir);

  let origin: any, dir: any;
  if (extents.ortho) {
    // Ortho: unproject near plane to get ray origin; direction is camera forward
    origin = new THREE.Vector3(ndcX, ndcY, -1).unproject(camera);
    dir = viewDir.clone();
  } else {
    // Perspective: ray from camera position through unprojected point
    const far = new THREE.Vector3(ndcX, ndcY, 0.5).unproject(camera);
    origin = camera.position.clone();
    dir = far.sub(origin).normalize();
  }

  const denom = dir.dot(viewDir);
  if (Math.abs(denom) < 1e-8) return target.clone();
  const t = target.clone().sub(origin).dot(viewDir) / denom;
  return origin.add(dir.multiplyScalar(t));
}

function setupOrbitControls(canvas: HTMLCanvasElement): void {
  canvas.addEventListener('mousedown', e => {
    if (e.button === 0) isOrbiting = true;
    if (e.button === 2) isPanning = true;
    lastMouse = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  window.addEventListener('mouseup', () => { isOrbiting = false; isPanning = false; });
  window.addEventListener('mousemove', e => {
    if (!isOrbiting && !isPanning) return;
    const dx = e.clientX - lastMouse.x;
    const dy = e.clientY - lastMouse.y;
    lastMouse = { x: e.clientX, y: e.clientY };
    if (isOrbiting) {
      spherical.theta -= dx * 0.007;
      spherical.phi = Math.max(0.05, Math.min(Math.PI - 0.05, spherical.phi - dy * 0.007));
      updateCamera();
    }
    if (isPanning) {
      // Pan: the point under the cursor stays under it
      const before = screenToWorld(e.clientX - dx, e.clientY - dy);
      const after = screenToWorld(e.clientX, e.clientY);
      target.add(before.sub(after));
      updateCamera();
    }
  });
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    // Zoom about the point under the cursor: the target moves so that point stays put.
    const worldBefore = screenToWorld(e.clientX, e.clientY);
    const factor = 1 + e.deltaY * 0.001;
    spherical.radius = Math.max(1, Math.min(2000, spherical.radius * factor));
    updateCamera();
    const worldAfter = screenToWorld(e.clientX, e.clientY);
    target.add(worldBefore.clone().sub(worldAfter));
    updateCamera();
  }, { passive: false });
}

function setupTouchControls(canvas: HTMLCanvasElement): void {
  function touchMidpoint(t0: Touch, t1: Touch) {
    return { x: (t0.clientX + t1.clientX) / 2, y: (t0.clientY + t1.clientY) / 2 };
  }
  function touchDist(t0: Touch, t1: Touch) {
    const dx = t0.clientX - t1.clientX, dy = t0.clientY - t1.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  canvas.addEventListener('touchstart', e => {
    e.preventDefault();
    lastTouches = Array.from(e.touches);
  }, { passive: false });

  canvas.addEventListener('touchmove', e => {
    e.preventDefault();
    const touches = Array.from(e.touches);
    if (!lastTouches || lastTouches.length === 0) { lastTouches = touches; return; }

    if (touches.length === 1 && lastTouches.length === 1) {
      const dx = touches[0].clientX - lastTouches[0].clientX;
      const dy = touches[0].clientY - lastTouches[0].clientY;
      spherical.theta -= dx * 0.007;
      spherical.phi = Math.max(0.05, Math.min(Math.PI - 0.05, spherical.phi - dy * 0.007));
      updateCamera();
    } else if (touches.length === 2 && lastTouches.length === 2) {
      // Pan and pinch zoom about the midpoint of the two touches
      const midNow = touchMidpoint(touches[0], touches[1]);
      const midPrev = touchMidpoint(lastTouches[0], lastTouches[1]);
      const before = screenToWorld(midPrev.x, midPrev.y);
      const after = screenToWorld(midNow.x, midNow.y);
      target.add(before.sub(after));
      const distNow = touchDist(touches[0], touches[1]);
      const distPrev = touchDist(lastTouches[0], lastTouches[1]);
      if (distPrev > 0) {
        const worldBefore = screenToWorld(midNow.x, midNow.y);
        spherical.radius = Math.max(1, Math.min(2000, spherical.radius * (distPrev / distNow)));
        updateCamera();
        const worldAfter = screenToWorld(midNow.x, midNow.y);
        target.add(worldBefore.clone().sub(worldAfter));
      }
      updateCamera();
    }
    lastTouches = touches;
  }, { passive: false });

  canvas.addEventListener('touchend', e => {
    lastTouches = Array.from(e.touches);
  }, { passive: false });
}

// Viewport extents
export function loadExtents(): void {
  const d = lsGet<any>(EXTENTS_KEY, null);
  if (d) {
    extents.xMin = d.xMin ?? -300; extents.xMax = d.xMax ?? 0;
    extents.yMin = d.yMin ?? -300; extents.yMax = d.yMax ?? 0;
    if (d.ortho !== undefined) extents.ortho = !!d.ortho;
  }
}

export function saveExtents(): void {
  lsSet(EXTENTS_KEY, { xMin: extents.xMin, xMax: extents.xMax, yMin: extents.yMin, yMax: extents.yMax, ortho: extents.ortho });
}

// Grid label sprite
function makeTextSprite(text: string, gridStep: number): any {
  const canvas = document.createElement('canvas');
  const sz = 128;
  canvas.width = sz;
  canvas.height = sz;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, sz, sz);
  ctx.fillStyle = '#64748b';
  ctx.font = 'bold 48px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, sz / 2, sz / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  const scale = gridStep * 0.45;
  sprite.scale.set(scale, scale, 1);
  return sprite;
}

export function rebuildViewportGrid(): void {
  if (gridHelper) { scene.remove(gridHelper); gridHelper.geometry.dispose(); gridHelper.material.dispose(); gridHelper = null; }
  if (boundary) { scene.remove(boundary); boundary.geometry.dispose(); boundary.material.dispose(); boundary = null; }
  originAxes.forEach(l => { scene.remove(l); l.geometry.dispose(); l.material.dispose(); });
  originAxes = [];
  gridLabels.forEach(s => { scene.remove(s); s.material.map?.dispose(); s.material.dispose(); });
  gridLabels = [];

  const threeXMin = extents.xMin, threeXMax = extents.xMax;
  const threeZMin = -extents.yMax, threeZMax = -extents.yMin;
  const sizeX = Math.abs(threeXMax - threeXMin) || 200;
  const sizeZ = Math.abs(threeZMax - threeZMin) || 200;
  const cx = (threeXMin + threeXMax) / 2;
  const cz = (threeZMin + threeZMax) / 2;

  const gridSize = Math.max(sizeX, sizeZ);
  const divisions = Math.min(40, Math.max(10, Math.round(gridSize / 20)));
  gridHelper = new THREE.GridHelper(gridSize, divisions, 0x2a2720, 0x1a1814);
  gridHelper.position.set(cx, 0, cz);
  scene.add(gridHelper);

  // Grid labels along edges
  const step = gridSize / divisions;
  const halfGrid = gridSize / 2;
  const gridXMin = cx - halfGrid;
  const gridZMin = cz - halfGrid;
  const labelY = 0.15;
  const pad = step * 0.35;

  // X labels along the bottom edge (max Z = front)
  for (let i = 0; i <= divisions; i++) {
    const wx = gridXMin + i * step;
    const machineX = wx;
    const label = Math.round(machineX).toString();
    const sprite = makeTextSprite(label, step);
    sprite.position.set(wx, labelY, cz + halfGrid + pad);
    scene.add(sprite);
    gridLabels.push(sprite);
  }

  // Y labels along the left edge (min X)
  for (let i = 0; i <= divisions; i++) {
    const wz = gridZMin + i * step;
    const machineY = -wz; // THREE Z is -machineY
    const label = Math.round(machineY).toString();
    const sprite = makeTextSprite(label, step);
    sprite.position.set(cx - halfGrid - pad, labelY, wz);
    scene.add(sprite);
    gridLabels.push(sprite);
  }

  const pts = [
    new THREE.Vector3(threeXMin, 0.1, threeZMin),
    new THREE.Vector3(threeXMax, 0.1, threeZMin),
    new THREE.Vector3(threeXMax, 0.1, threeZMax),
    new THREE.Vector3(threeXMin, 0.1, threeZMax),
    new THREE.Vector3(threeXMin, 0.1, threeZMin),
  ];
  const bdGeo = new THREE.BufferGeometry().setFromPoints(pts);
  boundary = new THREE.Line(bdGeo, new THREE.LineBasicMaterial({ color: 0x443e2e }));
  scene.add(boundary);

  const axLen = Math.min(sizeX, sizeZ) * 0.05;
  const addOriginAxis = (v: any, color: number) => {
    const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0.2, 0), v.clone().multiplyScalar(axLen).add(new THREE.Vector3(0, 0.2, 0))]);
    const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color }));
    scene.add(l);
    originAxes.push(l);
  };
  addOriginAxis(new THREE.Vector3(1, 0, 0), 0xff3333);
  addOriginAxis(new THREE.Vector3(-1, 0, 0), 0x992222);
  addOriginAxis(new THREE.Vector3(0, 0, -1), 0x33ff66);
  addOriginAxis(new THREE.Vector3(0, 0, 1), 0x226633);
  addOriginAxis(new THREE.Vector3(0, 1, 0), 0x3399ff);

  target.set(cx, 0, cz);
  spherical.radius = Math.max(sizeX, sizeZ) * 1.4;
  updateCamera();
}

// WCS origin markers

const WCS_COLORS: Record<string, number> = {
  G54: 0xff8c42, G55: 0x3b82f6, G56: 0x22c55e,
  G57: 0xf59e0b, G58: 0x14b8a6, G59: 0xef4444,
};

function clearWcsMarkers(): void {
  wcsMarkers.forEach(g => { scene.remove(g); g.traverse((c: any) => { c.geometry?.dispose(); c.material?.dispose(); }); });
  wcsMarkers = [];
}

function buildWcsMarkers(): void {
  clearWcsMarkers();
  if (!wcsMarkersVisible) return;
  const axLen = 12;
  const wcsKeys = ['G54', 'G55', 'G56', 'G57', 'G58', 'G59'];
  for (const wcs of wcsKeys) {
    const off = machine.offsets.peek()[wcs];
    if (!off) continue;
    // Scene coordinates: x = machine X, y = machine Z, z = -machine Y.
    const ox = off.x, oy = off.z, oz = -off.y;
    const color = WCS_COLORS[wcs] || 0xffffff;
    const group = new THREE.Group();

    // Small axes
    const addAxis = (dir: any, c: number) => {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), dir.clone().multiplyScalar(axLen)]);
      const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: 0.7 }));
      group.add(l);
    };
    addAxis(new THREE.Vector3(1, 0, 0), 0xff3333);
    addAxis(new THREE.Vector3(0, 1, 0), 0x3399ff);
    addAxis(new THREE.Vector3(0, 0, -1), 0x33ff66);

    // Label
    const canvas = document.createElement('canvas');
    canvas.width = 128; canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#' + color.toString(16).padStart(6, '0');
    ctx.font = 'bold 36px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(wcs, 64, 32);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(16, 8, 1);
    sprite.position.set(0, 14, 0);
    group.add(sprite);

    // A ring on the ground plane
    const ringGeo = new THREE.RingGeometry(2, 3, 16);
    const markerRingMat = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.4 });
    const ring = new THREE.Mesh(ringGeo, markerRingMat);
    ring.rotation.x = -Math.PI / 2;
    group.add(ring);

    group.position.set(ox, oy, oz);
    scene.add(group);
    wcsMarkers.push(group);
  }
}

export function toggleWcsMarkers(): void {
  wcsMarkersVisible = !wcsMarkersVisible;
  buildWcsMarkers();
}

export function refreshWcsMarkers(): void {
  if (wcsMarkersVisible) buildWcsMarkers();
}

// View presets
export function setView(v: string): void {
  document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
  if (v === 'iso') { spherical.theta = -0.8; spherical.phi = 0.7; }
  else if (v === 'top') { spherical.theta = 0; spherical.phi = 0.01; }
  else if (v === 'front') { spherical.theta = 0; spherical.phi = Math.PI / 2; }
  else if (v === 'side') { spherical.theta = Math.PI / 2; spherical.phi = Math.PI / 2; }
  updateCamera();
}

// The drawn program's extent, in scene coordinates, for FIT.
let pathBox: any = null;

export function fitView(): void {
  if (!pathBox || pathBox.isEmpty()) return;
  const center = new THREE.Vector3(); pathBox.getCenter(center);
  const size = new THREE.Vector3(); pathBox.getSize(size);
  target.copy(center);
  spherical.radius = Math.max(size.length() * 1.5, 10);
  updateCamera();
}

export function toggleToolhead(): void {
  showToolhead = !showToolhead;
  toolGroup.visible = showToolhead;
}

// Toolpath
//
// Every move in program order goes into one buffer of line segments: machine X, Z and −Y, as the
// scene has them. The executed path is a draw range of it, so following the job costs nothing.
// Cuts and rapids each get their own buffer for their colours. A move with an unknown end isn't drawn.

let orderedVertices: Float32Array = new Float32Array(0);
/** Vertices of the ordered buffer up to the end of each move: index i is the count before move i. */
let vertexAt: Uint32Array = new Uint32Array(1);

function disposeLine(obj: any): void {
  if (!obj) return;
  scene.remove(obj);
  obj.geometry.dispose();
  obj.material.dispose();
}

function lineSegments(points: Float32Array, color: number, opacity: number): any {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(points, 3));
  const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity }));
  scene.add(l);
  return l;
}

/** Draw the program's moves, or clear the view with null. */
export function showProgram(program: Program | null): void {
  disposeLine(rapidLines); disposeLine(cutLines); disposeLine(executedLine);
  rapidLines = cutLines = executedLine = null;
  pathBox = null;
  const moves = program?.moves ?? [];
  const ordered: number[] = [], cut: number[] = [], rapid: number[] = [];
  vertexAt = new Uint32Array(moves.length + 1);
  moves.forEach((m, i) => {
    vertexAt[i] = ordered.length / 3;
    const pts = sampleMove(m);
    if (pts.some(p => p.x === null || p.y === null || p.z === null)) return;
    const out = m.kind === 'rapid' ? rapid : cut;
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1], b = pts[k];
      // Scene coordinates: x = machine X, y = machine Z, z = −machine Y.
      ordered.push(a.x!, a.z!, -a.y!, b.x!, b.z!, -b.y!);
      out.push(a.x!, a.z!, -a.y!, b.x!, b.z!, -b.y!);
    }
  });
  vertexAt[moves.length] = ordered.length / 3;
  orderedVertices = new Float32Array(ordered);
  if (rapid.length) rapidLines = lineSegments(new Float32Array(rapid), cssColorToHex('--vp-rapid', 0xff4444), 0.5);
  if (cut.length) cutLines = lineSegments(new Float32Array(cut), cssColorToHex('--vp-cut', 0x00d4ff), 0.85);
  if (orderedVertices.length) {
    executedLine = lineSegments(orderedVertices, cssColorToHex('--vp-executed', 0x00ff88), 1);
    executedLine.geometry.setDrawRange(0, 0);
    executedLine.renderOrder = 1;
    pathBox = new THREE.Box3().setFromBufferAttribute(executedLine.geometry.getAttribute('position'));
  }
}

/** The moves done so far: the first `count` of the program's. */
export function showExecuted(count: number): void {
  if (!executedLine) return;
  const n = Math.max(0, Math.min(count, vertexAt.length - 1));
  executedLine.geometry.setDrawRange(0, vertexAt[n]);
}

// Colour changes from the theme editor take effect at once.
export function refreshViewportColors(): void {
  const toolColor = cssColorToHex('--vp-tool', 0xffd740);
  if (toolMesh?.material) { toolMesh.material.color.setHex(toolColor); }
  if (ringMat) { ringMat.color.setHex(toolColor); }
  rapidLines?.material.color.setHex(cssColorToHex('--vp-rapid', 0xff4444));
  cutLines?.material.color.setHex(cssColorToHex('--vp-cut', 0x00d4ff));
  executedLine?.material.color.setHex(cssColorToHex('--vp-executed', 0x00ff88));
}

/** Sets the workspace bounds (Settings, Options), in machine mm. False, and nothing changed, unless each
 *  minimum is below its maximum. */
export function setViewportExtents(xMin: number, xMax: number, yMin: number, yMax: number): boolean {
  if (isNaN(xMin) || isNaN(xMax) || isNaN(yMin) || isNaN(yMax)) return false;
  if (xMin >= xMax || yMin >= yMax) return false;
  extents.xMin = xMin; extents.xMax = xMax; extents.yMin = yMin; extents.yMax = yMax;
  saveExtents();
  rebuildViewportGrid();
  return true;
}

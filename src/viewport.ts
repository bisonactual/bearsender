// ═══════════════════════════════════════════════
// THREE.JS 3D VIEWPORT
// ═══════════════════════════════════════════════
//
// The scene is made at start-up, so the jog ghosts, exclusion zones and probe preview can add to it
// at any time. It is drawn on the canvas of the job screen's Preview (src/app/Preview.tsx), from the
// G-code interpreter's moves: machine coordinates, arcs sampled as curves.

import * as machine from './stores/machine';
import { lsGet, lsSet } from './ui';
import { ezUpdateSpriteScales } from './exclusion-zones';
import { sampleMove } from './gcode/index';
import type { Program } from './gcode/index';

import * as THREE from 'three';

// Scene objects
export let renderer: any;
export let scene: any;
export let camera: any;
// The workspace bounds (Settings, Options) and the projection, kept in this browser; the toolhead shown.
const VP_STORAGE_KEY = 'fs-viewport-extents';
const vp = { xMin: -300, xMax: 0, yMin: -300, yMax: 0, ortho: false };
let showToolhead = true;

/** The bounds and projection now, for Settings, Options. */
export function vpExtents(): typeof vp { return { ...vp }; }

let perspCamera: any;
let orthoCamera: any;
export let gridHelper: any = null;
export let _vpBoundary: any = null;
export let _vpOriginAxes: any[] = [];
export let toolGroup: any;
export let toolMesh: any;
export let ringMat: any;
export let rapidLines: any = null;
export let cutLines: any = null;
export let executedLine: any = null;
let _gridLabels: any[] = [];
let _wcsMarkers: any[] = [];
let _wcsMarkersVisible = false;

// Orbit state
let isOrbiting = false;
let isPanning = false;
let lastMouse = { x: 0, y: 0 };
export let spherical = { theta: -0.8, phi: 0.7, radius: 180 };
export let target: any;

let _lastTouches: Touch[] | null = null;
let _canvas: HTMLCanvasElement;

// ── Read a CSS colour variable as a THREE.js hex number ──────────────────────
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

  vpLoadExtents();

  camera = vp.ortho ? orthoCamera : perspCamera;
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
  _canvas = canvas;
  renderer = new THREE.WebGLRenderer({ canvas: _canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setClearColor(0x0f0f17, 1);
  setupOrbitControls(_canvas);
  setupTouchControls(_canvas);

  function resizeRenderer() {
    const wrap = _canvas.parentElement!;
    const w = wrap.clientWidth, h = wrap.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h);
    perspCamera.aspect = w / h;
    perspCamera.updateProjectionMatrix();
    syncOrthoFrustum();
  }
  new ResizeObserver(resizeRenderer).observe(_canvas.parentElement!);
  resizeRenderer();

  animate();
}

function animate(): void {
  requestAnimationFrame(animate);
  // Nothing to draw while the Preview is hidden.
  if (!_canvas.offsetParent && !_canvas.closest('.is-full')) return;
  const t = Date.now() * 0.002;
  if (ringMat) ringMat.opacity = 0.2 + 0.2 * Math.sin(t);
  ezUpdateSpriteScales(spherical.radius);
  renderer.render(scene, camera);
}

export function updateCamera(): void {
  const sp = Math.sin(spherical.phi), cp = Math.cos(spherical.phi);
  const st = Math.sin(spherical.theta), ct = Math.cos(spherical.theta);
  const x = target.x + spherical.radius * sp * st;
  const y = target.y + spherical.radius * cp;
  const z = target.z + spherical.radius * sp * ct;
  if (vp.ortho) {
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
  vp.ortho = ortho;
  camera = ortho ? orthoCamera : perspCamera;
  updateCamera();
  vpSaveExtents();
}

// ── Unproject screen point to world ray, intersect with target-plane ──────────
function screenToWorld(clientX: number, clientY: number): any {
  const rect = _canvas.getBoundingClientRect();
  const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
  const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;

  const viewDir = new THREE.Vector3();
  camera.getWorldDirection(viewDir);

  let origin: any, dir: any;
  if (vp.ortho) {
    // Ortho: unproject near plane to get ray origin; direction is camera forward
    origin = new THREE.Vector3(ndcX, ndcY, -1).unproject(camera);
    dir = viewDir.clone();
  } else {
    // Perspective: ray from camera position through unprojected point
    const far = new THREE.Vector3(ndcX, ndcY, 0.5).unproject(camera);
    origin = camera.position.clone();
    dir = far.sub(origin).normalize();
  }

  // Intersect with the plane through `target` perpendicular to the camera view direction
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
      // Pan: compute world point under cursor before and after, shift target by the delta
      const before = screenToWorld(e.clientX - dx, e.clientY - dy);
      const after = screenToWorld(e.clientX, e.clientY);
      target.add(before.sub(after));
      updateCamera();
    }
  });
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    // World point under cursor before zoom
    const worldBefore = screenToWorld(e.clientX, e.clientY);

    const factor = 1 + e.deltaY * 0.001;
    spherical.radius = Math.max(1, Math.min(2000, spherical.radius * factor));
    updateCamera();

    // World point under cursor after zoom
    const worldAfter = screenToWorld(e.clientX, e.clientY);

    // Shift target so the point stays under the cursor
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
    _lastTouches = Array.from(e.touches);
  }, { passive: false });

  canvas.addEventListener('touchmove', e => {
    e.preventDefault();
    const touches = Array.from(e.touches);
    if (!_lastTouches || _lastTouches.length === 0) { _lastTouches = touches; return; }

    if (touches.length === 1 && _lastTouches.length === 1) {
      const dx = touches[0].clientX - _lastTouches[0].clientX;
      const dy = touches[0].clientY - _lastTouches[0].clientY;
      spherical.theta -= dx * 0.007;
      spherical.phi = Math.max(0.05, Math.min(Math.PI - 0.05, spherical.phi - dy * 0.007));
      updateCamera();
    } else if (touches.length === 2 && _lastTouches.length === 2) {
      // Pan: keep midpoint world position stable
      const midNow = touchMidpoint(touches[0], touches[1]);
      const midPrev = touchMidpoint(_lastTouches[0], _lastTouches[1]);
      const before = screenToWorld(midPrev.x, midPrev.y);
      const after = screenToWorld(midNow.x, midNow.y);
      target.add(before.sub(after));

      // Pinch zoom: keep midpoint stable
      const distNow = touchDist(touches[0], touches[1]);
      const distPrev = touchDist(_lastTouches[0], _lastTouches[1]);
      if (distPrev > 0) {
        const worldBefore = screenToWorld(midNow.x, midNow.y);
        spherical.radius = Math.max(1, Math.min(2000, spherical.radius * (distPrev / distNow)));
        updateCamera();
        const worldAfter = screenToWorld(midNow.x, midNow.y);
        target.add(worldBefore.clone().sub(worldAfter));
      }
      updateCamera();
    }
    _lastTouches = touches;
  }, { passive: false });

  canvas.addEventListener('touchend', e => {
    _lastTouches = Array.from(e.touches);
  }, { passive: false });
}

// ── Viewport extents ──────────────────────────────────────────────────────────
export function vpLoadExtents(): void {
  const d = lsGet<any>(VP_STORAGE_KEY, null);
  if (d) {
    vp.xMin = d.xMin ?? -300; vp.xMax = d.xMax ?? 0;
    vp.yMin = d.yMin ?? -300; vp.yMax = d.yMax ?? 0;
    if (d.ortho !== undefined) vp.ortho = !!d.ortho;
  }
}

export function vpSaveExtents(): void {
  lsSet(VP_STORAGE_KEY, { xMin: vp.xMin, xMax: vp.xMax, yMin: vp.yMin, yMax: vp.yMax, ortho: vp.ortho });
}

// ── Grid label sprite ─────────────────────────────────────────────────────────
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
  if (_vpBoundary) { scene.remove(_vpBoundary); _vpBoundary.geometry.dispose(); _vpBoundary.material.dispose(); _vpBoundary = null; }
  _vpOriginAxes.forEach(l => { scene.remove(l); l.geometry.dispose(); l.material.dispose(); });
  _vpOriginAxes = [];
  _gridLabels.forEach(s => { scene.remove(s); s.material.map?.dispose(); s.material.dispose(); });
  _gridLabels = [];

  const threeXMin = vp.xMin, threeXMax = vp.xMax;
  const threeZMin = -vp.yMax, threeZMax = -vp.yMin;
  const sizeX = Math.abs(threeXMax - threeXMin) || 200;
  const sizeZ = Math.abs(threeZMax - threeZMin) || 200;
  const cx = (threeXMin + threeXMax) / 2;
  const cz = (threeZMin + threeZMax) / 2;

  const gridSize = Math.max(sizeX, sizeZ);
  const divisions = Math.min(40, Math.max(10, Math.round(gridSize / 20)));
  gridHelper = new THREE.GridHelper(gridSize, divisions, 0x2a2720, 0x1a1814);
  gridHelper.position.set(cx, 0, cz);
  scene.add(gridHelper);

  // ── Grid labels along edges ─────────────────────────────────────────────────
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
    _gridLabels.push(sprite);
  }

  // Y labels along the left edge (min X)
  for (let i = 0; i <= divisions; i++) {
    const wz = gridZMin + i * step;
    const machineY = -wz; // THREE Z is -machineY
    const label = Math.round(machineY).toString();
    const sprite = makeTextSprite(label, step);
    sprite.position.set(cx - halfGrid - pad, labelY, wz);
    scene.add(sprite);
    _gridLabels.push(sprite);
  }

  const pts = [
    new THREE.Vector3(threeXMin, 0.1, threeZMin),
    new THREE.Vector3(threeXMax, 0.1, threeZMin),
    new THREE.Vector3(threeXMax, 0.1, threeZMax),
    new THREE.Vector3(threeXMin, 0.1, threeZMax),
    new THREE.Vector3(threeXMin, 0.1, threeZMin),
  ];
  const bdGeo = new THREE.BufferGeometry().setFromPoints(pts);
  _vpBoundary = new THREE.Line(bdGeo, new THREE.LineBasicMaterial({ color: 0x443e2e }));
  scene.add(_vpBoundary);

  const axLen = Math.min(sizeX, sizeZ) * 0.05;
  const makeVpAxis = (v: any, color: number) => {
    const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0.2, 0), v.clone().multiplyScalar(axLen).add(new THREE.Vector3(0, 0.2, 0))]);
    const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color }));
    scene.add(l);
    _vpOriginAxes.push(l);
  };
  makeVpAxis(new THREE.Vector3(1, 0, 0), 0xff3333);
  makeVpAxis(new THREE.Vector3(-1, 0, 0), 0x992222);
  makeVpAxis(new THREE.Vector3(0, 0, -1), 0x33ff66);
  makeVpAxis(new THREE.Vector3(0, 0, 1), 0x226633);
  makeVpAxis(new THREE.Vector3(0, 1, 0), 0x3399ff);

  target.set(cx, 0, cz);
  spherical.radius = Math.max(sizeX, sizeZ) * 1.4;
  updateCamera();
}

// ── WCS origin markers ────────────────────────────────────────────────────────

const WCS_COLORS: Record<string, number> = {
  G54: 0xff8c42, G55: 0x3b82f6, G56: 0x22c55e,
  G57: 0xf59e0b, G58: 0x14b8a6, G59: 0xef4444,
};

function clearWcsMarkers(): void {
  _wcsMarkers.forEach(g => { scene.remove(g); g.traverse((c: any) => { c.geometry?.dispose(); c.material?.dispose(); }); });
  _wcsMarkers = [];
}

function buildWcsMarkers(): void {
  clearWcsMarkers();
  if (!_wcsMarkersVisible) return;
  const axLen = 12;
  const wcsKeys = ['G54', 'G55', 'G56', 'G57', 'G58', 'G59'];
  for (const wcs of wcsKeys) {
    const off = machine.offsets.peek()[wcs];
    if (!off) continue;
    // THREE coords: X = machineX, Y = machineZ, Z = -machineY
    const ox = off.x, oy = off.z, oz = -off.y;
    const color = WCS_COLORS[wcs] || 0xffffff;
    const group = new THREE.Group();

    // Small axes
    const makeAx = (dir: any, c: number) => {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), dir.clone().multiplyScalar(axLen)]);
      const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: 0.7 }));
      group.add(l);
    };
    makeAx(new THREE.Vector3(1, 0, 0), 0xff3333);
    makeAx(new THREE.Vector3(0, 1, 0), 0x3399ff);
    makeAx(new THREE.Vector3(0, 0, -1), 0x33ff66);

    // Label sprite
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

    // Ring on ground plane
    const ringGeo = new THREE.RingGeometry(2, 3, 16);
    const ringMat2 = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.4 });
    const ring = new THREE.Mesh(ringGeo, ringMat2);
    ring.rotation.x = -Math.PI / 2;
    group.add(ring);

    group.position.set(ox, oy, oz);
    scene.add(group);
    _wcsMarkers.push(group);
  }
}

export function toggleWcsMarkers(): void {
  _wcsMarkersVisible = !_wcsMarkersVisible;
  buildWcsMarkers();
}

export function refreshWcsMarkers(): void {
  if (_wcsMarkersVisible) buildWcsMarkers();
}

// ── View presets ──────────────────────────────────────────────────────────────
export function setView(v: string): void {
  document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
  // The caller is an onclick so event.target won't work from module scope — handled in main
  if (v === 'iso') { spherical.theta = -0.8; spherical.phi = 0.7; }
  else if (v === 'top') { spherical.theta = 0; spherical.phi = 0.01; }
  else if (v === 'front') { spherical.theta = 0; spherical.phi = Math.PI / 2; }
  else if (v === 'side') { spherical.theta = Math.PI / 2; spherical.phi = Math.PI / 2; }
  updateCamera();
}

// The drawn program's extent, in scene coordinates, for FIT.
let _pathBox: any = null;

export function fitView(): void {
  if (!_pathBox || _pathBox.isEmpty()) return;
  const center = new THREE.Vector3(); _pathBox.getCenter(center);
  const size = new THREE.Vector3(); _pathBox.getSize(size);
  target.copy(center);
  spherical.radius = Math.max(size.length() * 1.5, 10);
  updateCamera();
}

export function toggleToolhead(): void {
  showToolhead = !showToolhead;
  toolGroup.visible = showToolhead;
}

// ── Toolpath ──────────────────────────────────────────────────────────────────
//
// Every move in program order goes into one buffer of line segments: machine X, Z and −Y, as the
// scene has them. The executed path is a draw range of it, so following the job costs nothing.
// Cuts and rapids each get their own buffer for their colours. A move with an unknown end isn't drawn.

let _ordered: Float32Array = new Float32Array(0);
/** Vertices of the ordered buffer up to the end of each move: index i is the count before move i. */
let _vertexAt: Uint32Array = new Uint32Array(1);

function disposeLine(obj: any): void {
  if (!obj) return;
  scene.remove(obj);
  obj.geometry.dispose();
  obj.material.dispose();
}

function lines(points: Float32Array, color: number, opacity: number): any {
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
  _pathBox = null;
  const moves = program?.moves ?? [];
  const ordered: number[] = [], cut: number[] = [], rapid: number[] = [];
  _vertexAt = new Uint32Array(moves.length + 1);
  moves.forEach((m, i) => {
    _vertexAt[i] = ordered.length / 3;
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
  _vertexAt[moves.length] = ordered.length / 3;
  _ordered = new Float32Array(ordered);
  if (rapid.length) rapidLines = lines(new Float32Array(rapid), cssColorToHex('--vp-rapid', 0xff4444), 0.5);
  if (cut.length) cutLines = lines(new Float32Array(cut), cssColorToHex('--vp-cut', 0x00d4ff), 0.85);
  if (_ordered.length) {
    executedLine = lines(_ordered, cssColorToHex('--vp-executed', 0x00ff88), 1);
    executedLine.geometry.setDrawRange(0, 0);
    executedLine.renderOrder = 1;
    _pathBox = new THREE.Box3().setFromBufferAttribute(executedLine.geometry.getAttribute('position'));
  }
}

/** The moves done so far: the first `count` of the program's. */
export function showExecuted(count: number): void {
  if (!executedLine) return;
  const n = Math.max(0, Math.min(count, _vertexAt.length - 1));
  executedLine.geometry.setDrawRange(0, _vertexAt[n]);
}

// Colour changes from the theme editor take effect at once.
export function vpRefreshColors(): void {
  const toolColor = cssColorToHex('--vp-tool', 0xffd740);
  if (toolMesh?.material) { toolMesh.material.color.setHex(toolColor); }
  if (ringMat) { ringMat.color.setHex(toolColor); }
  rapidLines?.material.color.setHex(cssColorToHex('--vp-rapid', 0xff4444));
  cutLines?.material.color.setHex(cssColorToHex('--vp-cut', 0x00d4ff));
  executedLine?.material.color.setHex(cssColorToHex('--vp-executed', 0x00ff88));
}

/** Sets the workspace bounds (Settings, Options), in machine mm. False, and nothing changed, unless each
 *  minimum is below its maximum. */
export function vpSetExtents(xMin: number, xMax: number, yMin: number, yMax: number): boolean {
  if (isNaN(xMin) || isNaN(xMax) || isNaN(yMin) || isNaN(yMax)) return false;
  if (xMin >= xMax || yMin >= yMax) return false;
  vp.xMin = xMin; vp.xMax = xMax; vp.yMin = yMin; vp.yMax = yMax;
  vpSaveExtents();
  rebuildViewportGrid();
  return true;
}

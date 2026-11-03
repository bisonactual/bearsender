// The Exclusion Zones plugin's zones and the ATCi's travel, and their boxes in the 3D view. The
// Settings screen's ZONES tab shows them (src/app/ZonesTab.tsx).

import { signal, effect } from '@preact/signals';
import { log } from './console';
import * as command from './command';
import { scene } from './viewport';
import { zoneColor, zoneColors } from './options';
import { lsGet, lsSet } from './ui';

import * as THREE from 'three';
import * as machine from './stores/machine';
import * as connection from './stores/connection';

export interface Zone {
  slot: number;
  xmin: number; ymin: number; zmin: number;
  xmax: number; ymax: number; zmax: number;
  flags: number;
}

/** The Exclusion Zones plugin is listed in $I+. */
export const plugin = signal(false);
/** The Sienci ATCi plugin is listed in $I+: its travel ($130-$132) is shown as a zone. */
export const atci = signal(false);
/** Zones on, from [EZ:enabled] or the status report's E. */
export const enabled = signal(false);
/** The status report's Z: the planned position is in a zone. */
export const inside = signal(false);
export const zones = signal<Zone[]>([]);
/** A $ZONE read is under way. */
export const isReading = signal(false);
/** The zones' labels in the 3D view. */
export const showLabels = signal(lsGet('fs-ez-show-labels', true));

let zoneMeshes: any[] = [];
let zoneSprites: any[] = [];

/** On disconnecting: the plugins are found again on the next connect. */
export function resetZonePlugins(): void {
  atci.value = false;
  plugin.value = false;
  enabled.value = false;
  zones.value = [];
  inside.value = false;
  // The ATCi travel is read again from the next controller.
  const { 130: _x, 131: _y, 132: _z, ...rest } = machine.settings.peek();
  machine.settings.value = rest;
}

// Flags

export const FLAG_GCODE = 1, FLAG_JOG = 2, FLAG_TOOL_CHANGE = 4, FLAG_ENABLED = 8;
export function isZoneEnabled(f: number): boolean { return !!(f & FLAG_ENABLED); }
export function allowsGcode(f: number): boolean { return !!(f & FLAG_GCODE); }
export function allowsJog(f: number): boolean { return !!(f & FLAG_JOG); }
export function allowsToolChange(f: number): boolean { return !!(f & FLAG_TOOL_CHANGE); }

/** What a zone blocks (GC, JOG, TC; none when nothing), or 'off' when it is disabled. */
export function blockedActions(f: number): string[] | 'off' {
  if (!isZoneEnabled(f)) return 'off';
  const b: string[] = [];
  if (!allowsGcode(f)) b.push('GC');
  if (!allowsJog(f)) b.push('JOG');
  if (!allowsToolChange(f)) b.push('TC');
  return b;
}

// The machine in a zone

/** The machine is inside a zone that blocks something. */
export function isInsideBlockingZone(): boolean {
  const { x, y, z } = machine.mpos.value;
  for (const zone of zones.value) {
    if (!isZoneEnabled(zone.flags)) continue;
    const blocksAnything = !allowsGcode(zone.flags) || !allowsJog(zone.flags) || !allowsToolChange(zone.flags);
    if (!blocksAnything) continue;
    if (x >= zone.xmin && x <= zone.xmax &&
        y >= zone.ymin && y <= zone.ymax &&
        z >= zone.zmin && z <= zone.zmax) return true;
  }
  return false;
}

// Plugin detection

/** A line of the $I+ reply. The zones and the ATCi travel are read after it (ezConnected). */
export function detectZonePlugins(line: string): void {
  if (line.includes('[PLUGIN:Exclusion Zones')) {
    plugin.value = true;
    log('info', '🔒 Exclusion Zones plugin detected');
  }
  // [PLUGIN:SIENCI ATCi plugin v0.5.0], and the other spellings seen: ATCi, ATCI, Sienci ATCi.
  if (/^\[PLUGIN:(SIENCI\s+)?ATCI\b/i.test(line)) {
    atci.value = true;
    log('info', '🔧 ATCi plugin detected');
  }
}

/** On connecting, once $I+ has named the plugins. */
export async function readZonesOnConnect(): Promise<void> {
  if (plugin.value || atci.value) await refreshZones();
}

// The $ZONE reply

// [EZ:enabled,n] then a [ZONE:slot|xmin,ymin,zmin,xmax,ymax,zmax|flags] line for each zone
function parseZoneList(lines: string[]): void {
  const list: Zone[] = [];
  for (const line of lines) {
    const ez = line.match(/\[EZ:(enabled|disabled),(\d+)/);
    if (ez) enabled.value = ez[1] === 'enabled';
    const m = line.match(/\[ZONE:(\d+)\|([^|]+)\|(\d+)\]/);
    if (!m) continue;
    const slot = parseInt(m[1]), coords = m[2].split(',').map(Number), flags = parseInt(m[3]);
    if (coords.length >= 6) list.push({ slot, flags, xmin: coords[0], ymin: coords[1], zmin: coords[2], xmax: coords[3], ymax: coords[4], zmax: coords[5] });
  }
  zones.value = list;
}

/** The status report's EZ: field. */
export function parseZoneStatus(field: string): void {
  enabled.value = field.includes('E');
  inside.value = field.includes('Z');
}

// Reading and switching

/** Reads the zones ($ZONE) and, with the ATCi, the travel it guards ($130-$132), then redraws. */
export async function refreshZones(): Promise<void> {
  if (!connection.connected.value) { log('err', 'Not connected'); return; }
  isReading.value = true;
  try {
    const list = plugin.value ? command.send('$ZONE') : null;
    const travel = atci.value ? [130, 131, 132].map(id => command.send('$' + id)) : [];
    await Promise.all(travel);
    if (list) parseZoneList((await list).lines);
  } catch (e) { if (!(e instanceof command.CommandFailed)) throw e; }
  isReading.value = false;
  rebuildZoneMeshes();
}

/** Sends a plugin command, then reads the zones again once it has been answered. */
function sendZoneCommand(line: string): void {
  command.send(line, { log: true }).then(() => refreshZones(), e => { if (!(e instanceof command.CommandFailed)) throw e; });
}

export function toggleZones(): void {
  if (!connection.connected.value || !plugin.value) return;
  sendZoneCommand(enabled.value ? '$EXCLUSION=0' : '$EXCLUSION=1');
}

export function toggleShowLabels(): void { showLabels.value = !showLabels.value; }

/** At start-up, once the 3D view is made: redraws the boxes when the labels are switched or the zone
 *  colours change. */
export function initZones(): void {
  effect(() => { lsSet('fs-ez-show-labels', showLabels.value); void zoneColors.value; rebuildZoneMeshes(); });
}

// Zones written and deleted

/** The first free slot from 1, for a new zone. */
export function nextFreeSlot(): number {
  const used = new Set(zones.value.map(z => z.slot));
  let slot = 1;
  while (used.has(slot) && slot < 16) slot++;
  return slot;
}

export function saveZone(z: Zone): void {
  if (isNaN(z.slot) || z.slot < 0 || z.slot > 15) { log('err', 'Slot must be 0-15'); return; }
  sendZoneCommand(`$ZONE=${z.slot},${z.xmin},${z.ymin},${z.zmin},${z.xmax},${z.ymax},${z.zmax},${z.flags}`);
}

export function deleteZone(slot: number): void { sendZoneCommand('$ZONE-' + slot); }

/** The ATCi's travel ($130-$132), when it is there and the settings have been read. */
export function atciLimits(): { xMax: number; yMax: number; zMax: number } | null {
  if (!atci.value) return null;
  const s = machine.settings.value;
  const x = parseFloat(s[130]), y = parseFloat(s[131]), z = parseFloat(s[132]);
  if (isNaN(x) && isNaN(y) && isNaN(z)) return null;
  return { xMax: x || 0, yMax: y || 0, zMax: z || 0 };
}

// The zones in the 3D view

export function rebuildZoneMeshes(): void {
  for (const m of zoneMeshes) { scene.remove(m); if (m.geometry) m.geometry.dispose(); if (m.material) m.material.dispose(); }
  zoneMeshes = []; zoneSprites = [];

  for (const z of zones.peek()) {
    if (!isZoneEnabled(z.flags)) continue;
    const sx = z.xmax - z.xmin, sy = z.zmax - z.zmin, sz = z.ymax - z.ymin;
    const cx = z.xmin + sx / 2, cy = z.zmin + sy / 2, cz = -(z.ymin + sz / 2);
    const color = new THREE.Color(zoneColor(z.flags));

    // Wireframe
    const geo = new THREE.BoxGeometry(sx, sy, sz);
    const edges = new THREE.EdgesGeometry(geo);
    const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.7 }));
    line.position.set(cx, cy, cz); scene.add(line); zoneMeshes.push(line);

    // Fill
    const fill = new THREE.Mesh(geo.clone(), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.08, side: THREE.DoubleSide }));
    fill.position.set(cx, cy, cz); scene.add(fill); zoneMeshes.push(fill);

    if (showLabels.peek()) {
      const blocked: string[] = [];
      if (!allowsGcode(z.flags)) blocked.push('GCODE');
      if (!allowsJog(z.flags)) blocked.push('JOG');
      if (!allowsToolChange(z.flags)) blocked.push('TOOLCHANGE');
      const label = blocked.length ? blocked.join('  ') : 'ALL OK';
      const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 128;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#000'; ctx.globalAlpha = 0.5; ctx.fillRect(0, 0, 512, 128); ctx.globalAlpha = 1;
      ctx.font = 'bold 36px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = blocked.length ? '#ff4444' : '#44ff88';
      ctx.fillText(label, 256, 64);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
      sprite.position.set(cx, z.zmax + 3, cz); scene.add(sprite); zoneMeshes.push(sprite); zoneSprites.push(sprite);
    }
  }
}

export function clearZoneMeshes(): void {
  for (const m of zoneMeshes) { scene.remove(m); if (m.geometry) m.geometry.dispose(); if (m.material) m.material.dispose(); }
  zoneMeshes = []; zoneSprites = [];
}

export function scaleZoneLabels(_radius: number): void {
  // A fixed size in the scene, so the labels grow as the camera zooms in.
  for (const sp of zoneSprites) sp.scale.set(30, 7.5, 1);
}

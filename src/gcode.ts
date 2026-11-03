// ═══════════════════════════════════════════════
// G-CODE FILES — loading, and the program limits module
// ═══════════════════════════════════════════════
//
// What the program does comes from the G-code interpreter (src/gcode, through stores/program.ts);
// this file loads files, and shows the interpreter's extents in the old limits module and frames them.

import { effect } from '@preact/signals';
import { state } from './state';
import { log } from './console';
import { sendCmd } from './connection';
import { WCS_ENTRIES } from './offsets';
import { frFileLoaded } from './flight-recorder';
import type { Bounds } from './gcode/index';
import * as job from './stores/job';
import * as program from './stores/program';

export function processGcode(text: string, name: string): void {
  // CR, LF or CRLF: grblHAL ends a line at either, so a lone CR inside a line would split it there.
  state.gcodeLines = text.split(/\r\n|\r|\n/).map(l => l.trim()).filter(l => l.length > 0);
  state.lineHead = 0; state.segmentIndex = 0;
  const label = document.getElementById('fileName');
  if (label) label.textContent = name;
  job.loaded(name, state.gcodeLines);
  updateProgress(0, state.gcodeLines.length);
  log('info', 'Loaded: ' + name + ' (' + state.gcodeLines.length + ' lines)');
  frFileLoaded(name);
}

/** The work offsets or the tool length changed (offsets.ts): read the program again with them. */
export function refreshLoadedProgramPreview(): void {
  program.reread();
}

export function updateProgress(cur: number, total: number): void {
  const pct = total > 0 ? (cur / total * 100) : 0;
  const fill = document.getElementById('progressFill');
  if (fill) fill.style.width = pct.toFixed(1) + '%';
  const text = document.getElementById('progressText');
  if (text) text.textContent = cur + ' / ' + total + ' lines (' + pct.toFixed(0) + '%)';
}

// ═══════════════════════════════════════════════
// PROGRAM LIMITS
// ═══════════════════════════════════════════════

/** The interpreter's bounds in the old module's shape (job.AxisRange). */
function axisRange(b: Bounds): job.AxisRange {
  const has = (a: 'x' | 'y' | 'z') => b.min[a] !== null;
  return {
    xMin: b.min.x ?? 0, xMax: b.max.x ?? 0, yMin: b.min.y ?? 0, yMax: b.max.y ?? 0, zMin: b.min.z ?? 0, zMax: b.max.z ?? 0,
    hasX: has('x'), hasY: has('y'), hasZ: has('z'),
  };
}

/** The program's own motion (program.ts programExtent): overall in machine coordinates; per work offset in
 *  that offset's coordinates, in the order the program uses them. */
function computeProgLimits(v: program.ProgramView | null): void {
  if (!v || !v.program.moves.length) {
    state.progLimits = null;
  } else {
    const per = v.extent.perWorkOffset;
    const order = Object.keys(per) as (keyof typeof per)[];
    const perWcs: Record<string, job.AxisRange> = {};
    for (const code of order) perWcs[code] = axisRange(per[code]!);
    state.progLimits = { overall: axisRange(v.extent.machine), perWcs, order };
  }
  renderProgLimits();
}

effect(() => computeProgLimits(program.view.value));

function getLimitsTabs(): { id: string; label: string; stats: any; frameable: boolean }[] {
  if (!state.progLimits) return [];
  const tabs = [{ id: 'overall', label: 'Overall', stats: state.progLimits.overall, frameable: false }];
  for (const code of state.progLimits.order || []) {
    const stats = state.progLimits.perWcs?.[code];
    if (stats) tabs.push({ id: code, label: code, stats, frameable: true });
  }
  return tabs;
}

function getSelectedLimitsTab(): { id: string; label: string; stats: any; frameable: boolean } | null {
  const tabs = getLimitsTabs();
  if (!tabs.length) return null;
  const ids = tabs.map(t => t.id);
  if (!ids.includes(state.progLimitsTab)) {
    if ((state.progLimits.order || []).includes(state.activeWcs)) state.progLimitsTab = state.activeWcs;
    else state.progLimitsTab = tabs[0].id;
  }
  return tabs.find(t => t.id === state.progLimitsTab) || tabs[0];
}

export function renderProgLimits(): void {
  job.limits.value = state.progLimits;
  const emptyEl = document.getElementById('limitsEmpty');
  const contentEl = document.getElementById('limitsContent');
  const tabsEl = document.getElementById('limitsTabs');
  const frameBtn = document.getElementById('limitsFrameBtn') as HTMLButtonElement | null;
  if (!emptyEl || !contentEl) return;

  if (!state.progLimits || !state.progLimits.overall) {
    emptyEl.style.display = '';
    contentEl.style.display = 'none';
    if (tabsEl) tabsEl.innerHTML = '';
    if (frameBtn) {
      frameBtn.disabled = true;
      frameBtn.textContent = '⬛ FRAME PROGRAM';
      frameBtn.title = '';
    }
    return;
  }

  emptyEl.style.display = 'none';
  contentEl.style.display = '';

  const tabs = getLimitsTabs();
  const selected = getSelectedLimitsTab();
  if (!selected) return;

  if (tabsEl) {
    tabsEl.style.display = tabs.length > 1 ? '' : 'none';
    tabsEl.innerHTML = '';
    for (const tab of tabs) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'limits-tab' + (tab.id === selected.id ? ' active' : '');
      btn.textContent = tab.label;
      btn.addEventListener('click', () => {
        state.progLimitsTab = tab.id;
        renderProgLimits();
      });
      tabsEl.appendChild(btn);
    }
  }

  if (frameBtn) {
    frameBtn.disabled = !state.connected || !selected.frameable;
    frameBtn.textContent = selected.frameable ? `⬛ FRAME ${selected.id}` : '⬛ FRAME PROGRAM';
    frameBtn.title = selected.frameable ? `Frame limits for ${selected.id}` : 'Select a WCS tab to frame that program section';
  }

  const fmt = (v: number) => v.toFixed(3);
  const span = (mn: number, mx: number) => (mx - mn).toFixed(3);
  const dash = '—';
  const p = selected.stats;

  document.getElementById('limXMin')!.textContent = p.hasX ? fmt(p.xMin) : dash;
  document.getElementById('limXMax')!.textContent = p.hasX ? fmt(p.xMax) : dash;
  document.getElementById('limXSpan')!.textContent = p.hasX ? span(p.xMin, p.xMax) : dash;
  document.getElementById('limYMin')!.textContent = p.hasY ? fmt(p.yMin) : dash;
  document.getElementById('limYMax')!.textContent = p.hasY ? fmt(p.yMax) : dash;
  document.getElementById('limYSpan')!.textContent = p.hasY ? span(p.yMin, p.yMax) : dash;
  document.getElementById('limZMin')!.textContent = p.hasZ ? fmt(p.zMin) : dash;
  document.getElementById('limZMax')!.textContent = p.hasZ ? fmt(p.zMax) : dash;
  document.getElementById('limZSpan')!.textContent = p.hasZ ? span(p.zMin, p.zMax) : dash;

  const sel = document.getElementById('limitsSafeZRef') as HTMLSelectElement | null;
  if (sel) {
    const prev = sel.value;
    sel.innerHTML = '<option value="absolute">ABS</option>';
    for (const entry of WCS_ENTRIES) {
      if (entry.code === 'G28' || entry.code === 'G30' || entry.code === 'TLO') continue;
      const opt = document.createElement('option');
      opt.value = entry.code;
      opt.textContent = entry.code;
      sel.appendChild(opt);
    }
    if (prev && sel.querySelector(`option[value="${prev}"]`)) sel.value = prev;
  }
}

// Hard limit: no absolute machine coordinate may exceed -1.
// Returns list of violating axis names, or empty if all clear.
function checkAbsoluteBounds(coords: { axis: string; absVal: number }[]): string[] {
  const BAD_LIMIT = -1;
  const violations: string[] = [];
  for (const c of coords) {
    if (c.absVal > BAD_LIMIT) violations.push(`${c.axis} (${c.absVal.toFixed(3)})`);
  }
  return violations;
}

export function frameProgram(): void {
  const selected = getSelectedLimitsTab();
  if (!state.connected || !selected || !selected.frameable) return;
  const safeZ = parseFloat((document.getElementById('limitsSafeZ') as HTMLInputElement).value);
  if (isNaN(safeZ)) { log('err', 'Frame: invalid Safe Z value'); return; }

  const ref = (document.getElementById('limitsSafeZRef') as HTMLSelectElement)?.value || 'absolute';
  const off = state.wcsOffsets[selected.id] || { x: 0, y: 0, z: 0 };
  const { xMin, xMax, yMin, yMax } = selected.stats;

  // Compute absolute machine coords for all frame corners
  const absXMin = xMin + off.x;
  const absXMax = xMax + off.x;
  const absYMin = yMin + off.y;
  const absYMax = yMax + off.y;

  // Compute absolute Z for safe height
  let absSafeZ: number;
  if (ref === 'absolute') {
    absSafeZ = safeZ;
  } else {
    const refOff = state.wcsOffsets[ref] || { x: 0, y: 0, z: 0 };
    absSafeZ = safeZ + refOff.z;
  }

  // Check every coordinate that will be commanded against the -1 limit
  const violations = checkAbsoluteBounds([
    { axis: 'X', absVal: absXMax },
    { axis: 'Y', absVal: absYMax },
    { axis: 'Z', absVal: absSafeZ },
  ]);

  if (violations.length) {
    log('err', `Frame BLOCKED — would exceed -1 in absolute machine space: ${violations.join(', ')}. Adjust WCS or program.`);
    return;
  }

  // Build Z command. G21 G90 first: the frame is absolute mm, whatever a probe or a job left.
  let zCmd: string;
  if (ref === 'absolute') {
    zCmd = `G21 G90 G53 G0 Z${safeZ.toFixed(4)}`;
  } else {
    const refOff = state.wcsOffsets[ref] || { x: 0, y: 0, z: 0 };
    const curOff = off;
    const absZ = safeZ + refOff.z;
    const workZ = absZ - curOff.z;
    zCmd = `G21 G90 G0 Z${workZ.toFixed(4)}`;
  }

  const f = (v: number) => v.toFixed(4);

  log('info', `Framing ${selected.id} — X[${xMin.toFixed(3)} → ${xMax.toFixed(3)}] Y[${yMin.toFixed(3)} → ${yMax.toFixed(3)}] SafeZ:${safeZ} (${ref})`);

  sendCmd(zCmd);
  sendCmd(`G0 X${f(xMin)} Y${f(yMin)}`);
  sendCmd(`G0 X${f(xMax)} Y${f(yMin)}`);
  sendCmd(`G0 X${f(xMax)} Y${f(yMax)}`);
  sendCmd(`G0 X${f(xMin)} Y${f(yMax)}`);
  sendCmd(`G0 X${f(xMin)} Y${f(yMin)}`);
}

// ── File loading ──────────────────────────────────────────────────────────────
export function loadFile(input: HTMLInputElement): void {
  const file = input.files?.[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = e => processGcode(e.target!.result as string, file.name);
  reader.readAsText(file);
}

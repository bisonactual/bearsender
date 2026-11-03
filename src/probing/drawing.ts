// ═══════════════════════════════════════════════
// The Probing screen's pictures, as SVG: the part, the probe and its moves from above and from the
// front (a plan, from plan.ts); the part to pick a corner, side or the top on; and the choice tiles.
// Drawn as in the agreed mockup (probing-mockup.html, 3 Nov).
// ═══════════════════════════════════════════════

import type { Plan } from './plan';
import type { Point } from './io';
import { CORNERS, SIDES } from './edge-finder';

/** The mockup's colours, from the app's palette; the part's own in its browns. */
export const C = { fg: '#f1f5f9', fg2: '#cbd5e1', dim: '#94a3b8', go: '#4ade80', warn: '#fbbf24', acc: '#ff8c42', stock: '#2c2920', edge: '#7a725c', pocket: '#11100d', well: '#141310', tool: '#cbd5e1', plate: '#3a3528' };
const BIG = 4000;
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export interface ViewState {
  /** The step shown: the preview's, or the run's. */
  cur: number;
  /** A run of this routine is on show: the moves after `cur` are faded. */
  live: boolean;
  /** The new zero is marked. */
  showRes: boolean;
  /** Where the probe is in the drawing's frame, during a run; else at the step's place. */
  at: Point | null;
  tip: number;
  /** Rotation's measured angle, once measured, for its mark. */
  angle: number | null;
}

/** One view of a plan, `W`×`H` px: 'xy' from above, 'xz' from the front. `id` keeps its clip path its own. */
export function viewSvg(W: number, H: number, v: 'xy' | 'xz', m: Plan, s: ViewState, id: string): string {
  const w = m.wps;
  if (!w.length || W < 20 || H < 20) return '';
  const ax = (p: Point): [number, number] => v === 'xy' ? [p.x, p.y] : [p.x, p.z];
  // The bounds: every move, and a little of the part.
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  const inc = (a: number, b: number) => { x0 = Math.min(x0, a); x1 = Math.max(x1, a); y0 = Math.min(y0, b); y1 = Math.max(y1, b); };
  w.forEach(p => inc(...ax(p)));
  const st = m.stock;
  if (v === 'xz') {
    if (st.k === 'plate') { inc(-22, -8); inc(22, st.top + 30); }
    else if (st.k === 'setter') { inc(x0 - 20, -30); inc(Math.max(x1, 20), st.z0 + 10); }
    else inc(x0, -6);
  }
  if (st.k === 'bore' || st.k === 'boss') { const R = Math.max(st.R.x, st.R.y); inc(-R - 4, v === 'xy' ? -R - 4 : -6); inc(R + 4, v === 'xy' ? R + 4 : 4); }
  const padX = (x1 - x0) * .16 + 4, padY = (y1 - y0) * .16 + 4;
  x0 -= padX; x1 += padX; y0 -= padY; y1 += padY;
  const top = 22, pad = 14, k = Math.min((W - 2 * pad) / (x1 - x0), (H - top - pad) / (y1 - y0));
  const ox = pad + ((W - 2 * pad) - k * (x1 - x0)) / 2 - k * x0, oy = top + ((H - top - pad) - k * (y1 - y0)) / 2 + k * y1;
  const X = (a: number) => ox + k * a, Y = (b: number) => oy - k * b, L = (d: number) => d * k;
  const rect = (ax0: number, ay0: number, bx: number, by: number, fill: string, stroke?: string) =>
    `<rect x="${Math.min(X(ax0), X(bx))}" y="${Math.min(Y(ay0), Y(by))}" width="${Math.abs(X(bx) - X(ax0))}" height="${Math.abs(Y(by) - Y(ay0))}" fill="${fill}" stroke="${stroke || 'none'}" stroke-width="1.5"/>`;
  const text = (x: number, y: number, t: string) => `<text x="${x}" y="${y}" fill="${C.dim}" font-size="11" font-family="Barlow">${esc(t)}</text>`;
  let o = '';

  // The part
  if (v === 'xy') {
    if (st.k === 'corner') o += rect(0, 0, st.s.x * BIG, st.s.y * BIG, C.stock, C.edge);
    else if (st.k === 'pcorner') o += rect(-BIG, -BIG, BIG, BIG, C.stock) + rect(0, 0, st.s.x * BIG, st.s.y * BIG, C.pocket, C.edge);
    else if (st.k === 'side') o += st.a === 'x' ? rect(0, -BIG, st.d * BIG, BIG, C.stock, C.edge) : rect(-BIG, 0, BIG, st.d * BIG, C.stock, C.edge);
    else if (st.k === 'pside') o += rect(-BIG, -BIG, BIG, BIG, C.stock) + (st.a === 'x' ? rect(0, -BIG, st.d * BIG, BIG, C.pocket, C.edge) : rect(-BIG, 0, BIG, st.d * BIG, C.pocket, C.edge));
    else if (st.k === 'bore') o += rect(-BIG, -BIG, BIG, BIG, C.stock) + `<ellipse cx="${X(0)}" cy="${Y(0)}" rx="${L(st.R.x)}" ry="${L(st.R.y)}" fill="${C.pocket}" stroke="${C.edge}" stroke-width="1.5"/>`;
    else if (st.k === 'boss') o += `<ellipse cx="${X(0)}" cy="${Y(0)}" rx="${L(st.R.x)}" ry="${L(st.R.y)}" fill="${C.stock}" stroke="${C.edge}" stroke-width="1.5"/>`;
    else if (st.k === 'rot') {
      const P = (a: number, b: number) => `${X(a)},${Y(b)}`;
      let pts: string[];
      if (st.along === 'x') { const sl = Math.tan(st.th); pts = st.d > 0 ? [P(-BIG, -BIG * sl), P(BIG, BIG * sl), P(BIG, BIG), P(-BIG, BIG)] : [P(-BIG, -BIG * sl), P(BIG, BIG * sl), P(BIG, -BIG), P(-BIG, -BIG)]; }
      else { const sl = -Math.tan(st.th); pts = st.d > 0 ? [P(-BIG * sl, -BIG), P(BIG * sl, BIG), P(BIG, BIG), P(BIG, -BIG)] : [P(-BIG * sl, -BIG), P(BIG * sl, BIG), P(-BIG, BIG), P(-BIG, -BIG)]; }
      o += `<polygon points="${pts.join(' ')}" fill="${C.stock}" stroke="${C.edge}" stroke-width="1.5"/>`;
      o += st.along === 'x' ? `<line x1="${X(-BIG)}" y1="${Y(0)}" x2="${X(BIG)}" y2="${Y(0)}" stroke="${C.dim}" stroke-dasharray="2 4"/>`
        : `<line x1="${X(0)}" y1="${Y(-BIG)}" x2="${X(0)}" y2="${Y(BIG)}" stroke="${C.dim}" stroke-dasharray="2 4"/>`;
    }
  } else {
    const below = -60;
    if (st.k === 'corner') o += rect(0, below, st.s.x * BIG, 0, C.stock, C.edge);
    else if (st.k === 'pcorner') o += rect(-BIG, below, BIG, 0, C.stock) + rect(0, -8, st.s.x * BIG, 0, C.pocket, C.edge);
    else if (st.k === 'side') o += st.a === 'x' ? rect(0, below, st.d * BIG, 0, C.stock, C.edge) : rect(-BIG, below, BIG, 0, C.stock, C.edge);
    else if (st.k === 'pside') o += rect(-BIG, below, BIG, 0, C.stock) + (st.a === 'x' ? rect(0, -8, st.d * BIG, 0, C.pocket, C.edge) : '');
    else if (st.k === 'top') o += rect(-BIG, below, BIG, 0, C.stock, C.edge) + (st.plate ? rect(-14, 0, 14, st.plate, C.plate, C.fg2) : '');
    else if (st.k === 'pfloor') o += rect(-BIG, below, BIG, 0, C.stock) + rect(-30, -8, 30, 0, C.pocket, C.edge) + (st.plate ? rect(-14, -8, 14, -8 + st.plate, C.plate, C.fg2) : '');
    else if (st.k === 'bore') o += rect(-BIG, below, BIG, 0, C.stock) + rect(-st.R.x, -14, st.R.x, 0, C.pocket, C.edge);
    else if (st.k === 'boss') o += rect(-BIG, below, BIG, -10, C.stock, C.edge) + rect(-st.R.x, -10, st.R.x, 0, C.stock, C.edge);
    else if (st.k === 'rot') o += rect(-BIG, below, BIG, 0, C.stock, C.edge);
    else if (st.k === 'plate') o += rect(-BIG, -40, BIG, 0, C.stock, C.edge) + rect(-18, 0, 18, st.top, C.plate, C.fg2) + text(X(18) + 6, Y(st.top / 2) + 4, `plate ${st.top.toFixed(1)} mm`);
    else if (st.k === 'setter') {
      const sx = w[0].x;
      o += rect(sx - 40, -60, sx + 40, Math.min(20, w[0].z - 10), C.stock, C.edge);
      o += rect(-14, -60, 14, -6, C.plate, C.edge) + rect(-8, -6, 8, 0, C.fg2);
      o += `<line x1="${X(-BIG)}" y1="${Y(st.z0)}" x2="${X(BIG)}" y2="${Y(st.z0)}" stroke="${C.dim}" stroke-dasharray="3 5"/>` + text(X(x0) + 6, Y(st.z0) - 5, 'machine Z0');
      o += text(X(14) + 6, Y(-20), st.known ? 'toolsetter' : 'toolsetter (example place)');
    }
  }

  // The moves: rapids dashed, probing solid, the slow touch heavier; the ones to come faded during a run
  const pt = (i: number): [number, number] => { const q = ax(w[i]); return [X(q[0]), Y(q[1])]; };
  for (let i = 1; i < w.length; i++) {
    const t = w[i].type;
    if (t === 'contact') continue;
    let j = i - 1;
    while (j > 0 && w[j].type === 'contact') j--;
    const a = pt(j), b = pt(i);
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < .5) continue;
    const op = !s.live || i <= s.cur ? 1 : .28;
    const sty = t === 'rapid' || t === 'result' ? `stroke="${C.dim}" stroke-dasharray="5 4" stroke-width="1.5"`
      : t === 'back' ? `stroke="${C.dim}" stroke-width="1.5"` : `stroke="${C.fg}" stroke-width="${t === 'slow' ? 2.6 : 2}"`;
    o += `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" ${sty} opacity="${op}"/>`;
  }
  w.forEach((p, i) => { if (p.type === 'contact' && (!s.live || i <= s.cur)) { const q = pt(i); o += `<circle cx="${q[0]}" cy="${q[1]}" r="4" fill="${C.go}"/>`; } });

  // Where it starts: a yellow ring, labelled away from the new zero
  const s0 = pt(0), org = [X(0), Y(0)];
  let u = [s0[0] - org[0], s0[1] - org[1]];
  const un = Math.hypot(u[0], u[1]);
  u = un < 4 ? [.7, -.7] : [u[0] / un, u[1] / un];
  if (Math.abs(u[0]) < .25) u = [.7, u[1] < 0 ? -.7 : .7];
  const rr = Math.max(L(s.tip / 2), 3) + 6;
  // A tool is drawn over its start, so there the mark goes on top.
  const startMark = `<circle cx="${s0[0]}" cy="${s0[1]}" r="${rr}" fill="none" stroke="${C.warn}" stroke-width="2"/><text x="${s0[0] + u[0] * (rr + 6) + (m.tool ? Math.max(L(3), 4) * Math.sign(u[0] || 1) : 0)}" y="${s0[1] + u[1] * (rr + 6) + (u[1] > 0 ? 9 : 0)}" text-anchor="${u[0] < 0 ? 'end' : 'start'}" fill="${C.warn}" font-size="12" font-weight="700" letter-spacing="1.5" font-family="Barlow Condensed">START</text>`;
  if (!m.tool) o += startMark;
  const away = [-u[0], -u[1]];
  const lab = (c: [number, number], t: string) => {
    const wd = t.length * 7.4 + 14, dx = away[0] < 0 ? -wd - 12 : 12, dy = away[1] < 0 ? -29 : 10;
    return `<g transform="translate(${c[0] + dx},${c[1] + dy})"><rect width="${wd}" height="19" rx="4" fill="${C.acc}"/><text x="7" y="14" fill="#1a1208" font-size="13" font-family="Share Tech Mono">${esc(t)}</text></g>`;
  };
  const cross = (c: [number, number]) => `<g stroke="${C.acc}" stroke-width="2.2"><line x1="${c[0] - 11}" y1="${c[1]}" x2="${c[0] + 11}" y2="${c[1]}"/><line x1="${c[0]}" y1="${c[1] - 11}" x2="${c[0]}" y2="${c[1] + 11}"/></g><circle cx="${c[0]}" cy="${c[1]}" r="6" fill="none" stroke="${C.acc}" stroke-width="1.5"/>`;
  const vline = (x: number, dash: string) => `<line x1="${X(x)}" y1="${Y(-BIG)}" x2="${X(x)}" y2="${Y(BIG)}" stroke="${C.acc}" stroke-width="${dash ? 1.5 : 2}"${dash ? ` stroke-dasharray="${dash}" opacity=".9"` : ''}/>`;
  const hline = (y: number) => `<line x1="${X(-BIG)}" y1="${Y(y)}" x2="${X(BIG)}" y2="${Y(y)}" stroke="${C.acc}" stroke-width="2"/>`;

  // The new zero, in orange like the work offset chip
  const R = m.res;
  if (R && s.showRes) {
    if (R.k === 'xy' || R.k === 'c') {
      if (v === 'xy') { const c: [number, number] = [X(0), Y(0)]; o += cross(c) + lab(c, R.k === 'c' ? 'centre' : 'X0 Y0'); }
      else o += vline(0, '1 4') + lab([X(0), Y(0) + 16], 'X0');
    } else if (R.k === 'x' || R.k === 'y') {
      if (v === 'xy') o += R.k === 'x' ? vline(0, '') + lab([X(0), Y(y1) + 8], 'X0') : hline(0) + lab([X(x0) + 30, Y(0)], 'Y0');
      else if (R.k === 'x') o += vline(0, '1 4');
    } else if (R.k === 'z') o += hline(R.z) + lab([X(x0) + 40, Y(R.z)], 'Z0');
    else if (R.k === 'angle' && v === 'xy' && s.angle !== null && st.k === 'rot') {
      const q = m.spacing, p2 = st.along === 'x' ? [q, q * Math.tan(st.th)] : [-q * Math.tan(st.th), q];
      o += `<line x1="${X(0)}" y1="${Y(0)}" x2="${X(p2[0])}" y2="${Y(p2[1])}" stroke="${C.acc}" stroke-width="2"/>` + lab([X(p2[0] / 2), Y(p2[1] / 2) - 14], `${s.angle.toFixed(3)}°`);
    }
  }

  // The probe, or the tool, where it is now
  const here = s.at ? [X(ax(s.at)[0]), Y(ax(s.at)[1])] : pt(Math.min(s.cur, w.length - 1));
  if (m.tool) {
    const tw = Math.max(L(6), 8), fl = L(18);
    o += `<rect x="${here[0] - tw / 2}" y="${here[1] - fl}" width="${tw}" height="${fl}" fill="${C.tool}" opacity=".9"/><rect x="${here[0] - tw * .4}" y="-10" width="${tw * .8}" height="${Math.max(here[1] - fl + 10, 0)}" fill="${C.dim}" opacity=".7"/>`;
    for (let i = 1; i < 4; i++) o += `<line x1="${here[0] - tw / 2}" y1="${here[1] - fl * i / 4}" x2="${here[0] + tw / 2}" y2="${here[1] - fl * i / 4 + tw * .5}" stroke="${C.well}" stroke-width="1.5"/>`;
  } else {
    const pr = Math.max(L(s.tip / 2), 3.5);
    if (v === 'xz') o += `<line x1="${here[0]}" y1="${here[1]}" x2="${here[0]}" y2="-4" stroke="${C.fg2}" stroke-width="${Math.max(pr * .55, 2)}"/>`;
    o += `<circle cx="${here[0]}" cy="${here[1]}" r="${pr}" fill="${C.fg}" stroke="${C.well}" stroke-width="1.5"/>`;
  }

  if (m.tool) o += startMark;

  // Which way is plus
  const ah = v === 'xy' ? ['X+', 'Y+'] : ['X+', 'Z+'], bx = W - 58, by = H - 12;
  o += `<g stroke="${C.dim}" stroke-width="1.5" fill="none" opacity=".8"><path d="M${bx} ${by}h26m-5-4l5 4-5 4"/><path d="M${bx} ${by}v-26m-4 5l4-5 4 5"/></g><text x="${bx + 30}" y="${by + 4}" fill="${C.dim}" font-size="10" font-family="Share Tech Mono">${ah[0]}</text><text x="${bx - 6}" y="${by - 30}" fill="${C.dim}" font-size="10" font-family="Share Tech Mono">${ah[1]}</text>`;
  return `<defs><clipPath id="cl-${id}"><rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="9"/></clipPath></defs><g clip-path="url(#cl-${id})">${o}</g>`;
}

// ── The picker: the part from above, with a target on each corner, side and the top ──

/** Where each target sits on the picker, as fractions of the part's width and depth from its back-left. */
export const PICK_AT: Record<string, [number, number]> = {
  D: [0, 0], CD: [.5, 0], C: [1, 0], AD: [0, .5], Z: [.5, .5], CB: [1, .5], A: [0, 1], AB: [.5, 1], B: [1, 1],
};
/** A target's place on the picker, in % of its box. */
export const pickAt = (id: string): [number, number] => [21 + 58 * PICK_AT[id][0], 21 + 58 * PICK_AT[id][1]];

function arrow(x1: number, y1: number, x2: number, y2: number, col: string): string {
  const a = Math.atan2(y2 - y1, x2 - x1), h = 7;
  return `<g stroke="${col}" stroke-width="2.2" stroke-linecap="round" fill="none"><path d="M${x1} ${y1}L${x2} ${y2}"/><path d="M${x2 - h * Math.cos(a - .5)} ${y2 - h * Math.sin(a - .5)}L${x2} ${y2}L${x2 - h * Math.cos(a + .5)} ${y2 - h * Math.sin(a + .5)}"/></g>`;
}

/** The part from above (or the pocket, `ins`), the touches for the pick as arrows, and where it starts as
 *  a yellow ring. `rot`: rotation's two touches on the side picked. */
export function pickerSvg(W: number, H: number, pick: string | null, ins: boolean, rot: boolean): string {
  if (!W || !H) return '';
  const px = (v: number) => v * W / 100, py = (v: number) => v * H / 100, fg = C.fg;
  const x0 = px(21), x1 = px(79), y0 = py(21), y1 = py(79);
  let g = ins
    ? `<rect x="${px(6)}" y="${py(10)}" width="${px(88)}" height="${py(80)}" rx="3" fill="${C.stock}" stroke="${C.edge}" stroke-width="1.5"/><rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" rx="2" fill="${C.pocket}" stroke="${C.edge}" stroke-width="1.5"/>`
    : `<g ${rot ? `transform="rotate(-1.5 ${W / 2} ${H / 2})"` : ''}><rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" rx="3" fill="${C.stock}" stroke="${C.edge}" stroke-width="1.5"/></g>`;
  const ring = (x: number, y: number) => `<circle cx="${x}" cy="${y}" r="7" fill="none" stroke="${C.warn}" stroke-width="2"/>`;
  if (!pick) return g;
  const [cxp, cyp] = pickAt(pick), cx = px(cxp), cy = py(cyp);
  if (!rot) {
    if (pick.length === 1 && pick !== 'Z') {
      const s = CORNERS[pick], t = ins ? { x: -s.x, y: -s.y } : s;
      const ty = cy - s.y * Math.min(28, (y1 - y0) * .3), tx = cx + s.x * Math.min(34, (x1 - x0) * .22);
      g += arrow(cx - t.x * 34, ty, cx - t.x * 7, ty, fg) + arrow(tx, cy + t.y * 30, tx, cy + t.y * 7, fg);
      g += ins ? ring(cx + s.x * 15, cy - s.y * 15) : ring(cx - s.x * 13, cy + s.y * 13);
    } else if (pick.length === 2) {
      const q = SIDES[pick], d = q.into, t = ins ? -d : d;
      if (q.axis === 'X') { g += arrow(cx - t * 34, cy, cx - t * 7, cy, fg) + ring(cx + d * (ins ? 16 : 5), cy + (ins ? 0 : 16)); }
      else { g += arrow(cx, cy + t * 30, cx, cy + t * 7, fg) + ring(cx + (ins ? 0 : 16), cy - d * (ins ? 16 : 5)); }
    } else g += arrow(cx + 26, cy - 22, cx + 7, cy - 6, fg) + ring(cx + 30, cy - 26);
  } else {
    const q = SIDES[pick], d = q.into, along = q.axis === 'Y' ? 'x' : 'y';
    const pts = along === 'x' ? [[x0 + (x1 - x0) * .22, d > 0 ? y1 : y0], [x0 + (x1 - x0) * .72, d > 0 ? y1 : y0]]
      : [[d > 0 ? x0 : x1, y1 - (y1 - y0) * .22], [d > 0 ? x0 : x1, y1 - (y1 - y0) * .72]];
    pts.forEach(([x, y]) => { g += along === 'x' ? arrow(x, y + d * 30, x, y + d * 7, fg) : arrow(x - d * 34, y, x - d * 7, y, fg); });
    g += along === 'x' ? ring(pts[0][0] + 14, pts[0][1] - d * 5) : ring(pts[0][0] + d * 5, pts[0][1] - 14);
  }
  return g;
}

// ── The choice tiles ──

export function tileSvg(v: 'bore' | 'boss' | 'plate' | 'setter'): string {
  if (v === 'bore') return `<svg viewBox="0 0 120 64" aria-hidden="true"><rect x="12" y="6" width="96" height="52" rx="3" fill="${C.stock}" stroke="${C.edge}" stroke-width="1.5"/><circle cx="60" cy="32" r="18" fill="${C.pocket}" stroke="${C.edge}" stroke-width="1.5"/><circle cx="60" cy="32" r="3" fill="currentColor"/><path d="M60 32h12M60 32h-12" stroke="currentColor" stroke-width="1.5"/></svg>`;
  if (v === 'boss') return `<svg viewBox="0 0 120 64" aria-hidden="true"><rect x="12" y="6" width="96" height="52" rx="3" fill="none" stroke="${C.edge}" stroke-dasharray="3 4"/><circle cx="60" cy="32" r="18" fill="${C.stock}" stroke="${C.edge}" stroke-width="1.5"/><circle cx="60" cy="32" r="3" fill="currentColor"/><path d="M30 32h10M90 32H80" stroke="currentColor" stroke-width="1.5"/></svg>`;
  if (v === 'plate') return `<svg viewBox="0 0 120 64" aria-hidden="true"><rect x="4" y="46" width="112" height="16" fill="${C.stock}" stroke="${C.edge}"/><rect x="40" y="38" width="40" height="8" fill="${C.plate}" stroke="${C.fg2}"/><rect x="56" y="10" width="8" height="18" fill="currentColor"/><rect x="57" y="0" width="6" height="10" fill="${C.dim}"/><path d="M60 30v5" stroke="currentColor" stroke-dasharray="2 2"/></svg>`;
  return `<svg viewBox="0 0 120 64" aria-hidden="true"><rect x="4" y="50" width="56" height="12" fill="${C.stock}" stroke="${C.edge}"/><rect x="84" y="30" width="20" height="32" fill="${C.plate}" stroke="${C.edge}"/><rect x="88" y="26" width="12" height="4" fill="${C.fg2}"/><rect x="26" y="20" width="8" height="18" fill="currentColor"/><rect x="27" y="4" width="6" height="16" fill="${C.dim}"/><path d="M30 18V8h64v14" fill="none" stroke="currentColor" stroke-dasharray="3 3"/></svg>`;
}

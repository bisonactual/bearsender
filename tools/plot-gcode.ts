#!/usr/bin/env bun
/** Plots a G-code file as the interpreter reads it (XY and XZ SVGs and a JSON summary). Bun only; the
 *  interpreter it imports is browser TypeScript. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { interpretGcode, sampleMove, moveExtrema, type Axis, type InterpreterContext, type Move, type Position } from '../src/gcode/index';

const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
if (!args[0] || args.includes('--help')) {
  console.log('bun tools/plot-gcode.ts INPUT --out PREFIX [--context JSON] [--overlay FILE] [--dump]');
  process.exit(args.includes('--help') ? 0 : 1);
}
const input = resolve(args[0]), prefix = resolve(option('--out') ?? basename(input).replace(/\.[^.]+$/, ''));
const context: InterpreterContext = option('--context') ? JSON.parse(await readFile(resolve(option('--context')!), 'utf8')) : {};
const text = await readFile(input, 'utf8'), program = interpretGcode(text, context);
const xml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));
type Trace = { points: Position[]; rapid: boolean };
let overlay: Trace[] = [], overlayName = '';

if (option('--overlay')) {
  const other = interpretGcode(await readFile(resolve(option('--overlay')!), 'utf8'), context);
  overlay = other.moves.map(m => ({ points: sampleMove(m), rapid: m.kind === 'rapid' }));
  overlayName = basename(option('--overlay')!);
}

function svg(horizontal: Axis, vertical: Axis): string {
  const width = 1100, height = 720, left = 95, top = 90, plotWidth = 940, plotHeight = 525;
  const pts = program.moves.flatMap(moveExtrema).concat(overlay.flatMap(t => t.points));
  const h = pts.map(p => p[horizontal]).filter(v => v !== null) as number[];
  const v = pts.map(p => p[vertical]).filter(v => v !== null) as number[];
  const minH = h.length ? h.reduce((a, b) => Math.min(a, b)) : 0, maxH = h.length ? h.reduce((a, b) => Math.max(a, b)) : 1;
  const minV = v.length ? v.reduce((a, b) => Math.min(a, b)) : 0, maxV = v.length ? v.reduce((a, b) => Math.max(a, b)) : 1;
  const spanH = Math.max(1, maxH - minH), spanV = Math.max(1, maxV - minV);
  const scale = Math.min(plotWidth / (spanH * 1.1), plotHeight / (spanV * 1.1));
  const cx = (minH + maxH) / 2, cy = (minV + maxV) / 2;
  const px = (n: number) => left + plotWidth / 2 + (n - cx) * scale;
  const py = (n: number) => top + plotHeight / 2 - (n - cy) * scale;
  const path = (points: Position[]) => {
    let d = '', pen = false;
    for (const p of points) {
      if (p[horizontal] === null || p[vertical] === null) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${px(p[horizontal]!).toFixed(3)},${py(p[vertical]!).toFixed(3)} `; pen = true;
    }
    return d;
  };
  const element = (points: Position[], color: string, rapid: boolean, title: string) => `<path d="${path(points)}" fill="none" stroke="${color}" stroke-width="${rapid ? 1 : 1.5}" opacity="${rapid ? 0.5 : 0.9}"${rapid ? ' stroke-dasharray="5 4"' : ''}><title>${xml(title)}</title></path>`;
  const grid: string[] = [];
  for (let n = 0; n <= 5; n++) {
    const a = minH + spanH * n / 5, b = minV + spanV * n / 5;
    grid.push(`<path d="M${px(a)},${top}V${top + plotHeight} M${left},${py(b)}H${left + plotWidth}" stroke="#29394b" fill="none"/>`);
    grid.push(`<text x="${px(a)}" y="${top + plotHeight + 25}" text-anchor="middle">${a.toFixed(2)}</text><text x="${left - 10}" y="${py(b) + 4}" text-anchor="end">${b.toFixed(2)}</text>`);
  }
  const programPaths = program.moves.map((m: Move) => element(sampleMove(m), '#4ce2eb', m.kind === 'rapid', `File line ${m.line}: ${m.source}`)).join('\n');
  const overlayPaths = overlay.map(t => element(t.points, '#fa6072', t.rapid, overlayName)).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="100%" height="100%" fill="#101c2a"/><g font-family="Segoe UI, sans-serif" font-size="13" fill="#bacadd">
<text x="40" y="36" font-size="22" fill="#f0f6ff">${xml(basename(input))}: ${horizontal.toUpperCase()}${vertical.toUpperCase()} machine coordinates (mm)</text>
<text x="40" y="62" fill="#4ce2eb">${xml(basename(input))}</text>${overlay.length ? `<text x="205" y="62" fill="#fa6072">${xml(overlayName)} (red)</text>` : ''}<text x="440" y="62">Dashed = rapid · equal axis scale</text>
${grid.join('\n')}${overlayPaths}${programPaths}
<rect x="${left}" y="${top}" width="${plotWidth}" height="${plotHeight}" fill="none" stroke="#64758a"/>
<text x="${left + plotWidth / 2}" y="${top + plotHeight + 50}" text-anchor="middle">${horizontal.toUpperCase()} (mm)</text>
<text x="22" y="${top + plotHeight / 2}" transform="rotate(-90 22 ${top + plotHeight / 2})" text-anchor="middle">${vertical.toUpperCase()} (mm)</text>
<text x="40" y="690">${program.moves.length} moves · ${program.moves.filter(m => m.kind === 'arc').length} arcs · bounds ${program.bounds.machine.complete ? 'complete' : 'partial: unknown coordinates omitted'} · time lower bound ${program.estimatedSeconds.toFixed(2)} s</text>
</g></svg>`;
}

await mkdir(dirname(prefix), { recursive: true });
for (const [a, b] of [['x', 'y'], ['x', 'z']] as [Axis, Axis][]) await writeFile(`${prefix}-${a}${b}.svg`, svg(a, b));
const summary = {
  input, context, moves: program.moves.length, arcs: program.moves.filter(m => m.arc).length,
  arcDetails: program.moves.filter(m => m.arc).map(m => ({ line: m.line, ...m.arc, length: m.length, estimatedSeconds: m.estimatedSeconds })),
  bounds: program.bounds, estimatedSeconds: program.estimatedSeconds, timeComplete: program.timeComplete,
  tools: program.tools, operations: program.operations, events: program.events, issues: program.issues,
  fileLines: program.lines.length, loaderLines: program.loaderToFile.length - 1,
  fileToLoader: program.fileToLoader, loaderToFile: program.loaderToFile,
  modalChanges: program.lines.filter((l, i) => JSON.stringify({ ...l.stateAfter, position: null }) !== JSON.stringify({ ...(i ? program.lines[i - 1].stateAfter : program.initialState), position: null })).map(l => ({ line: l.line, state: l.stateAfter })),
};
await writeFile(`${prefix}-summary.json`, JSON.stringify(summary, null, 2) + '\n');
if (args.includes('--dump')) await writeFile(`${prefix}-program.json`, JSON.stringify(program, null, 2) + '\n');
console.log(JSON.stringify({ input, prefix, moves: summary.moves, arcs: summary.arcs, seconds: program.estimatedSeconds, boundsComplete: program.bounds.machine.complete, issues: program.issues.length }));

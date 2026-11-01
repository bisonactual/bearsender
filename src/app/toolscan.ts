// ═══════════════════════════════════════════════
// Tool sections — TEMPORARY quick scan for T<n> M6
// ═══════════════════════════════════════════════
//
// Step 2's G-code interpreter replaces this. It only finds tool changes written as T<n>
// and M6 on one line, and takes each section's name from the comment just before it.

export interface ToolSection {
  tool: number;
  /** First and last line of the section, counted from 1 as in the job store. */
  start: number;
  end: number;
  /** The line with the T M6, or 0 when the section comes from the file's header. */
  changeLine: number;
  /** The operation, from the comment before the tool change, if there is one. */
  name: string;
}

export interface ToolScan {
  sections: ToolSection[];
  /** Descriptions from header comments like (T1 D=6. CR=0. - ZMIN=-3. - flat end mill). */
  described: Record<number, string>;
}

const TOOL_CHANGE = /\bT0*(\d+)\b.*\bM0*6\b|\bM0*6\b.*\bT0*(\d+)\b/;
const HEADER_TOOL = /^\(T(\d+)\s+(.*)\)$/i;

function stripComments(line: string): string {
  return line.replace(/\(.*?\)/g, '').replace(/;.*/, '').trim().toUpperCase();
}

function comment(line: string): string | null {
  const m = line.match(/^\((.*)\)$/);
  return m ? m[1].trim() : null;
}

/** "D=6 CR=3 - ZMIN=-5.99 - ball end mill" → "6 mm ball end mill". */
function describe(rest: string): string {
  const parts = rest.split(' - ').map(p => p.trim());
  const dia = rest.match(/\bD=([\d.]+)/i);
  const kind = parts.length > 1 ? parts[parts.length - 1] : '';
  return [dia ? parseFloat(dia[1]) + ' mm' : '', kind].filter(Boolean).join(' ') || rest;
}

export function scanTools(lines: string[]): ToolScan {
  const described: Record<number, string> = {};
  const changes: { tool: number; line: number; name: string }[] = [];
  lines.forEach((raw, i) => {
    const header = raw.match(HEADER_TOOL);
    if (header && !/\bM0*6\b/i.test(header[2])) described[parseInt(header[1])] ??= describe(header[2]);
    const m = stripComments(raw).match(TOOL_CHANGE);
    if (!m) return;
    let name = '';
    for (let j = i - 1; j >= 0 && j >= i - 4; j--) {
      const c = comment(lines[j]);
      if (c && !HEADER_TOOL.test(lines[j])) { name = c; break; }
    }
    changes.push({ tool: parseInt(m[1] ?? m[2]), line: i + 1, name });
  });

  const sections: ToolSection[] = changes.map((c, k) => ({
    tool: c.tool,
    start: k === 0 ? 1 : c.line,
    end: k + 1 < changes.length ? changes[k + 1].line - 1 : lines.length,
    changeLine: c.line,
    name: c.name,
  }));
  // No tool change in the file: one section, with the tool its header lists if there is one.
  if (!sections.length && lines.length) {
    const listed = Object.keys(described).map(Number);
    if (listed.length) sections.push({ tool: listed[0], start: 1, end: lines.length, changeLine: 0, name: '' });
  }
  return { sections, described };
}

export function sectionAt(sections: ToolSection[], line: number): number {
  for (let k = sections.length - 1; k >= 0; k--) if (line >= sections[k].start) return k;
  return 0;
}

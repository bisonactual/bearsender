export interface Block { code: string; comments: string[]; words: [string, number][]; errors: string[] }

/** A strict literal-word lexer: expressions/macros are diagnosed, never partly parsed. */
export function lexLine(raw: string): Block {
  const comments: string[] = [], errors: string[] = [];
  let code = '', depth = 0, comment = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (!depth && ch === ';') { comments.push(raw.slice(i + 1).trim()); break; }
    if (ch === '(') { if (depth++) comment += ch; continue; }
    if (ch === ')') {
      if (!depth) errors.push('Unmatched closing comment delimiter');
      else if (--depth === 0) { comments.push(comment.trim()); comment = ''; } else comment += ch;
      continue;
    }
    if (depth) comment += ch; else code += ch;
  }
  if (depth) errors.push('Unterminated parenthesized comment');
  code = code.trim().toUpperCase();
  if (code === '%') return { code, comments, words: [], errors };
  const compact = code.replace(/\s+/g, '');
  const words: [string, number][] = [];
  const re = /([A-Z])([+-]?(?:\d+(?:\.\d*)?|\.\d+))/gy;
  let at = 0;
  while (at < compact.length) {
    re.lastIndex = at;
    const match = re.exec(compact);
    if (!match) { errors.push(`Unsupported syntax: ${compact.slice(at)}`); break; }
    const value = Number(match[2]);
    if (!Number.isFinite(value)) errors.push(`Non-finite word ${match[0]}`);
    words.push([match[1], value]);
    at = re.lastIndex;
  }
  return { code, comments, words, errors };
}

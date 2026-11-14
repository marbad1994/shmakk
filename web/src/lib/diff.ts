export interface DiffLine { kind: 'add' | 'del' | 'ctx' | 'hunk'; text: string; oldNo?: number; newNo?: number }
export interface ParsedDiff { path: string; lines: DiffLine[]; added: number; removed: number }

export function parseDiff(diff: string): ParsedDiff {
  const out: ParsedDiff = { path: '', lines: [], added: 0, removed: 0 };
  let o = 0;
  let n = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) { out.path = raw.slice(4).replace(/^b\//, ''); continue; }
    if (raw.startsWith('--- ')) continue;
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (h) { o = Number(h[1]); n = Number(h[2]); out.lines.push({ kind: 'hunk', text: raw }); continue; }
    if (raw.startsWith('+')) { out.lines.push({ kind: 'add', text: raw.slice(1), newNo: n++ }); out.added++; }
    else if (raw.startsWith('-')) { out.lines.push({ kind: 'del', text: raw.slice(1), oldNo: o++ }); out.removed++; }
    else if (raw.startsWith('\\')) continue;
    else out.lines.push({ kind: 'ctx', text: raw.startsWith(' ') ? raw.slice(1) : raw, oldNo: o++, newNo: n++ });
  }
  return out;
}

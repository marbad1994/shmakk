// Minimal SGR parser: turns ANSI-coloured terminal text into styled spans.
// Cursor movement and other control sequences are dropped.

export interface AnsiSpan { text: string; cls: string }

const CSI = /\x1b\[([0-9;?]*)([A-Za-z])/g;

export function parseAnsi(input: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  const state = new Set<string>();
  let fg = '';
  let last = 0;
  const push = (text: string) => {
    if (!text) return;
    // carriage-return overwrites (progress bars): keep the final rewrite
    const clean = text.replace(/[^\n]*\r(?!\n)/g, '').replace(/\r/g, '');
    if (!clean) return;
    const cls = [...state, fg].filter(Boolean).join(' ');
    const prev = spans[spans.length - 1];
    if (prev && prev.cls === cls) prev.text += clean;
    else spans.push({ text: clean, cls });
  };
  // strip OSC sequences (titles, hyperlinks) up front
  const src = input.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
  for (const m of src.matchAll(CSI)) {
    push(src.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[2] !== 'm') continue;
    const codes = m[1] === '' ? [0] : m[1].split(';').map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) { state.clear(); fg = ''; }
      else if (c === 1) state.add('ansi-b');
      else if (c === 2) state.add('ansi-d');
      else if (c === 3) state.add('ansi-i');
      else if (c === 4) state.add('ansi-u');
      else if (c === 22) { state.delete('ansi-b'); state.delete('ansi-d'); }
      else if (c === 23) state.delete('ansi-i');
      else if (c === 24) state.delete('ansi-u');
      else if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) fg = `ansi-${c}`;
      else if (c === 39) fg = '';
      else if (c === 38 || c === 48) i += codes[i + 1] === 5 ? 2 : 4; // skip 256/truecolor args
    }
  }
  push(src.slice(last));
  return spans;
}

export function stripAnsi(s: string) {
  return parseAnsi(s).map((x) => x.text).join('');
}

// Markdown-to-ANSI renderer for terminal output.
// Converts common markdown syntax to ANSI escape sequences for
// bold, italic, headers, lists, blockquotes, links, code, etc.
//
// Designed for streaming-friendly line-by-line rendering:
//   renderLine(line, opts) — renders a single line
//   renderBlock(text, opts) — renders a full text block (calls renderLine)

// ── ANSI helpers ────────────────────────────────────────────────────────────

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const ITALIC = '\x1b[3m';
const UNDERLINE = '\x1b[4m';
const RESET = '\x1b[0m';

const COLORS = {
  black:   '\x1b[30m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  magenta: '\x1b[35m',
  cyan:    '\x1b[36m',
  white:   '\x1b[37m',
  brightBlack:  '\x1b[90m',
  brightRed:    '\x1b[91m',
  brightGreen:  '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue:   '\x1b[94m',
  brightCyan:   '\x1b[96m',
};

// ── Inline formatting ───────────────────────────────────────────────────────

function renderInline(text, enabled) {
  if (!enabled) {
    // Strip markdown markers when colors are off
    return text
      .replace(/\*\*\*(.+?)\*\*\*/g, '$1')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '$1')
      .replace(/`(.+?)`/g, '$1');
  }

  let result = text;

  // Bold + italic: ***text***
  result = result.replace(/\*\*\*(.+?)\*\*\*/g, `${BOLD}${ITALIC}$1${RESET}`);

  // Bold: **text**
  result = result.replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${RESET}`);

  // Italic: *text* (single asterisk, not part of **)
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, `${ITALIC}$1${RESET}`);

  // Inline code: `text`
  result = result.replace(/`([^`]+)`/g, `${COLORS.brightBlack}${BOLD}$1${RESET}`);

  // Links: [text](url) — keep text, show URL dimmed
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
    if (label === url) return `${UNDERLINE}${url}${RESET}`;
    return `${UNDERLINE}${label}${RESET} ${DIM}(${url})${RESET}`;
  });

  return result;
}

// ── Block-level rendering ───────────────────────────────────────────────────

const HORIZONTAL_RULE_RE = /^[-*_]{3,}\s*$/;
const HEADER_RE = /^(#{1,6})\s+(.+)$/;
const UNORDERED_LIST_RE = /^(\s*)[-*+]\s+(.+)$/;
const ORDERED_LIST_RE = /^(\s*)(\d+)\.\s+(.+)$/;
const BLOCKQUOTE_RE = /^>\s?(.*)$/;
const CODE_FENCE_RE = /^```(\S*)$/;

function renderLine(line, opts = {}) {
  const { enabled = true, colors = true } = opts;
  const trim = line.trimEnd();
  if (!trim) return '';

  // Code fence — pass through as-is (handled by renderBlock)
  if (CODE_FENCE_RE.test(trim)) {
    if (!enabled || !colors) return line;
    return `${COLORS.brightBlack}${trim}${RESET}`;
  }

  // Horizontal rule
  if (HORIZONTAL_RULE_RE.test(trim)) {
    if (!enabled || !colors) return '---';
    const width = Math.min(process.stdout.columns || 80, 80);
    return DIM + '\u2500'.repeat(width - 1) + RESET;
  }

  // Headers
  const hMatch = trim.match(HEADER_RE);
  if (hMatch) {
    const level = hMatch[1].length;
    const text = renderInline(hMatch[2], enabled && colors);
    if (!enabled || !colors) {
      // Structural only: uppercase headers
      return level <= 2 ? text.toUpperCase() : text;
    }
    if (level <= 2) {
      return `${BOLD}${UNDERLINE}${text}${RESET}`;
    }
    return `${BOLD}${text}${RESET}`;
  }

  // Blockquote
  const bqMatch = trim.match(BLOCKQUOTE_RE);
  if (bqMatch) {
    const text = renderInline(bqMatch[1], enabled && colors);
    if (!enabled || !colors) return `  ${text}`;
    return `${COLORS.brightBlack}\u2502 ${text}${RESET}`;
  }

  // Unordered list
  const ulMatch = trim.match(UNORDERED_LIST_RE);
  if (ulMatch) {
    const indent = ulMatch[1];
    const text = renderInline(ulMatch[2], enabled && colors);
    if (!enabled || !colors) return `  ${indent}\u2022 ${text}`;
    return `${indent}${COLORS.cyan}\u2022${RESET} ${text}`;
  }

  // Ordered list
  const olMatch = trim.match(ORDERED_LIST_RE);
  if (olMatch) {
    const indent = olMatch[1];
    const num = olMatch[2];
    const text = renderInline(olMatch[3], enabled && colors);
    if (!enabled || !colors) return `  ${indent}${num}. ${text}`;
    return `${indent}${COLORS.cyan}${num}.${RESET} ${text}`;
  }

  // Regular line — apply inline formatting
  return renderInline(trim, enabled && colors);
}

function renderBlock(text, opts = {}) {
  const { enabled = true, colors = true } = opts;
  const src = String(text || '');
  if (!src) return src;

  const lines = src.split('\n');
  const out = [];
  let inCodeBlock = false;
  let codeLang = '';
  let codeLines = [];

  function flushCode() {
    if (!codeLines.length) return;
    if (!enabled || !colors) {
      out.push(`[${codeLang || 'code'}]`);
      for (const l of codeLines) out.push(`  ${l}`);
      codeLines = [];
      return;
    }
    const head = `${COLORS.brightCyan}${BOLD}${codeLang || 'code'}${RESET}`;
    out.push(head);
    for (const l of codeLines) {
      out.push(`${COLORS.brightBlack}${l}${RESET}`);
    }
    codeLines = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const fenceMatch = raw.match(CODE_FENCE_RE);

    if (fenceMatch && !inCodeBlock) {
      // Opening fence
      flushCode();
      // Flush any accumulated regular lines first is handled above
      inCodeBlock = true;
      codeLang = fenceMatch[1] || '';
      continue;
    }

    if (fenceMatch && inCodeBlock) {
      // Closing fence
      flushCode();
      inCodeBlock = false;
      codeLang = '';
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(raw);
      continue;
    }

    // Code fences might contain ``` with trailing text that isn't a fence
    // Handle ``` that appears mid-line (unusual, but possible)
    if (raw.startsWith('```') && !fenceMatch) {
      // This is caught by the regex above, but just in case:
      codeLines.push(raw);
      continue;
    }

    const rendered = renderLine(raw, { enabled, colors });
    out.push(rendered);
  }

  // If file ends inside a code block, still flush it
  flushCode();

  return out.join('\n');
}

module.exports = {
  renderInline,
  renderLine,
  renderBlock,
};

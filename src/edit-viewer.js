// Edit Viewer — generates a self-contained HTML page showing all edits
// from the current session as colored diffs, then opens it in the browser.
//
// Uses diff2html (CDN) for rendering and highlight.js for syntax coloring.
// No server needed — it's a single HTML file in /tmp.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { getEdits } = require('./edit-tracker');

// ── Minimal unified-diff generator ──────────────────────────────────────

function unifiedDiff(oldStr, newStr, filePath) {
  const oldLines = (oldStr || '').split('\n');
  const newLines = (newStr || '').split('\n');

  // Simple LCS-based diff — good enough for moderate file sizes
  const lcs = lcsMatrix(oldLines, newLines);
  const hunks = buildHunks(oldLines, newLines, lcs);

  const header = [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
  ];

  if (hunks.length === 0) return null; // identical

  const lines = [...header];
  for (const h of hunks) lines.push(...h);
  return lines.join('\n');
}

function lcsMatrix(a, b) {
  const m = a.length, n = b.length;
  // For very large files, skip the matrix and produce a simple "replace all" diff
  if (m * n > 2_000_000) return null;
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

function buildHunks(oldLines, newLines, dp) {
  const ops = [];

  if (!dp) {
    // Fallback for huge files — treat as full replacement
    for (let i = 0; i < oldLines.length; i++) ops.push({ type: '-', line: oldLines[i], oldIdx: i });
    for (let j = 0; j < newLines.length; j++) ops.push({ type: '+', line: newLines[j], newIdx: j });
  } else {
    let i = 0, j = 0;
    while (i < oldLines.length || j < newLines.length) {
      if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
        ops.push({ type: ' ', line: oldLines[i], oldIdx: i, newIdx: j });
        i++; j++;
      } else if (j < newLines.length && (i >= oldLines.length || dp[i][j + 1] >= dp[i + 1][j])) {
        ops.push({ type: '+', line: newLines[j], newIdx: j });
        j++;
      } else {
        ops.push({ type: '-', line: oldLines[i], oldIdx: i });
        i++;
      }
    }
  }

  // Group into hunks with 3 lines of context
  const CTX = 3;
  const hunks = [];
  let hunk = null;
  let lastChange = -999;

  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    if (op.type !== ' ') {
      if (k - lastChange > CTX * 2 + 1 && hunk) {
        // Close old hunk, start new one
        // Add trailing context from before
        for (let c = lastChange + 1; c < Math.min(lastChange + 1 + CTX, k) && c < ops.length; c++) {
          if (ops[c].type === ' ') hunk.push(` ${ops[c].line}`);
        }
        hunks.push(finishHunk(hunk));
        hunk = null;
      }
      if (!hunk) {
        hunk = [];
        // Leading context
        for (let c = Math.max(0, k - CTX); c < k; c++) {
          if (ops[c].type === ' ') hunk.push(` ${ops[c].line}`);
        }
      } else {
        // Fill gap context between changes in same hunk
        for (let c = lastChange + 1; c < k; c++) {
          if (ops[c].type === ' ') hunk.push(` ${ops[c].line}`);
        }
      }
      hunk.push(`${op.type}${op.line}`);
      lastChange = k;
    }
  }

  if (hunk) {
    // Trailing context
    for (let c = lastChange + 1; c < Math.min(lastChange + 1 + CTX, ops.length); c++) {
      if (ops[c].type === ' ') hunk.push(` ${ops[c].line}`);
    }
    hunks.push(finishHunk(hunk));
  }

  return hunks;
}

function finishHunk(lines) {
  let oldStart = 1, oldCount = 0, newStart = 1, newCount = 0;
  let firstOld = true, firstNew = true;
  for (const l of lines) {
    const ch = l[0];
    if (ch === ' ') {
      if (firstOld) { firstOld = false; }
      if (firstNew) { firstNew = false; }
      oldCount++; newCount++;
    } else if (ch === '-') {
      oldCount++;
    } else if (ch === '+') {
      newCount++;
    }
  }
  return [`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...lines];
}

// ── HTML generation ─────────────────────────────────────────────────────

function generateHTML(edits) {
  const diffs = edits.map((e, idx) => {
    const diff = e.oldContent === null
      ? newFileDiff(e.newContent, e.filePath)
      : unifiedDiff(e.oldContent, e.newContent, e.filePath);
    return {
      idx,
      filePath: e.filePath,
      tool: e.tool,
      timestamp: new Date(e.timestamp).toLocaleTimeString(),
      diff: diff || '(no changes)',
      isNew: e.oldContent === null,
      linesAdded: (diff || '').split('\n').filter(l => l.startsWith('+')).length - 1,
      linesRemoved: (diff || '').split('\n').filter(l => l.startsWith('-')).length - 1,
    };
  });

  const diffJSON = JSON.stringify(diffs.map(d => ({
    idx: d.idx,
    filePath: d.filePath,
    tool: d.tool,
    timestamp: d.timestamp,
    diff: d.diff,
    isNew: d.isNew,
    linesAdded: d.linesAdded,
    linesRemoved: d.linesRemoved,
  })));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>shmakk · edit review · ${diffs.length} file${diffs.length !== 1 ? 's' : ''}</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/diff2html/3.4.48/bundles/css/diff2html.min.css">
<style>
  :root {
    --bg: #0d1117; --fg: #e6edf3; --border: #30363d;
    --sidebar-bg: #161b22; --active: #1f6feb; --hover: #1c2128;
    --green: #3fb950; --red: #f85149; --dim: #8b949e;
    --badge-new: #238636; --badge-edit: #1f6feb;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
         background: var(--bg); color: var(--fg); display: flex; height: 100vh; overflow: hidden; }

  /* Sidebar */
  .sidebar { width: 280px; min-width: 280px; background: var(--sidebar-bg);
             border-right: 1px solid var(--border); display: flex; flex-direction: column; }
  .sidebar-header { padding: 16px 16px 12px; border-bottom: 1px solid var(--border); }
  .sidebar-header h1 { font-size: 14px; font-weight: 600; color: var(--dim); text-transform: uppercase;
                        letter-spacing: 0.5px; }
  .sidebar-header .count { font-size: 22px; font-weight: 700; margin-top: 4px; }
  .file-list { flex: 1; overflow-y: auto; padding: 8px; }
  .file-item { padding: 10px 12px; border-radius: 6px; cursor: pointer; margin-bottom: 2px;
               display: flex; align-items: center; gap: 10px; transition: background 0.1s; }
  .file-item:hover { background: var(--hover); }
  .file-item.active { background: var(--active); }
  .file-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .file-dot.seen { background: var(--dim); opacity: 0.4; }
  .file-dot.unseen { background: var(--active); }
  .file-name { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
  .file-badge { font-size: 10px; padding: 2px 6px; border-radius: 10px; font-weight: 600; flex-shrink: 0; }
  .file-badge.new { background: var(--badge-new); color: #fff; }
  .file-badge.edit { background: var(--badge-edit); color: #fff; }

  /* Main */
  .main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }

  /* Top bar */
  .topbar { padding: 12px 20px; border-bottom: 1px solid var(--border);
            display: flex; align-items: center; justify-content: space-between; }
  .topbar-left { display: flex; align-items: center; gap: 12px; }
  .topbar-path { font-size: 15px; font-weight: 600; font-family: 'SF Mono', 'Fira Code', monospace; }
  .topbar-meta { font-size: 12px; color: var(--dim); }
  .topbar-stats { display: flex; gap: 12px; font-size: 13px; }
  .stat-add { color: var(--green); }
  .stat-del { color: var(--red); }

  /* Nav */
  .nav { padding: 10px 20px; border-bottom: 1px solid var(--border);
         display: flex; align-items: center; gap: 12px; }
  .nav-btn { background: var(--sidebar-bg); border: 1px solid var(--border); color: var(--fg);
             padding: 6px 16px; border-radius: 6px; cursor: pointer; font-size: 13px;
             transition: background 0.1s; }
  .nav-btn:hover { background: var(--hover); }
  .nav-btn:disabled { opacity: 0.3; cursor: default; }
  .nav-pos { font-size: 13px; color: var(--dim); min-width: 60px; text-align: center; }
  .nav-spacer { flex: 1; }
  .copy-btn { background: none; border: 1px solid var(--border); color: var(--dim);
              padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 12px;
              transition: all 0.15s; }
  .copy-btn:hover { color: var(--fg); border-color: var(--fg); }

  /* Diff area */
  .diff-area { flex: 1; overflow-y: auto; padding: 20px; }

  /* diff2html overrides for dark theme */
  .d2h-wrapper { background: transparent !important; }
  .d2h-file-header { background: var(--sidebar-bg) !important; border-color: var(--border) !important; }
  .d2h-file-wrapper { border-color: var(--border) !important; border-radius: 8px !important;
                      margin-bottom: 0 !important; }
  .d2h-code-line, .d2h-code-side-line { background: var(--bg) !important; color: var(--fg) !important; }
  .d2h-code-line-prefix { color: var(--dim) !important; }
  .d2h-del { background: rgba(248,81,73,0.15) !important; }
  .d2h-ins { background: rgba(63,185,80,0.15) !important; }
  .d2h-info { background: var(--sidebar-bg) !important; color: var(--dim) !important; }
  .d2h-code-linenumber { background: var(--sidebar-bg) !important; color: var(--dim) !important;
                         border-color: var(--border) !important; }
  .d2h-emptyplaceholder { background: var(--sidebar-bg) !important; }
  .d2h-tag { display: none !important; }
  .d2h-file-name { color: var(--fg) !important; }

  /* Keyboard hint */
  .kbd-hint { position: fixed; bottom: 12px; right: 16px; font-size: 11px; color: var(--dim);
              opacity: 0.6; pointer-events: none; }
  kbd { background: var(--sidebar-bg); border: 1px solid var(--border); border-radius: 3px;
        padding: 1px 5px; font-size: 10px; }
</style>
</head>
<body>

<div class="sidebar">
  <div class="sidebar-header">
    <h1>shmakk edit review</h1>
    <div class="count" id="fileCount"></div>
  </div>
  <div class="file-list" id="fileList"></div>
</div>

<div class="main">
  <div class="topbar">
    <div class="topbar-left">
      <span class="topbar-path" id="topPath"></span>
      <span class="topbar-meta" id="topMeta"></span>
    </div>
    <div class="topbar-stats">
      <span class="stat-add" id="topAdd"></span>
      <span class="stat-del" id="topDel"></span>
    </div>
  </div>
  <div class="nav">
    <button class="nav-btn" id="prevBtn" onclick="go(-1)">&larr; Prev</button>
    <span class="nav-pos" id="navPos"></span>
    <button class="nav-btn" id="nextBtn" onclick="go(1)">Next &rarr;</button>
    <span class="nav-spacer"></span>
    <button class="copy-btn" onclick="copyQuestion()">&#128203; Copy question for terminal</button>
  </div>
  <div class="diff-area" id="diffArea"></div>
</div>

<div class="kbd-hint"><kbd>&larr;</kbd> <kbd>&rarr;</kbd> navigate &middot; <kbd>c</kbd> copy question</div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/diff2html/3.4.48/bundles/js/diff2html-ui.min.js"></script>
<script>
const DIFFS = ${diffJSON};
let current = 0;
const seen = new Set();

function basename(p) { return p.split('/').pop(); }
function dirname(p) { const parts = p.split('/'); parts.pop(); return parts.join('/'); }

function renderSidebar() {
  document.getElementById('fileCount').textContent =
    DIFFS.length + ' file' + (DIFFS.length !== 1 ? 's' : '') + ' changed';
  const list = document.getElementById('fileList');
  list.innerHTML = DIFFS.map((d, i) => {
    const cls = i === current ? ' active' : '';
    const dot = seen.has(i) ? 'seen' : 'unseen';
    const badge = d.isNew ? '<span class="file-badge new">new</span>'
                          : '<span class="file-badge edit">edit</span>';
    return '<div class="file-item' + cls + '" onclick="go(' + (i - current) + ')" title="' + d.filePath + '">'
      + '<div class="file-dot ' + dot + '"></div>'
      + '<span class="file-name">' + basename(d.filePath) + '</span>'
      + badge + '</div>';
  }).join('');
}

function render() {
  const d = DIFFS[current];
  seen.add(current);

  // Sidebar
  renderSidebar();

  // Topbar
  document.getElementById('topPath').textContent = d.filePath;
  document.getElementById('topMeta').textContent = d.tool + ' · ' + d.timestamp;
  document.getElementById('topAdd').textContent = '+' + d.linesAdded;
  document.getElementById('topDel').textContent = '-' + d.linesRemoved;

  // Nav
  document.getElementById('navPos').textContent = (current + 1) + ' / ' + DIFFS.length;
  document.getElementById('prevBtn').disabled = current === 0;
  document.getElementById('nextBtn').disabled = current === DIFFS.length - 1;

  // Diff
  const area = document.getElementById('diffArea');
  area.innerHTML = '';
  try {
    const html = Diff2Html.html(d.diff, {
      drawFileList: false,
      matching: 'lines',
      outputFormat: 'side-by-side',
      colorScheme: 'dark',
    });
    area.innerHTML = html;
  } catch (_) {
    area.innerHTML = '<pre style="padding:20px;color:var(--dim)">' +
      d.diff.replace(/</g, '&lt;') + '</pre>';
  }
  area.scrollTop = 0;
}

function go(delta) {
  const next = current + delta;
  if (next >= 0 && next < DIFFS.length) { current = next; render(); }
}

function copyQuestion() {
  const d = DIFFS[current];
  const q = 'Explain the changes you made to ' + d.filePath;
  navigator.clipboard.writeText(q).then(() => {
    const btn = document.querySelector('.copy-btn');
    btn.textContent = '\\u2713 Copied!';
    setTimeout(() => { btn.innerHTML = '&#128203; Copy question for terminal'; }, 1500);
  });
}

document.addEventListener('keydown', e => {
  if (e.key === 'ArrowLeft') go(-1);
  if (e.key === 'ArrowRight') go(1);
  if (e.key === 'c' && !e.metaKey && !e.ctrlKey) copyQuestion();
});

render();
</script>
</body>
</html>`;
}

function newFileDiff(content, filePath) {
  const lines = content.split('\n');
  const header = [
    `--- /dev/null`,
    `+++ b/${filePath}`,
    `@@ -0,0 +1,${lines.length} @@`,
  ];
  return [...header, ...lines.map(l => `+${l}`)].join('\n');
}

// ── Public API ──────────────────────────────────────────────────────────

function openEditViewer(write) {
  const edits = getEdits();
  if (!edits.length) {
    write('[shmakk] no edits to review this session\r\n');
    return;
  }

  const html = generateHTML(edits);
  const tmpFile = path.join(os.tmpdir(), `shmakk-edits-${Date.now()}.html`);
  fs.writeFileSync(tmpFile, html, 'utf8');

  // Pick the right "open" command per platform
  const opener = process.platform === 'darwin' ? 'open'
               : process.platform === 'win32'  ? 'start'
               : 'xdg-open';

  execFile(opener, [tmpFile], { stdio: 'ignore' }, () => {});

  write(`[shmakk] edit review opened in browser (${edits.length} file${edits.length !== 1 ? 's' : ''})\r\n`);
  write(`[shmakk] ${tmpFile}\r\n`);
}

module.exports = { openEditViewer, generateHTML, unifiedDiff, newFileDiff };

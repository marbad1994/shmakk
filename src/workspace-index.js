const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage']);
const MAX_FILE_BYTES = 96 * 1024;

function safeRead(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

function extractHints(content) {
  const symbols = [];
  const imports = [];
  const lines = String(content || '').split(/\r?\n/).slice(0, 400);
  for (const l of lines) {
    const s = l.trim();
    let m = /^export\s+(?:async\s+)?function\s+([a-zA-Z0-9_]+)/.exec(s)
      || /^(?:async\s+)?function\s+([a-zA-Z0-9_]+)/.exec(s)
      || /^class\s+([a-zA-Z0-9_]+)/.exec(s)
      || /^const\s+([a-zA-Z0-9_]+)\s*=\s*\(/.exec(s);
    if (m) symbols.push(m[1]);
    m = /^import\s+.*?from\s+['"]([^'"]+)['"]/.exec(s)
      || /^const\s+.*?=\s*require\(['"]([^'"]+)['"]\)/.exec(s);
    if (m) imports.push(m[1]);
  }
  return { symbols: symbols.slice(0, 20), imports: imports.slice(0, 20) };
}

function walkFiles(root, dir = root, out = []) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(root, abs);
    if (!rel) continue;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walkFiles(root, abs, out);
      continue;
    }
    if (!e.isFile()) continue;
    out.push(rel);
  }
  return out;
}

function indexFilePath(root) {
  return path.join(root, '.aiterm', 'state', 'index.json');
}

function loadIndex(root) {
  const p = indexFilePath(root);
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function saveIndex(root, index) {
  const p = indexFilePath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(index), 'utf8');
}

function buildOrRefreshIndex(root) {
  const now = Date.now();
  const existing = loadIndex(root) || { root, files: {}, updatedAt: 0 };
  const seen = new Set(walkFiles(root));

  for (const rel of Object.keys(existing.files)) {
    if (!seen.has(rel)) delete existing.files[rel];
  }

  for (const rel of seen) {
    const abs = path.join(root, rel);
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    const prev = existing.files[rel];
    const mtimeMs = st.mtimeMs;
    const size = st.size;
    if (prev && prev.mtimeMs === mtimeMs && prev.size === size) continue;

    const sample = safeRead(abs).slice(0, MAX_FILE_BYTES);
    const hints = extractHints(sample);
    existing.files[rel] = {
      path: rel,
      mtimeMs,
      size,
      symbols: hints.symbols,
      imports: hints.imports,
    };
  }

  existing.updatedAt = now;
  saveIndex(root, existing);
  return existing;
}

function tokenize(s) {
  return String(s || '').toLowerCase().split(/[^a-z0-9_./-]+/).filter(Boolean);
}

function relevantFiles(index, query, limit = 20) {
  const q = tokenize(query);
  if (!q.length) return [];
  const scored = [];
  for (const f of Object.values(index.files || {})) {
    const hay = `${f.path} ${(f.symbols || []).join(' ')} ${(f.imports || []).join(' ')}`.toLowerCase();
    let score = 0;
    for (const t of q) {
      if (hay.includes(t)) score += 2;
      if (f.path.toLowerCase().includes(t)) score += 3;
    }
    if (score > 0) scored.push({ file: f.path, score });
  }
  scored.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  return scored.slice(0, limit).map((x) => x.file);
}

module.exports = { buildOrRefreshIndex, relevantFiles };

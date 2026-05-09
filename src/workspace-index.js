const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage']);
const MAX_FILE_BYTES = 96 * 1024;
const CODE_EXTS = new Set(['.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs']);

function safeRead(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

function firstNonEmptyLines(content, limit = 20) {
  return String(content || '')
    .split(/\r?\n/)
    .map((x) => x.trimEnd())
    .filter((x) => x.trim())
    .slice(0, limit);
}

function extractHints(content) {
  const symbols = [];
  const imports = [];
  const exports = [];
  const lines = String(content || '').split(/\r?\n/).slice(0, 400);
  for (const l of lines) {
    const s = l.trim();
    let m = /^export\s+(?:async\s+)?function\s+([a-zA-Z0-9_]+)/.exec(s)
      || /^(?:async\s+)?function\s+([a-zA-Z0-9_]+)/.exec(s)
      || /^class\s+([a-zA-Z0-9_]+)/.exec(s)
      || /^const\s+([a-zA-Z0-9_]+)\s*=\s*\(/.exec(s);
    if (m) symbols.push(m[1]);
    m = /^module\.exports\s*=\s*([a-zA-Z0-9_]+)/.exec(s)
      || /^export\s+default\s+([a-zA-Z0-9_]+)/.exec(s)
      || /^export\s*\{\s*([^}]+)\s*\}/.exec(s);
    if (m) exports.push(m[1]);
    m = /^import\s+.*?from\s+['"]([^'"]+)['"]/.exec(s)
      || /^const\s+.*?=\s*require\(['"]([^'"]+)['"]\)/.exec(s);
    if (m) imports.push(m[1]);
  }
  return {
    symbols: symbols.slice(0, 20),
    imports: imports.slice(0, 20),
    exports: exports.slice(0, 20),
  };
}

function detectRole(rel) {
  const base = path.basename(rel).toLowerCase();
  const dir = path.dirname(rel).toLowerCase();
  if (base === 'package.json' || /tsconfig|vite\.config|next\.config|dockerfile|readme/.test(base)) return 'config';
  if (dir.includes('test') || base.includes('.test.') || base.includes('.spec.')) return 'test';
  if (base === 'index.js' || base === 'main.js' || rel.startsWith('bin/')) return 'entry';
  if (dir.includes('hooks')) return 'hook';
  if (dir.includes('services')) return 'service';
  if (dir.includes('src')) return 'source';
  return 'file';
}

function resolveImportTarget(rel, imp, allFiles) {
  if (!imp || !imp.startsWith('.')) return null;
  const baseDir = path.dirname(rel);
  const raw = path.normalize(path.join(baseDir, imp));
  const candidates = [
    raw,
    `${raw}.js`, `${raw}.cjs`, `${raw}.mjs`, `${raw}.ts`, `${raw}.tsx`, `${raw}.jsx`,
    path.join(raw, 'index.js'), path.join(raw, 'index.ts'), path.join(raw, 'index.tsx'),
  ];
  for (const c of candidates) {
    if (allFiles.has(c)) return c;
  }
  return null;
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
      ext: path.extname(rel).toLowerCase(),
      role: detectRole(rel),
      symbols: hints.symbols,
      imports: hints.imports,
      exports: hints.exports,
      snippet: firstNonEmptyLines(sample, 12),
      edges: [],
    };
  }

  const allFiles = new Set(Object.keys(existing.files));
  for (const rel of Object.keys(existing.files)) {
    const f = existing.files[rel];
    const edges = [];
    for (const imp of f.imports || []) {
      const target = resolveImportTarget(rel, imp, allFiles);
      if (target) edges.push(target);
    }
    f.edges = edges.slice(0, 30);
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

function relevantSubgraph(index, query, limit = 12, maxHops = 1) {
  const seeds = relevantFiles(index, query, Math.max(4, Math.min(limit, 8)));
  const files = index.files || {};
  const visited = new Set(seeds);
  const queue = seeds.map((file) => ({ file, hop: 0 }));
  const out = [];

  while (queue.length && out.length < limit) {
    const { file, hop } = queue.shift();
    const node = files[file];
    if (!node) continue;
    out.push({
      path: node.path,
      role: node.role,
      symbols: node.symbols || [],
      imports: node.imports || [],
      exports: node.exports || [],
      snippet: node.snippet || [],
      edges: node.edges || [],
    });
    if (hop >= maxHops) continue;
    for (const next of node.edges || []) {
      if (visited.has(next)) continue;
      visited.add(next);
      queue.push({ file: next, hop: hop + 1 });
    }
  }

  return out;
}

module.exports = { buildOrRefreshIndex, relevantFiles, relevantSubgraph };

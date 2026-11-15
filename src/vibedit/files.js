// Source file walking and search/replace edit block application.
// Ported from vibedit for shmakk integration.

const fs = require('fs');
const path = require('path');

const SOURCE_EXT = new Set([
  ".html", ".htm", ".js", ".jsx", ".ts", ".tsx", ".vue", ".svelte", ".astro",
  ".css", ".scss", ".sass", ".less", ".mjs", ".cjs"
]);
const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".nuxt", ".output",
    ".shmakk", "coverage", ".cache", ".svelte-kit", "out", "vendor"
]);
const MAX_FILE_BYTES = 400_000;
const MAX_SHORTLIST = 5;
const MAX_TOTAL_CHARS = 16_000;

function walkSources(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".env") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!IGNORE_DIRS.has(e.name)) stack.push(full);
      } else if (SOURCE_EXT.has(path.extname(e.name))) {
        try { if (fs.statSync(full).size <= MAX_FILE_BYTES) out.push(full); } catch {}
      }
    }
  }
  return out;
}

function extractNeedles(changes) {
  const needles = new Set();
  for (const ch of changes) {
    if (ch.kind === "css") {
      if (ch.selector) needles.add(ch.selector.replace(/^\./, ""));
      for (const m of (ch.before || "").matchAll(/([\w-]+)\s*:/g)) if (m[1].length >= 4) needles.add(m[1]);
      continue;
    }
    for (const html of [ch.before, ch.after]) {
      if (!html) continue;
      const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      for (const frag of text.split(/[.!?\n]/)) {
        const f = frag.trim();
        if (f.length >= 6 && f.length <= 80) needles.add(f);
      }
      for (const m of html.matchAll(/class="([^"]+)"/g)) {
        for (const cls of m[1].split(/\s+/)) if (cls.length >= 4) needles.add(cls);
      }
      for (const m of html.matchAll(/id="([^"]+)"/g)) if (m[1].length >= 3) needles.add(m[1]);
    }
    if (ch.selector) {
      for (const part of ch.selector.split(/[\s>.#:\[\]]+/)) {
        if (part.length >= 4 && !/^(div|span|nth|of|type)$/.test(part)) needles.add(part);
      }
    }
  }
  return [...needles].slice(0, 60);
}

function shortlistFiles(projectDir, changes) {
  const needles = extractNeedles(changes);
  if (needles.length === 0) return [];
  const files = walkSources(projectDir);
  const scored = [];
  for (const file of files) {
    let content;
    try { content = fs.readFileSync(file, "utf8"); } catch { continue; }
    let score = 0;
    const hitLines = new Set();
    for (const n of needles) {
      let idx = content.indexOf(n);
      while (idx !== -1) {
        score += Math.min(n.length, 30);
        hitLines.add(content.slice(0, idx).split("\n").length);
        idx = content.indexOf(n, idx + n.length);
        if (score > 5000) break;
      }
    }
    if (score > 0) scored.push({ file, score, content, hitLines: [...hitLines] });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, MAX_SHORTLIST);
  let budget = MAX_TOTAL_CHARS;
  const result = [];
  for (const s of top) {
    let snippet = s.content;
    if (snippet.length > budget) {
      snippet = windowsAroundLines(s.content, s.hitLines, Math.max(budget, 2000));
    }
    snippet = snippet.slice(0, budget);
    budget -= snippet.length;
    result.push({ path: path.relative(projectDir, s.file), content: snippet, truncated: snippet.length < s.content.length });
    if (budget < 1500) break;
  }
  return result;
}

function windowsAroundLines(content, lines, charBudget) {
  const all = content.split("\n");
  const keep = new Set();
  for (const ln of lines) {
    for (let i = Math.max(0, ln - 16); i < Math.min(all.length, ln + 16); i++) keep.add(i);
  }
  const parts = [];
  let chunk = [];
  let prev = -2;
  const sorted = [...keep].sort((a, b) => a - b);
  for (const i of sorted) {
    if (i !== prev + 1 && chunk.length) { parts.push(chunk.join("\n")); chunk = []; }
    chunk.push(all[i]);
    prev = i;
  }
  if (chunk.length) parts.push(chunk.join("\n"));
  return parts.join("\n...\n").slice(0, charBudget);
}

const BLOCK_RE = /FILE:\s*(.+?)\s*\n<{5,}\s*SEARCH\s*\n([\s\S]*?)\n={5,}\s*\n([\s\S]*?)\n>{5,}\s*REPLACE/g;

function applyEditBlocks(projectDir, stateDir, modelOutput) {
  const applied = [];
  const failed = [];
  const backupDir = path.join(stateDir, "backups", String(Date.now()));
  let m;
  while ((m = BLOCK_RE.exec(modelOutput)) !== null) {
    const relPath = m[1].trim().replace(/^["'`]|["'`]$/g, "");
    const search = m[2];
    const replace = m[3];
    const full = path.join(projectDir, relPath);
    if (!full.startsWith(projectDir)) { failed.push(`${relPath} (outside project)`); continue; }
    let content;
    try { content = fs.readFileSync(full, "utf8"); } catch { failed.push(`${relPath} (not readable)`); continue; }
    let next = exactReplace(content, search, replace) ?? fuzzyReplace(content, search, replace);
    if (next === null) { failed.push(`${relPath} (search text not found)`); continue; }
    fs.mkdirSync(path.join(backupDir, path.dirname(relPath)), { recursive: true });
    fs.writeFileSync(path.join(backupDir, relPath), content);
    fs.writeFileSync(full, next);
    applied.push(relPath);
  }
  return { applied, failed };
}

function exactReplace(content, search, replace) {
  const idx = content.indexOf(search);
  if (idx === -1) return null;
  return content.slice(0, idx) + replace + content.slice(idx + search.length);
}

function fuzzyReplace(content, search, replace) {
  const cLines = content.split("\n");
  const sLines = search.split("\n").map((l) => l.trim()).filter((l, i, a) => !(l === "" && (i === 0 || i === a.length - 1)));
  if (sLines.length === 0) return null;
  outer: for (let i = 0; i <= cLines.length - sLines.length; i++) {
    for (let j = 0; j < sLines.length; j++) {
      if (cLines[i + j].trim() !== sLines[j]) continue outer;
    }
    const before = cLines.slice(0, i).join("\n");
    const after = cLines.slice(i + sLines.length).join("\n");
    return [before, replace, after].filter((s, k) => s !== "" || k === 1).join("\n");
  }
  return null;
}

module.exports = { walkSources, extractNeedles, shortlistFiles, applyEditBlocks };

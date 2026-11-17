// Intake: the middle layer between "what the person asked for" and "what
// shmakk should do".
//
// Requests arrive from two places:
//   • Show & tell: a finding from a narrated screen recording (what was said,
//     where on screen, which frames show it);
//   • Edit in browser: an element picked in the live preview of the running
//     app, with whatever the inspector could tell about it (selector, DOM
//     excerpt, the React/Vue/Svelte component and its source file) and what
//     the person wants changed.
//
// Neither is a task yet. "Show the last login date here" is a frontend change
// on the surface, but it may need a column, a migration and an API field
// first. Intake grounds each request in the actual workspace (stack, layout,
// exact-text search hits, the component's source) and has the model turn it
// into ordered, layered tasks: database → backend → frontend, each with
// concrete instructions, acceptance criteria and the files likely involved.
//
// When no model is configured or it fails, a deterministic fallback produces
// one task per request with a keyword-based layer guess, so nothing is lost.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const LAYERS = ['database', 'backend', 'frontend', 'infra', 'tests', 'unknown'];
const KINDS = ['bug', 'change', 'feature', 'chore'];
const PRIORITIES = ['high', 'normal', 'low'];
const LAYER_ORDER = { database: 0, backend: 1, infra: 2, frontend: 3, tests: 4, unknown: 5 };

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.svelte-kit', 'coverage', '.cache', '.turbo', 'vendor', 'target', '__pycache__', '.venv', 'venv', '.shmakk', 'out', '.output']);
const TEXT_EXT = /\.(js|jsx|ts|tsx|mjs|cjs|vue|svelte|astro|html|css|scss|less|py|rb|go|rs|php|java|kt|cs|sql|prisma|graphql|gql|json|ya?ml|md)$/i;

// ── stack detection ─────────────────────────────────────────────────────────

const DEP_SIGNALS = [
  ['react', 'frontend', 'React'], ['next', 'frontend', 'Next.js'], ['vue', 'frontend', 'Vue'], ['nuxt', 'frontend', 'Nuxt'],
  ['svelte', 'frontend', 'Svelte'], ['@sveltejs/kit', 'frontend', 'SvelteKit'], ['@angular/core', 'frontend', 'Angular'],
  ['solid-js', 'frontend', 'Solid'], ['astro', 'frontend', 'Astro'], ['vite', 'frontend', 'Vite'], ['tailwindcss', 'frontend', 'Tailwind'],
  ['express', 'backend', 'Express'], ['fastify', 'backend', 'Fastify'], ['koa', 'backend', 'Koa'], ['hono', 'backend', 'Hono'],
  ['@nestjs/core', 'backend', 'NestJS'], ['@trpc/server', 'backend', 'tRPC'], ['graphql', 'backend', 'GraphQL'],
  ['prisma', 'database', 'Prisma'], ['@prisma/client', 'database', 'Prisma'], ['drizzle-orm', 'database', 'Drizzle'],
  ['typeorm', 'database', 'TypeORM'], ['sequelize', 'database', 'Sequelize'], ['mongoose', 'database', 'Mongoose'],
  ['knex', 'database', 'Knex'], ['pg', 'database', 'PostgreSQL'], ['mysql2', 'database', 'MySQL'],
  ['better-sqlite3', 'database', 'SQLite'], ['sqlite3', 'database', 'SQLite'], ['redis', 'database', 'Redis'], ['ioredis', 'database', 'Redis'],
  ['@supabase/supabase-js', 'database', 'Supabase'], ['firebase', 'database', 'Firebase'],
];

function readJsonSafe(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

/** Package roots: the workspace and the usual monorepo / split-repo folders. */
function packageRoots(root) {
  const out = [];
  const consider = (dir) => { if (fs.existsSync(path.join(dir, 'package.json'))) out.push(dir); };
  consider(root);
  for (const sub of ['web', 'frontend', 'client', 'app', 'ui', 'server', 'backend', 'api']) consider(path.join(root, sub));
  for (const group of ['apps', 'packages', 'services']) {
    let names = [];
    try { names = fs.readdirSync(path.join(root, group)); } catch {}
    for (const n of names.slice(0, 20)) consider(path.join(root, group, n));
  }
  return out;
}

/**
 * What the workspace is built with, per layer, plus where the database and
 * API code most likely live. Pure filesystem reads.
 */
function detectStack(root) {
  const stack = { frontend: new Set(), backend: new Set(), database: new Set(), packages: [], languages: new Set(), dbFiles: [], apiDirs: [] };
  for (const dir of packageRoots(root)) {
    const pkg = readJsonSafe(path.join(dir, 'package.json')) || {};
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const tags = [];
    for (const [dep, layer, label] of DEP_SIGNALS) if (deps[dep]) { stack[layer].add(label); tags.push(label); }
    stack.languages.add(deps.typescript ? 'TypeScript' : 'JavaScript');
    stack.packages.push({ dir: path.relative(root, dir) || '.', name: pkg.name || null, uses: [...new Set(tags)], scripts: Object.keys(pkg.scripts || {}).slice(0, 12) });
  }
  const exists = (rel) => fs.existsSync(path.join(root, rel));
  if (exists('requirements.txt') || exists('pyproject.toml')) {
    stack.languages.add('Python');
    const req = `${safeRead(path.join(root, 'requirements.txt'))}\n${safeRead(path.join(root, 'pyproject.toml'))}`.toLowerCase();
    if (/django/.test(req)) stack.backend.add('Django');
    if (/flask/.test(req)) stack.backend.add('Flask');
    if (/fastapi/.test(req)) stack.backend.add('FastAPI');
    if (/sqlalchemy/.test(req)) stack.database.add('SQLAlchemy');
  }
  if (exists('go.mod')) stack.languages.add('Go');
  if (exists('Cargo.toml')) stack.languages.add('Rust');
  if (exists('Gemfile')) { stack.languages.add('Ruby'); if (/rails/.test(safeRead(path.join(root, 'Gemfile')))) stack.backend.add('Rails'); }

  // Database and API locations, found by name (shallow, bounded walk).
  walk(root, 4, (rel, isDir) => {
    const base = path.basename(rel);
    if (isDir) {
      if (/^(migrations?|migrate|db|database|schema|models|entities|prisma|drizzle|seeds?)$/i.test(base) && stack.dbFiles.length < 12) stack.dbFiles.push(`${rel}/`);
      if (/^(api|routes|controllers|handlers|endpoints|resolvers|server|trpc)$/i.test(base) && stack.apiDirs.length < 12) stack.apiDirs.push(`${rel}/`);
    } else if (/\.(sql|prisma)$|^schema\.(ts|js|rb|py)$|^models?\.py$/i.test(base) && stack.dbFiles.length < 12) {
      stack.dbFiles.push(rel);
    }
  });

  return {
    frontend: [...stack.frontend], backend: [...stack.backend], database: [...stack.database],
    languages: [...stack.languages], packages: stack.packages, dbFiles: stack.dbFiles, apiDirs: stack.apiDirs,
  };
}

function safeRead(p, max = 256 * 1024) {
  try { const b = fs.readFileSync(p); return b.slice(0, max).toString('utf8'); } catch { return ''; }
}

/** Bounded directory walk. visit(relPath, isDir). Stops after `limit` entries. */
function walk(root, maxDepth, visit, limit = 4000) {
  let seen = 0;
  const go = (dir, depth) => {
    if (depth > maxDepth || seen > limit) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (seen++ > limit) return;
      if (SKIP.has(e.name) || (e.name.startsWith('.') && e.name !== '.github')) continue;
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (e.isDirectory()) { visit(rel, true); go(abs, depth + 1); } else if (e.isFile()) visit(rel, false);
    }
  };
  go(root, 1);
}

/** A compact tree outline (directories with file counts, key files listed). */
function outline(root, { maxDepth = 3, maxLines = 120 } = {}) {
  const dirs = new Map();
  walk(root, maxDepth, (rel, isDir) => {
    const parent = path.posix.dirname(rel);
    if (isDir) { if (!dirs.has(rel)) dirs.set(rel, { files: [] }); return; }
    if (!dirs.has(parent)) dirs.set(parent, { files: [] });
    dirs.get(parent).files.push(path.posix.basename(rel));
  });
  const lines = [];
  for (const [dir, info] of [...dirs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (lines.length >= maxLines) { lines.push('…'); break; }
    const depth = dir === '.' ? 0 : dir.split('/').length;
    const shown = info.files.slice(0, 8).join(', ');
    const more = info.files.length > 8 ? ` (+${info.files.length - 8})` : '';
    lines.push(`${'  '.repeat(Math.max(0, depth - 1))}${dir === '.' ? '.' : path.posix.basename(dir)}/  ${shown}${more}`);
  }
  return lines.join('\n');
}

// ── grounding: exact-text search and source snippets ────────────────────────

function hasRipgrep() {
  if (hasRipgrep.cached !== undefined) return hasRipgrep.cached;
  try { execFileSync('rg', ['--version'], { stdio: 'ignore', timeout: 2000 }); hasRipgrep.cached = true; } catch { hasRipgrep.cached = false; }
  return hasRipgrep.cached;
}

/**
 * Search terms worth grepping for: visible text, ids, test ids, distinctive
 * class names and component names. Short or generic strings are dropped.
 */
function searchTerms(request) {
  const out = new Set();
  const w = (request && request.where) || {};
  const add = (s, min = 4) => {
    const t = String(s || '').trim().replace(/\s+/g, ' ');
    if (t.length >= min && t.length <= 80 && !/^(div|span|button|true|false|null|undefined|click|submit|save|cancel|ok)$/i.test(t)) out.add(t);
  };
  if (w.text) {
    const first = w.text.split(/(?<=[.!?])\s|\n/)[0].slice(0, 60);
    add(first, 4);
    // Rendered text often interpolates values ("Hello, Ada"), so the full
    // string never appears in source; the leading words usually do.
    const words = first.replace(/[^\p{L}\p{N}\s'’-]/gu, ' ').trim().split(/\s+/);
    if (words.length > 4) add(words.slice(0, 4).join(' '), 10);
  }
  const attrs = w.attrs || {};
  add(attrs.id, 3);
  add(attrs['data-testid'], 3);
  add(attrs['aria-label'], 4);
  add(attrs.placeholder, 4);
  add(attrs.name, 4);
  for (const c of String(attrs.class || '').split(/\s+/)) if (c.length >= 6 && !/^(flex|grid|block|hidden|items-|justify-|text-|bg-|p[xytrbl]?-|m[xytrbl]?-|w-|h-|gap-|rounded|border|shadow|font-)/.test(c) && !/[0-9a-f]{6,}/i.test(c)) add(c, 6);
  if (w.component && w.component.name && !/^(Anonymous|_c\d*)$/.test(w.component.name)) add(w.component.name, 3);
  return [...out].slice(0, 6);
}

function grep(root, term, { maxHits = 6 } = {}) {
  const hits = [];
  if (hasRipgrep()) {
    try {
      const outText = execFileSync('rg', ['-n', '-F', '--no-heading', '--max-count', '3', '--max-columns', '220', '-g', '!node_modules', '-g', '!dist', '-g', '!build', '-g', '!*.min.*', '-g', '!*.lock', '-g', '!package-lock.json', '-g', '!.shmakk', '--', term, '.'], { cwd: root, encoding: 'utf8', timeout: 4000, maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
      for (const line of outText.split('\n')) {
        const m = /^\.?\/?(.+?):(\d+):(.*)$/.exec(line);
        if (m) hits.push({ term, file: m[1], line: Number(m[2]), text: m[3].trim().slice(0, 200) });
        if (hits.length >= maxHits) break;
      }
    } catch {}
    return hits;
  }
  walk(root, 6, (rel, isDir) => {
    if (isDir || hits.length >= maxHits || !TEXT_EXT.test(rel)) return;
    const text = safeRead(path.join(root, rel), 200 * 1024);
    const idx = text.indexOf(term);
    if (idx === -1) return;
    const line = text.slice(0, idx).split('\n').length;
    hits.push({ term, file: rel, line, text: text.split('\n')[line - 1].trim().slice(0, 200) });
  });
  return hits;
}

/**
 * Map a path reported by the browser (a dev-server URL path such as
 * "/src/App.tsx", or an absolute fileName from _debugSource) to a file in the
 * workspace. Returns a workspace-relative path or null.
 */
function resolveSourceFile(root, reported) {
  if (!reported) return null;
  let p = String(reported).replace(/[?#].*$/, '').replace(/\\/g, '/');
  try { if (/^https?:/.test(p)) p = new URL(p).pathname; } catch {}
  p = decodeURIComponent(p);
  const absRoot = path.resolve(root);
  if (path.isAbsolute(p) && p.startsWith(absRoot + '/') && fs.existsSync(p)) return path.relative(absRoot, p).split(path.sep).join('/');
  const rel = p.replace(/^\/+/, '');
  if (rel && fs.existsSync(path.join(absRoot, rel))) return rel;
  // The dev server may be rooted in a subfolder (web/, apps/site/): find a
  // file whose path ends with the reported one.
  const tail = rel.split('/').slice(-3).join('/');
  let found = null;
  if (tail) walk(absRoot, 7, (r, isDir) => { if (!found && !isDir && (r === rel || r.endsWith(`/${rel}`) || r.endsWith(`/${tail}`))) found = r; });
  return found;
}

function snippet(root, rel, line, radius = 14) {
  const text = safeRead(path.join(root, rel), 512 * 1024);
  if (!text) return null;
  const lines = text.split('\n');
  const at = Math.max(1, Math.min(lines.length, Number(line) || 1));
  const from = Math.max(1, at - radius);
  const to = Math.min(lines.length, at + radius);
  return { file: rel, from, to, line: at, code: lines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(4)}  ${l}`).join('\n') };
}

/** Everything the model needs to place a request in this codebase. */
function groundRequest(root, request) {
  const g = { source: null, hits: [] };
  const comp = request && request.where && request.where.component;
  const seen = new Set();
  for (const term of searchTerms(request)) {
    for (const h of grep(root, term)) {
      const k = `${h.file}:${h.line}`;
      if (seen.has(k)) continue;
      seen.add(k);
      g.hits.push(h);
    }
    if (g.hits.length >= 12) break;
  }
  // The component's file. Lines from a dev server's stack trace refer to the
  // transformed module, so an exact-text hit in the same file wins.
  if (comp && comp.file) {
    const rel = resolveSourceFile(root, comp.file);
    if (rel) {
      const hit = g.hits.find((h) => h.file === rel);
      g.source = snippet(root, rel, hit ? hit.line : (comp.approx ? 1 : comp.line) || 1);
      if (hit || comp.approx) g.source.approximate = !hit;
    }
  }
  // Code first: a match in a component beats the same words in a README.
  const isDoc = (f) => /\.(md|mdx|txt|rst)$|(^|\/)(docs?|skills|research)\//i.test(f);
  g.hits.sort((a, b) => Number(isDoc(a.file)) - Number(isDoc(b.file)));
  return g;
}

// ── request normalisation ───────────────────────────────────────────────────

function str(v, max = 2000) { return v == null ? '' : String(v).trim().slice(0, max); }

/** Coerce a request from either surface into one shape. */
function normalizeRequest(r, i) {
  if (!r || typeof r !== 'object') return null;
  const where = r.where && typeof r.where === 'object' ? r.where : {};
  const out = {
    id: str(r.id, 60) || `r${i + 1}`,
    text: str(r.text || r.note || r.description, 4000),
    quote: str(r.quote, 1000) || null,
    kind: KINDS.includes(r.kind) ? r.kind : null,
    tweaks: r.tweaks && typeof r.tweaks === 'object' ? r.tweaks : null,
    frames: Array.isArray(r.frames) ? r.frames.map((f) => str(f, 120)).filter(Boolean).slice(0, 6) : [],
    where: {
      page: str(where.page, 300) || null,
      url: str(where.url, 500) || null,
      element: str(where.element, 300) || null,
      selector: str(where.selector, 400) || null,
      text: str(where.text, 300) || null,
      html: str(where.html, 2000) || null,
      attrs: where.attrs && typeof where.attrs === 'object' ? where.attrs : {},
      landmarks: Array.isArray(where.landmarks) ? where.landmarks.slice(0, 4).map((x) => str(x, 80)) : [],
      component: where.component && typeof where.component === 'object' ? {
        framework: str(where.component.framework, 20) || null,
        name: str(where.component.name, 80) || null,
        chain: Array.isArray(where.component.chain) ? where.component.chain.slice(0, 6).map((x) => str(x, 60)) : [],
        file: str(where.component.file, 400) || null,
        line: Number.isFinite(Number(where.component.line)) ? Number(where.component.line) : null,
        approx: !!where.component.approx,
      } : null,
    },
  };
  if (!out.text && !out.tweaks && !out.quote) return null;
  return out;
}

// ── heuristics (fallback, and a hint for the model) ─────────────────────────

const LAYER_CUES = {
  database: /\b(database|db|table|column|migration|migrate|schema|sql|index(?:es)?|persist(?:ed|ence)?|store[sd]? (?:it|this|the)|save[sd]? to the|record[s]? in|foreign key|seed)\b/i,
  backend: /\b(api|endpoint|server|backend|route|request|response|auth(?:entication|orization)?|permission|validat(?:e|ion)|webhook|queue|job|cron|email|notification|rate limit|session|token|payload|graphql|resolver|controller)\b/i,
  infra: /\b(deploy|docker|ci|pipeline|env(?:ironment)? var|nginx|caddy|kubernetes|k8s|terraform|build step|github action)\b/i,
  tests: /\b(test|spec|e2e|coverage|playwright|vitest|jest)\b/i,
  frontend: /\b(button|colou?r|font|layout|page|modal|dialog|css|style|text|label|icon|align|spacing|padding|margin|responsive|mobile|ui|ux|hover|click|form|input|dropdown|menu|sidebar|header|footer|tooltip|animation|dark mode|theme|show|display|hide|visible)\b/i,
};

function guessLayer(text, hasElement) {
  const t = String(text || '');
  for (const layer of ['database', 'backend', 'infra', 'tests']) if (LAYER_CUES[layer].test(t)) return layer;
  if (LAYER_CUES.frontend.test(t) || hasElement) return 'frontend';
  return 'unknown';
}

function guessKind(text) {
  const t = String(text || '');
  if (/\b(bug|broken|crash(?:es)?|error|fails?|wrong|doesn'?t work|does not work|not working|should not|shouldn'?t|missing|glitch|overlap|cut off|404|500)\b/i.test(t)) return 'bug';
  if (/\b(add|new|introduce|support|allow|enable|create|build)\b/i.test(t)) return 'feature';
  if (/\b(clean ?up|refactor|rename|upgrade|bump|remove unused)\b/i.test(t)) return 'chore';
  return 'change';
}

function shortTitle(text, max = 72) {
  const t = String(text || '').replace(/\s+/g, ' ').trim().replace(/^(please|can you|could you|i want to|we need to|i'?d like to)\s+/i, '');
  const first = t.split(/(?<=[.!?])\s/)[0];
  const s = first.length > max ? `${first.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : first;
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Untitled change';
}

function tweaksText(tweaks) {
  if (!tweaks) return '';
  const parts = [];
  if (typeof tweaks.text === 'string') parts.push(`change the text to "${tweaks.text}"`);
  for (const [k, v] of Object.entries(tweaks.styles || {})) parts.push(`${k}: ${v}`);
  return parts.length ? `Visual tweak previewed in the browser: ${parts.join('; ')}.` : '';
}

function whereText(w) {
  if (!w) return '';
  const bits = [];
  if (w.page || w.url) bits.push(`on ${w.page || w.url}`);
  if (w.element) bits.push(`at ${w.element}`);
  else if (w.selector) bits.push(`element \`${w.selector}\``);
  if (w.component && w.component.name) bits.push(`(component ${w.component.name}${w.component.file ? ` in ${w.component.file}${w.component.line ? `:${w.component.line}` : ''}` : ''})`);
  return bits.join(' ');
}

/** One task per request, no model involved. */
function fallbackTasks(requests, grounding = []) {
  return requests.map((r, i) => {
    const g = grounding[i] || {};
    const files = [];
    if (g.source) files.push({ path: g.source.file, why: 'component that renders the element' });
    for (const h of g.hits || []) if (files.length < 4 && !files.some((f) => f.path === h.file)) files.push({ path: h.file, why: `contains "${h.term}"` });
    const body = [r.text, tweaksText(r.tweaks)].filter(Boolean).join('\n\n');
    const where = whereText(r.where);
    return {
      key: `t${i + 1}`,
      title: shortTitle(r.text || tweaksText(r.tweaks)),
      kind: r.kind || guessKind(body),
      layer: guessLayer(body, !!(r.where && (r.where.selector || r.where.element))),
      priority: 'normal',
      instructions: [where ? `Where: ${where}.` : null, body, r.quote && r.quote !== r.text ? `In the person's words: "${r.quote}"` : null].filter(Boolean).join('\n\n'),
      acceptance: [r.text ? `The change described is visible and working: ${shortTitle(r.text, 120)}` : 'The previewed tweak is implemented in source, not inline'],
      files,
      dependsOn: [],
      questions: [],
      requestIds: [r.id],
    };
  });
}

// ── model translation ───────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the intake layer of shmakk, an AI coding agent. People describe changes to a running web app by pointing at it: either by picking an element in a live preview, or by narrating a screen recording. Your job is to turn each request into the concrete engineering tasks shmakk's coding agent will execute, one at a time, in a real codebase.

Decide where each change actually lives. A request made while looking at the UI is often not only a UI change:
- "show the user's last login here" needs the value stored (database), exposed (backend API) and rendered (frontend);
- "this should not let me submit an empty email" may be a frontend validation, a backend validation, or both;
- "make this button bigger" is frontend only.
Split a request into one task per layer when it spans layers, and order them so each task's prerequisites come first (database, then backend, then frontend). Merge requests that are clearly the same change.

Every task must stand on its own for an agent that did not see the recording or the browser:
- "instructions": imperative, specific steps in Markdown. Name the files and symbols to change when the context shows them. Say what to change and how, not just what is wrong. Include the exact text, values or behaviour asked for.
- "acceptance": 1-5 checkable statements a reviewer can verify from the diff and by running the app.
- "files": the files most likely to change, ONLY paths that appear in the provided context (source snippet, search hits, tree). Never invent paths.
- If something essential is ambiguous, add it to "questions" instead of guessing.

Respond with ONLY one JSON object, no markdown fences:
{
  "tasks": [
    {
      "key": "t1",
      "title": "short imperative title, under 70 characters",
      "kind": "bug | change | feature | chore",
      "layer": "database | backend | frontend | infra | tests",
      "priority": "high | normal | low",
      "instructions": "markdown",
      "acceptance": ["..."],
      "files": [{ "path": "relative/path", "why": "short reason" }],
      "dependsOn": ["t0"],
      "requestIds": ["r1"],
      "questions": []
    }
  ],
  "summary": "one sentence describing the whole batch"
}`;

function contextBlock(root, stack, tree) {
  const lines = [`WORKSPACE ${path.basename(path.resolve(root))}`];
  const layer = (name, arr) => { if (arr && arr.length) lines.push(`${name}: ${arr.join(', ')}`); };
  layer('Frontend', stack.frontend);
  layer('Backend', stack.backend);
  layer('Database', stack.database);
  layer('Languages', stack.languages);
  if (stack.packages.length > 1) lines.push(`Packages: ${stack.packages.map((p) => `${p.dir}${p.uses.length ? ` (${p.uses.join(', ')})` : ''}`).join('; ')}`);
  if (stack.dbFiles.length) lines.push(`Database code: ${stack.dbFiles.join(', ')}`);
  if (stack.apiDirs.length) lines.push(`API code: ${stack.apiDirs.join(', ')}`);
  lines.push('', 'TREE', tree);
  return lines.join('\n');
}

function requestBlock(r, g, i) {
  const lines = [`REQUEST ${r.id}`];
  if (r.text) lines.push(`Asked for: ${r.text}`);
  if (r.quote && r.quote !== r.text) lines.push(`Their words: "${r.quote}"`);
  const t = tweaksText(r.tweaks);
  if (t) lines.push(t);
  const w = r.where;
  if (w.page || w.url) lines.push(`Page: ${[w.page, w.url].filter(Boolean).join(' · ')}`);
  if (w.element) lines.push(`Element: ${w.element}`);
  if (w.selector) lines.push(`Selector: ${w.selector}`);
  if (w.landmarks && w.landmarks.length) lines.push(`Inside: ${w.landmarks.join(' > ')}`);
  if (w.text) lines.push(`Element text: "${w.text}"`);
  if (w.component) lines.push(`Component: ${[w.component.name, w.component.chain && w.component.chain.length ? `(${w.component.chain.join(' < ')})` : null, w.component.file ? `reported file ${w.component.file}${w.component.line ? `:${w.component.line}` : ''}` : null].filter(Boolean).join(' ')}`);
  if (w.html) lines.push(`DOM excerpt:\n${w.html}`);
  if (g.source) lines.push(`Source (${g.source.file}, lines ${g.source.from}-${g.source.to}${g.source.approximate ? ', position approximate' : ''}):\n${g.source.code}`);
  if (g.hits.length) lines.push(`Search hits:\n${g.hits.map((h) => `  ${h.file}:${h.line}  [${h.term}]  ${h.text}`).join('\n')}`);
  lines.push(`Layer hint (keyword heuristic, may be wrong): ${guessLayer(`${r.text} ${r.quote || ''}`, !!(w.selector || w.element))}`);
  return lines.join('\n');
}

/** Validate and normalise the model's tasks. Unknown file paths are dropped. */
function normalizeTasks(raw, { requests = [], knownFiles = null } = {}) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw && raw.tasks) ? raw.tasks : [];
  const keys = new Set();
  const tasks = [];
  list.forEach((t, i) => {
    if (!t || typeof t !== 'object') return;
    const title = str(t.title, 120);
    const instructions = str(t.instructions || t.description, 8000);
    if (!title && !instructions) return;
    let key = str(t.key, 20) || `t${i + 1}`;
    while (keys.has(key)) key = `${key}_`;
    keys.add(key);
    const files = (Array.isArray(t.files) ? t.files : [])
      .map((f) => (typeof f === 'string' ? { path: f } : f))
      .filter((f) => f && f.path)
      .map((f) => ({ path: str(f.path, 300).replace(/^\.?\//, ''), why: str(f.why, 200) || null }))
      .filter((f) => !knownFiles || knownFiles(f.path))
      .slice(0, 8);
    tasks.push({
      key,
      title: title || shortTitle(instructions),
      kind: KINDS.includes(t.kind) ? t.kind : guessKind(`${title} ${instructions}`),
      layer: LAYERS.includes(t.layer) ? t.layer : guessLayer(`${title} ${instructions}`, false),
      priority: PRIORITIES.includes(t.priority) ? t.priority : 'normal',
      instructions: instructions || title,
      acceptance: (Array.isArray(t.acceptance) ? t.acceptance : []).map((a) => str(a, 400)).filter(Boolean).slice(0, 8),
      files,
      dependsOn: (Array.isArray(t.dependsOn) ? t.dependsOn : []).map((d) => str(d, 20)).filter(Boolean),
      questions: (Array.isArray(t.questions) ? t.questions : []).map((q) => str(q, 400)).filter(Boolean).slice(0, 5),
      requestIds: (Array.isArray(t.requestIds) ? t.requestIds : []).map((x) => str(x, 60)).filter((x) => !requests.length || requests.some((r) => r.id === x)),
    });
  });
  // Only keep dependencies on tasks that exist, never on themselves.
  for (const t of tasks) t.dependsOn = [...new Set(t.dependsOn)].filter((d) => d !== t.key && keys.has(d));
  return orderTasks(tasks);
}

/**
 * Stable topological order: dependencies first, then by layer (database →
 * backend → frontend) among tasks that are otherwise free.
 */
function orderTasks(tasks) {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const out = [];
  const state = new Map();
  const rank = (t) => LAYER_ORDER[t.layer] ?? 9;
  const visit = (t) => {
    if (state.get(t.key) === 2) return;
    if (state.get(t.key) === 1) return; // cycle: keep current order
    state.set(t.key, 1);
    for (const d of [...t.dependsOn].map((k) => byKey.get(k)).filter(Boolean).sort((a, b) => rank(a) - rank(b))) visit(d);
    state.set(t.key, 2);
    out.push(t);
  };
  const roots = tasks.map((t, i) => ({ t, i })).sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i).map((x) => x.t);
  for (const t of roots) visit(t);
  return out;
}

/**
 * Turn requests into tasks.
 * @param {object} opts
 * @param {string} opts.root workspace root
 * @param {Array} opts.requests raw requests (see normalizeRequest)
 * @param {string} [opts.source] 'browser' | 'show2plan' | ...
 * @param {string} [opts.context] extra free text (recording summary, page)
 * @param {object} [opts.client] injectable { client, model } for tests
 * @returns {Promise<{tasks, summary, requests, stack, via, error}>}
 */
async function translate(opts = {}) {
  const root = path.resolve(opts.root || process.cwd());
  const requests = (Array.isArray(opts.requests) ? opts.requests : []).map(normalizeRequest).filter(Boolean).slice(0, 30);
  if (!requests.length) throw new Error('nothing to translate: add at least one request');
  const stack = detectStack(root);
  const grounding = requests.map((r) => groundRequest(root, r));

  let llm = null;
  try { llm = require('../llm'); } catch {}
  const c = opts.client || (llm && llm.isConfigured() ? llm.makeClientForModel(opts.model) : null);
  if (!c) {
    return { tasks: fallbackTasks(requests, grounding), summary: '', requests, stack, via: 'fallback', error: 'no AI provider configured' };
  }

  const tree = outline(root);
  const user = [
    contextBlock(root, stack, tree),
    opts.context ? `\nCONTEXT FROM THE PERSON\n${str(opts.context, 4000)}` : '',
    `\nSOURCE ${opts.source || 'browser'}`,
    ...requests.map((r, i) => `\n${requestBlock(r, grounding[i], i)}`),
  ].join('\n');

  const params = {
    model: c.model,
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: user }],
    temperature: 0.1,
    max_tokens: 6000,
    stream: false,
  };
  if (/deepseek/i.test(String(c.model))) params.thinking = { type: 'disabled' };

  const known = (rel) => fs.existsSync(path.join(root, rel)) || grounding.some((g) => (g.source && g.source.file === rel) || g.hits.some((h) => h.file === rel));
  try {
    const resp = await c.client.chat.completions.create(params, { signal: opts.signal });
    const raw = String(resp && resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content || '');
    const { extractJson } = require('./vision');
    const parsed = extractJson(raw);
    const tasks = normalizeTasks(parsed, { requests, knownFiles: known });
    if (!tasks.length) throw new Error('the model returned no tasks');
    return { tasks, summary: str(parsed && parsed.summary, 400), requests, stack, via: 'model', error: null };
  } catch (e) {
    if (opts.signal && opts.signal.aborted) throw e;
    return { tasks: fallbackTasks(requests, grounding), summary: '', requests, stack, via: 'fallback', error: String(e.message || e) };
  }
}

module.exports = {
  LAYERS,
  KINDS,
  detectStack,
  outline,
  searchTerms,
  grep,
  resolveSourceFile,
  snippet,
  groundRequest,
  normalizeRequest,
  guessLayer,
  guessKind,
  shortTitle,
  fallbackTasks,
  normalizeTasks,
  orderTasks,
  translate,
  SYSTEM_PROMPT,
};

// Read-only repository tools for analysis agents.
//
// Show & tell's investigator needs to look around the codebase before it
// writes tasks: list folders, find files, search text, read files. These
// tools can only read, are confined to the workspace (no `..`, no symlink
// escapes, no .git internals), and cap what they return so a tool loop stays
// within a model's context. Every path the agent touches is recorded, so the
// files it names in its tasks can be checked against what it actually saw.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.svelte-kit', 'coverage', '.cache', '.turbo', 'vendor', 'target', '__pycache__', '.venv', 'venv', '.shmakk', 'out', '.output']);
const MAX_READ_LINES = 400;
const MAX_LIST = 300;
const MAX_HITS = 60;

const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List a directory of the repository (folders first). Use "." for the root.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_files',
      description: 'Find files whose path contains all the given words (case-insensitive), e.g. "sidebar tsx" or "routes history".',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search',
      description: 'Search file contents for text or a regular expression. Returns path:line: text. Optionally limit to a folder or a glob like "*.tsx".',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          regex: { type: 'boolean', description: 'treat pattern as a regular expression (default: plain text)' },
          path: { type: 'string', description: 'folder to search in (default: whole repo)' },
          glob: { type: 'string' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: `Read a file, optionally a line range (at most ${MAX_READ_LINES} lines per call). Lines are numbered.`,
      parameters: { type: 'object', properties: { path: { type: 'string' }, start: { type: 'integer' }, end: { type: 'integer' } }, required: ['path'] },
    },
  },
];

function createRepoTools(rootDir) {
  const root = fs.realpathSync(path.resolve(rootDir));
  const seen = new Set(); // workspace-relative files the agent saw (read, listed or hit)
  const read = new Set(); // files it opened
  const rel = (abs) => path.relative(root, abs).split(path.sep).join('/') || '.';

  function resolve(p) {
    const raw = String(p || '.').replace(/^\/+/, '');
    const abs = path.resolve(root, raw);
    let real;
    try { real = fs.realpathSync(abs); } catch { throw new Error(`not found: ${raw}`); }
    if (real !== root && !real.startsWith(root + path.sep)) throw new Error('outside the repository');
    if (real.split(path.sep).includes('.git')) throw new Error('.git is not readable');
    return real;
  }

  function walk(dir, visit, limit = 20000) {
    let n = 0;
    const go = (d) => {
      let entries = [];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (n++ > limit) return;
        if (SKIP.has(e.name)) continue;
        const abs = path.join(d, e.name);
        if (e.isDirectory()) go(abs); else if (e.isFile()) visit(abs);
      }
    };
    go(dir);
  }

  const tools = {
    list_dir({ path: p }) {
      const abs = resolve(p);
      const st = fs.statSync(abs);
      if (!st.isDirectory()) throw new Error('not a directory');
      const entries = fs.readdirSync(abs, { withFileTypes: true })
        .filter((e) => !SKIP.has(e.name))
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
        .slice(0, MAX_LIST);
      for (const e of entries) if (e.isFile()) seen.add(rel(path.join(abs, e.name)));
      return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join('\n') || '(empty)';
    },

    find_files({ query }) {
      const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
      if (!words.length) throw new Error('query is empty');
      const out = [];
      walk(root, (abs) => {
        if (out.length >= MAX_HITS) return;
        const r = rel(abs);
        const lower = r.toLowerCase();
        if (words.every((w) => lower.includes(w))) out.push(r);
      });
      for (const r of out) seen.add(r);
      return out.join('\n') || '(no files match)';
    },

    search({ pattern, regex = false, path: p, glob }) {
      if (!pattern) throw new Error('pattern is empty');
      const dir = resolve(p || '.');
      const hits = [];
      try {
        const args = ['-n', '--no-heading', '--max-columns', '200', '--max-count', '5', '-g', '!node_modules', '-g', '!dist', '-g', '!build', '-g', '!*.min.*', '-g', '!*.lock', '-g', '!package-lock.json', '-g', '!.shmakk'];
        if (!regex) args.push('-F');
        if (glob) args.push('-g', String(glob));
        args.push('--', String(pattern), dir);
        const out = execFileSync('rg', args, { encoding: 'utf8', timeout: 8000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
        for (const line of out.split('\n')) {
          const m = /^(.+?):(\d+):(.*)$/.exec(line);
          if (!m) continue;
          hits.push(`${rel(m[1])}:${m[2]}: ${m[3].trim()}`);
          seen.add(rel(m[1]));
          if (hits.length >= MAX_HITS) break;
        }
      } catch (e) {
        if (e && e.status === 1) return '(no matches)';
        if (e && e.code !== 'ENOENT') { if (e.status === 2) throw new Error('invalid pattern'); }
        // No ripgrep: plain scan.
        let re = null;
        if (regex) { try { re = new RegExp(pattern); } catch { throw new Error('invalid pattern'); } }
        const g = glob ? new RegExp(`${String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`) : null;
        walk(dir, (abs) => {
          if (hits.length >= MAX_HITS || (g && !g.test(abs))) return;
          let text;
          try { const st = fs.statSync(abs); if (st.size > 512 * 1024) return; text = fs.readFileSync(abs, 'utf8'); } catch { return; }
          if (text.includes('\u0000')) return;
          text.split('\n').forEach((l, i) => {
            if (hits.length < MAX_HITS && (re ? re.test(l) : l.includes(pattern))) { hits.push(`${rel(abs)}:${i + 1}: ${l.trim().slice(0, 200)}`); seen.add(rel(abs)); }
          });
        });
      }
      return hits.join('\n') || '(no matches)';
    },

    read_file({ path: p, start, end }) {
      const abs = resolve(p);
      const st = fs.statSync(abs);
      if (st.isDirectory()) throw new Error('is a directory; use list_dir');
      if (st.size > 2 * 1024 * 1024) throw new Error('file too large');
      const text = fs.readFileSync(abs, 'utf8');
      if (text.includes('\u0000')) throw new Error('binary file');
      const lines = text.split('\n');
      const from = Math.max(1, Number(start) || 1);
      const to = Math.min(lines.length, Number(end) || from + MAX_READ_LINES - 1, from + MAX_READ_LINES - 1);
      const r = rel(abs);
      seen.add(r);
      read.add(r);
      const body = lines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(5)}  ${l}`).join('\n');
      return `${r} (lines ${from}-${to} of ${lines.length})\n${body}`;
    },
  };

  /** Run one tool call; errors come back as text so the agent can correct itself. */
  function call(name, args) {
    const fn = tools[name];
    if (!fn) return `error: unknown tool ${name}`;
    try { return String(fn(args || {})); } catch (e) { return `error: ${e.message}`; }
  }

  return { call, defs: TOOL_DEFS, seen, read, root };
}

module.exports = { createRepoTools, TOOL_DEFS, MAX_READ_LINES };

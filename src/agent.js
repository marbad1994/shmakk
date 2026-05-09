// Minimal task/chat handler. Streams chat replies; for tasks, runs a small
// tool-call loop with read_file / write_file / list_dir / run constrained to
// the workspace root.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { makeClient, modelFor, isConfigured } = require('./llm');
const { classifyRunCommand, isSecretPath } = require('./safety');
const { buildOrRefreshIndex, relevantSubgraph } = require('./workspace-index');
const { readActiveSkill } = require('./skills');

const MAX_FILE_BYTES = 64 * 1024;
const MAX_FETCH_BYTES = 128 * 1024;
const MAX_TOOL_ITERS = Math.max(1, Number(process.env.AITERM_MAX_TOOL_ITERS) || 16);
const CONTEXT_PROFILES = {
  tiny: { historyEntries: 10, maxToolIters: Math.min(MAX_TOOL_ITERS, 10), stallRepeat: 2, maxDiscoveryCallsPerRound: 1 },
  balanced: { historyEntries: 20, maxToolIters: MAX_TOOL_ITERS, stallRepeat: 3, maxDiscoveryCallsPerRound: 2 },
  deep: { historyEntries: 40, maxToolIters: Math.max(MAX_TOOL_ITERS, 24), stallRepeat: 4, maxDiscoveryCallsPerRound: 3 },
  builder: { historyEntries: 50, maxToolIters: Math.max(MAX_TOOL_ITERS, 32), stallRepeat: 5, maxDiscoveryCallsPerRound: 4 },
  'large-app': { historyEntries: 50, maxToolIters: Math.max(MAX_TOOL_ITERS, 32), stallRepeat: 5, maxDiscoveryCallsPerRound: 4 },
};

function contextProfile(mode) {
  const key = String(mode || 'balanced').toLowerCase();
  return CONTEXT_PROFILES[key] || CONTEXT_PROFILES.balanced;
}

function trimForContext(history, maxEntries) {
  if (!Array.isArray(history) || history.length <= maxEntries) return history || [];
  let cut = history.length - maxEntries;
  while (cut > 0 && history[cut] && history[cut].role === 'tool') cut--;
  return history.slice(cut);
}

function journalPath(root) {
  return path.join(root, '.aiterm', 'state', 'task-journal.json');
}

function loadTaskJournal(root) {
  try {
    const p = journalPath(root);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function saveTaskJournal(root, journal) {
  try {
    const p = journalPath(root);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(journal, null, 2));
  } catch {}
}

function clearTaskJournal(root) {
  try { fs.rmSync(journalPath(root), { force: true }); } catch {}
}

function normalizeToolCalls(rawToolCalls, iter) {
  const calls = [];
  let seq = 0;
  for (const tc of rawToolCalls || []) {
    if (!tc || tc.type !== 'function') continue;
    const name = String(tc.function?.name || '').trim();
    if (!name) continue;
    const id = String(tc.id || '').trim() || `tc_${iter}_${seq++}`;
    const argsRaw = typeof tc.function?.arguments === 'string' ? tc.function.arguments : '';
    calls.push({
      id,
      type: 'function',
      function: {
        name,
        arguments: argsRaw || '{}',
      },
    });
  }
  return calls;
}

function applyRoundToolBudget(toolCalls, maxDiscoveryCalls) {
  const discovery = new Set(['read_file', 'list_dir', 'web_search', 'fetch_url']);
  const actionCalls = [];
  const discoveryCalls = [];
  for (const c of toolCalls) {
    if (discovery.has(c.function?.name)) discoveryCalls.push(c);
    else actionCalls.push(c);
  }
  // Progress-first bias: execute action calls first, then only a small discovery budget.
  return [...actionCalls, ...discoveryCalls.slice(0, maxDiscoveryCalls)];
}

// Tiny spinner so the user sees "the agent is thinking" while we wait on
// the model. Erased when stop() is called.
function startSpinner(write, label = 'thinking') {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0; let line = '';
  const draw = () => {
    line = `\x1b[2m${frames[i % frames.length]} ${label}…\x1b[0m`;
    write('\r' + line);
    i++;
  };
  draw();
  const tm = setInterval(draw, 100);
  return () => {
    clearInterval(tm);
    write('\r' + ' '.repeat(line.replace(/\x1b\[[0-9;]*m/g, '').length + 2) + '\r\r');
  };
}

function dim(s) { return `\x1b[2m${s}\x1b[0m`; }

// Resolve a path against a list of allowed roots. Returns the absolute
// path if it lies inside any root, or null otherwise. The first root in
// the list is used as the base for relative resolution.
function within(roots, p) {
  if (!roots || !roots.length) return null;
  const base = path.resolve(roots[0]);
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(base, p);
  for (const r of roots) {
    const rr = path.resolve(r);
    if (abs === rr || abs.startsWith(rr + path.sep)) return abs;
  }
  return null;
}

const TOOLS = [
  { type: 'function', function: {
    name: 'read_file',
    description: 'Read a UTF-8 file inside the workspace. Supports compact partial reads.',
    parameters: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string' },
        mode: { type: 'string', enum: ['full', 'head', 'tail', 'grep', 'imports', 'exports', 'symbol'] },
        max_lines: { type: 'number', minimum: 1, maximum: 400 },
        query: { type: 'string' },
      },
    },
  }},
  { type: 'function', function: {
    name: 'write_file',
    description: 'Write or overwrite a UTF-8 file inside the workspace.',
    parameters: { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } } },
  }},
  { type: 'function', function: {
    name: 'edit_file',
    description: 'Edit an existing UTF-8 file inside the workspace by replacing a specific string with a new string.',
    parameters: {
      type: 'object',
      required: ['path', 'old_string', 'new_string'],
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
      },
    },
  }},
  { type: 'function', function: {
    name: 'make_dir',
    description: 'Create a directory inside the workspace, including parents.',
    parameters: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
  }},
  { type: 'function', function: {
    name: 'list_dir',
    description: 'List entries in a directory inside the workspace.',
    parameters: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
  }},
  { type: 'function', function: {
    name: 'run',
    description: 'Run a non-interactive shell command inside the workspace. Output is captured.',
    parameters: { type: 'object', required: ['cmd'], properties: { cmd: { type: 'string' } } },
  }},
  { type: 'function', function: {
    name: 'web_search',
    description: 'Search the web for current information. Returns titles, URLs, and snippets.',
    parameters: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        max_results: { type: 'number', minimum: 1, maximum: 10 },
      },
    },
  }},
  { type: 'function', function: {
    name: 'fetch_url',
    description: 'Fetch text from an http(s) URL for source checking. Output is size-limited.',
    parameters: { type: 'object', required: ['url'], properties: { url: { type: 'string' } } },
  }},
  { type: 'function', function: {
    name: 'delete_file',
    description: 'Delete a file inside the workspace. Always requires user confirmation.',
    parameters: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
  }},
];

// Tool safety classification.
// 'safe'      → auto mode runs it without asking; review mode asks with [Y/n]
// 'unsafe'    → both modes ask, defaulting to No  ([y/N])
// 'uncertain' → both modes ask, defaulting to No  ([y/N])
function classifyTool(name, args) {
  if (name === 'read_file' || name === 'list_dir') {
    if (args.path && isSecretPath(args.path)) return 'unsafe';
    return 'safe';
  }
  if (name === 'write_file') {
    if (args.path && isSecretPath(args.path)) return 'unsafe';
    return 'uncertain';
  }
  if (name === 'make_dir') {
    if (args.path && isSecretPath(args.path)) return 'unsafe';
    return 'safe';
  }
  if (name === 'delete_file') return 'unsafe'; // user wants delete to always prompt
  if (name === 'run') return classifyRunCommand(args.cmd || '');
  if (name === 'web_search' || name === 'fetch_url') return 'safe';
  return 'uncertain';
}

function describeTool(name, args) {
  if (name === 'read_file') return `read_file ${args.path}${args.mode ? ` [${args.mode}]` : ''}`;
  if (name === 'list_dir') return `list_dir ${args.path || '.'}`;
  if (name === 'write_file') return `write_file ${args.path} (${(args.content || '').length} bytes)`;
  if (name === 'edit_file') return `edit_file ${args.path} (${(args.old_string || '').slice(0, 40)}…)`;
  if (name === 'make_dir') return `make_dir ${args.path}`;
  if (name === 'delete_file') return `delete_file ${args.path}`;
  if (name === 'run') return `run: ${args.cmd}`;
  if (name === 'web_search') return `web_search ${args.query}`;
  if (name === 'fetch_url') return `fetch_url ${args.url}`;
  return `${name} ${JSON.stringify(args).slice(0, 80)}`;
}

function runCmd(cwd, cmd, signal) {
  return new Promise((resolve) => {
    let removeAbortListener = null;
    const child = execFile('/bin/sh', ['-c', cmd], { cwd, timeout: 15000, maxBuffer: 64 * 1024 },
      (err, stdout, stderr) => {
        if (removeAbortListener) removeAbortListener();
        resolve({
          exitCode: err ? (err.code || 1) : 0,
          stdout: (stdout || '').toString().slice(-32000),
          stderr: (stderr || '').toString().slice(-32000),
          aborted: signal && signal.aborted ? true : undefined,
        });
      });
    if (signal) {
      const onAbort = () => { try { child.kill('SIGINT'); } catch {} setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 500); };
      if (signal.aborted) onAbort();
      else {
        signal.addEventListener('abort', onAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener('abort', onAbort);
      }
    }
  });
}

async function dispatchTool(name, args, roots, confirmTool, signal) {
  if (signal && signal.aborted) return { error: 'aborted' };
  const safety = classifyTool(name, args);
  if (confirmTool) {
    const ok = await confirmTool({ name, args, safety, description: describeTool(name, args) });
    if (!ok) return { error: 'user declined' };
  }
  if (signal && signal.aborted) return { error: 'aborted' };
  if (name === 'read_file') {
    const p = within(roots, args.path);
    if (!p) return { error: 'path outside workspace' };
    try {
      const buf = fs.readFileSync(p);
      const text = buf.slice(0, MAX_FILE_BYTES).toString('utf8');
      const lines = text.split(/\r?\n/);
      const mode = args.mode || 'full';
      const maxLines = Math.max(1, Math.min(400, Number(args.max_lines) || 80));
      if (mode === 'head') {
        return { content: lines.slice(0, maxLines).join('\n'), mode, truncated: lines.length > maxLines };
      }
      if (mode === 'tail') {
        return { content: lines.slice(-maxLines).join('\n'), mode, truncated: lines.length > maxLines };
      }
      if (mode === 'grep') {
        const q = String(args.query || '').toLowerCase();
        if (!q) return { error: 'query required for grep mode' };
        const hits = [];
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i].toLowerCase().includes(q)) continue;
          const start = Math.max(0, i - 2);
          const end = Math.min(lines.length, i + 3);
          hits.push(lines.slice(start, end).join('\n'));
          if (hits.length >= 5) break;
        }
        return { content: hits.join('\n---\n'), mode, truncated: hits.length >= 5 };
      }
      if (mode === 'imports') {
        const out = lines.filter((line) => /\bimport\b|require\(/.test(line)).slice(0, maxLines).join('\n');
        return { content: out, mode, truncated: out.split(/\r?\n/).length >= maxLines };
      }
      if (mode === 'exports') {
        const out = lines.filter((line) => /\bexport\b|module\.exports/.test(line)).slice(0, maxLines).join('\n');
        return { content: out, mode, truncated: out.split(/\r?\n/).length >= maxLines };
      }
      if (mode === 'symbol') {
        const q = String(args.query || '').toLowerCase();
        if (!q) return { error: 'query required for symbol mode' };
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i].toLowerCase().includes(q)) continue;
          const start = Math.max(0, i - 8);
          const end = Math.min(lines.length, i + Math.max(12, maxLines));
          return { content: lines.slice(start, end).join('\n'), mode, truncated: end < lines.length };
        }
        return { error: `symbol/query not found: ${args.query}` };
      }
      return { content: text, mode: 'full', truncated: buf.length > MAX_FILE_BYTES };
    } catch (e) { return { error: String(e.message) }; }
  }
  if (name === 'list_dir') {
    const p = within(roots, args.path || '.');
    if (!p) return { error: 'path outside workspace' };
    try {
      const ents = fs.readdirSync(p, { withFileTypes: true })
        .map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }));
      return { entries: ents };
    } catch (e) { return { error: String(e.message) }; }
  }
  if (name === 'write_file') {
    const p = within(roots, args.path);
    if (!p) return { error: 'path outside workspace' };
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, args.content ?? '');
    return { ok: true };
  }
  if (name === 'edit_file') {
    const p = within(roots, args.path);
    if (!p) return { error: 'path outside workspace' };
    try {
      const content = fs.readFileSync(p, 'utf8');
      const oldString = String(args.old_string ?? '');
      const newString = String(args.new_string ?? '');
      if (!oldString) return { error: 'old_string is required' };
      const first = content.indexOf(oldString);
      if (first === -1) return { error: 'old_string not found' };
      const second = content.indexOf(oldString, first + oldString.length);
      if (second !== -1) return { error: 'old_string is ambiguous; appears multiple times' };
      const updated = content.slice(0, first) + newString + content.slice(first + oldString.length);
      fs.writeFileSync(p, updated);
      return { ok: true, replaced: 1 };
    } catch (e) { return { error: String(e.message) }; }
  }
  if (name === 'make_dir') {
    const p = within(roots, args.path);
    if (!p) return { error: 'path outside workspace' };
    fs.mkdirSync(p, { recursive: true });
    return { ok: true };
  }
  if (name === 'delete_file') {
    const p = within(roots, args.path);
    if (!p) return { error: 'path outside workspace' };
    try { fs.rmSync(p, { force: true }); return { ok: true }; }
    catch (e) { return { error: String(e.message) }; }
  }
  if (name === 'run') {
    // run from the first root as cwd
    return await runCmd(roots[0], args.cmd, signal);
  }
  if (name === 'web_search') {
    return await webSearch(args.query, args.max_results, signal);
  }
  if (name === 'fetch_url') {
    return await fetchUrl(args.url, signal);
  }
  return { error: `unknown tool: ${name}` };
}

function htmlDecode(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function stripTags(s) {
  return htmlDecode(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeDdgUrl(href) {
  const decoded = htmlDecode(href);
  try {
    const u = new URL(decoded, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    return uddg ? decodeURIComponent(uddg) : u.href;
  } catch {
    return decoded;
  }
}

function parseDdgLite(html, maxResults = 5) {
  const results = [];
  const seen = new Set();

  // Primary: old/current lite table result rows
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let row;
  while ((row = rowRe.exec(html)) && results.length < maxResults) {
    const block = row[1];
    const link = /<a[^>]+(?:class="result-link"|rel="nofollow")[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!link) continue;
    const url = decodeDdgUrl(link[1]);
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    const snippetMatch = /<td[^>]+class="result-snippet"[^>]*>([\s\S]*?)<\/td>/i.exec(block);
    const title = stripTags(link[2]);
    if (!title) continue;
    seen.add(url);
    results.push({
      title,
      url,
      snippet: snippetMatch ? stripTags(snippetMatch[1]) : '',
    });
  }

  // Fallback: generic anchor extraction for changed DDG markup
  if (results.length < maxResults) {
    const anchorRe = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let a;
    while ((a = anchorRe.exec(html)) && results.length < maxResults) {
      const url = decodeDdgUrl(a[1]);
      if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
      if (/duckduckgo\.com\/(?:lite|html|\?|$)/i.test(url)) continue;
      const title = stripTags(a[2]);
      if (!title || title.length < 3) continue;
      seen.add(url);
      results.push({ title, url, snippet: '' });
    }
  }

  return results;
}

function fetchWithTimeout(url, opts = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  let removeUpstreamAbortListener = null;
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort(opts.signal.reason);
    else {
      const onAbort = () => ctrl.abort(opts.signal.reason);
      opts.signal.addEventListener('abort', onAbort, { once: true });
      removeUpstreamAbortListener = () => opts.signal.removeEventListener('abort', onAbort);
    }
  }
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => {
    clearTimeout(timer);
    if (removeUpstreamAbortListener) removeUpstreamAbortListener();
  });
}

async function webSearch(query, maxResults, signal) {
  const q = String(query || '').trim();
  if (!q) return { error: 'query required' };
  const limit = Math.max(1, Math.min(10, Number(maxResults) || 5));
  const liteUrl = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`;
  const htmlUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
  const headers = { 'user-agent': 'Mozilla/5.0 (compatible; aiterm/0.1; +https://duckduckgo.com)' };

  async function searchOne(url) {
    const resp = await fetchWithTimeout(url, { signal, headers });
    const html = await resp.text();
    if (!resp.ok) return { error: `search failed: HTTP ${resp.status}`, results: [] };
    return { results: parseDdgLite(html, limit) };
  }

  try {
    const lite = await searchOne(liteUrl);
    if (lite.results.length) return { query: q, results: lite.results, source: 'ddg-lite' };

    const html = await searchOne(htmlUrl);
    if (html.results.length) return { query: q, results: html.results, source: 'ddg-html-fallback' };

    return { query: q, results: [], source: 'ddg-lite+html', note: lite.error || html.error || 'no results parsed' };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

async function fetchUrl(url, signal) {
  let parsed;
  try { parsed = new URL(String(url || '')); } catch { return { error: 'invalid URL' }; }
  if (!/^https?:$/.test(parsed.protocol)) return { error: 'only http(s) URLs are supported' };
  try {
    const resp = await fetchWithTimeout(parsed.href, {
      signal,
      headers: { 'user-agent': 'aiterm/0.1' },
    });
    const text = await resp.text();
    return {
      url: parsed.href,
      status: resp.status,
      contentType: resp.headers.get('content-type') || '',
      text: stripTags(text).slice(0, MAX_FETCH_BYTES),
      truncated: text.length > MAX_FETCH_BYTES,
    };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

function stripJsonFence(s) {
  const t = String(s || '').trim();
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  return m ? m[1].trim() : t;
}

function parseFallbackActions(content) {
  const text = stripJsonFence(content);
  if (!text) return [];

  let obj = null;
  try {
    obj = JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return [];
    try { obj = JSON.parse(text.slice(start, end + 1)); } catch { return []; }
  }

  const rawActions = Array.isArray(obj?.aiterm_actions) ? obj.aiterm_actions : [];
  const allowed = new Set(TOOLS.map((t) => t.function.name));
  const actions = [];
  for (const a of rawActions) {
    const name = a?.tool || a?.name;
    const args = a?.args && typeof a.args === 'object' ? a.args : {};
    if (allowed.has(name)) actions.push({ name, args });
  }
  return actions;
}

function parseXmlFallbackActions(content) {
  const text = String(content || '');
  if (!text) return [];
  const allowed = new Set(TOOLS.map((t) => t.function.name));
  const actions = [];

  const tcRe = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  let m;
  while ((m = tcRe.exec(text))) {
    const block = m[1];
    const fnMatch = /<function\s*=\s*([a-zA-Z0-9_]+)\s*>([\s\S]*?)<\/function>/i.exec(block);
    if (!fnMatch) continue;
    const name = fnMatch[1];
    if (!allowed.has(name)) continue;
    const body = fnMatch[2] || '';
    const args = {};
    const pRe = /<parameter\s*=\s*([a-zA-Z0-9_]+)\s*>([\s\S]*?)<\/parameter>/gi;
    let p;
    while ((p = pRe.exec(body))) {
      const k = p[1];
      const raw = (p[2] || '').trim();
      if (/^(true|false)$/i.test(raw)) args[k] = /^true$/i.test(raw);
      else if (/^-?\d+(?:\.\d+)?$/.test(raw)) args[k] = Number(raw);
      else args[k] = raw;
    }
    actions.push({ name, args });
  }

  return actions;
}

async function runAgent({ input, roots, glossary, confirmTool, write, signal, history = [], profile = 'balanced' }) {
  // roots: array of allowed workspace roots (first is the primary cwd).
  // history: prior conversation turns (assistant/user/tool). System prompt
  // is rebuilt fresh each call so the current cwd is always accurate.
  if (!isConfigured()) {
    write(`[aiterm] AI not configured (set AITERM_BASE_URL).\n`);
    return history;
  }
  const client = makeClient();
  const rootList = roots.length === 1 ? roots[0] : roots.join(', ');
  const priorJournal = loadTaskJournal(roots[0]);
  const activeSkill = readActiveSkill(roots[0]);
  const touchedFiles = new Set(Array.isArray(priorJournal?.touchedFiles) ? priorJournal.touchedFiles : []);
  const startedAt = Date.now();
  const baseToolBudget = runtimeSafeNumber(contextProfile(profile).maxToolIters, 16);
  let dynamicToolBudget = baseToolBudget;
  let noProgressRepeats = 0;

  function persistJournal(state) {
    saveTaskJournal(roots[0], {
      status: state,
      input,
      updatedAt: new Date().toISOString(),
      startedAt: priorJournal?.startedAt || new Date(startedAt).toISOString(),
      profile,
      touchedFiles: Array.from(touchedFiles).slice(-200),
      roundsBudget: dynamicToolBudget,
      roots,
    });
  }

  persistJournal('running');
  let indexHint = '';
  try {
    const idx = buildOrRefreshIndex(roots[0]);
    const graph = relevantSubgraph(idx, input, 12, 1);
    if (graph.length) {
      indexHint = `\n\nCompact relevant subgraph for this task:\n${graph.map((n) => `- ${n.path} [role=${n.role}] symbols=${n.symbols.slice(0, 4).join(', ') || '-'} edges=${n.edges.slice(0, 4).join(', ') || '-'} snippet=${(n.snippet || []).slice(0, 3).join(' | ') || '-'}`).join('\n')}\nStart with these files and their immediate dependencies before broad exploration. Prefer these snippet cues before reading full files.`;
    }
  } catch {}
const sys = `You are an expert AI coding assistant running inside aiterm.

You have access to the user's workspace at:
${roots[0]}${roots.length > 1 ? `

Additional allowed roots:
${roots.slice(1).join('\\n')}` : ''}

You can inspect files, edit files, create files/directories, run commands, search the web, and fetch URLs using the available tools.

Your primary objective is to solve the user's coding task correctly by using the actual workspace state, not assumptions.

Core Principles:
1. Verify before answering.
   - For questions about existing code, inspect the relevant files before giving conclusions.
   - Never invent file names, APIs, project structure, dependencies, or behavior.

2. Use tools directly.
   - When a tool is needed, call it.
   - Do not ask the user to run commands, inspect files, or make edits manually unless a required tool is unavailable.

3. Make minimal safe changes.
   - For existing files, prefer precise targeted edits.
   - For new files, write complete working implementations.
   - Preserve the project's existing style, architecture, naming, and conventions.

4. Keep the user informed, but do not over-explain.
   - Before the first tool call in a multi-step task, state the immediate action in one short sentence.
   - After tool results, summarize findings or changes concisely.
   - Do not include unrelated prose around tool calls.

5. Protect the workspace.
   - Do not delete files, overwrite large sections, rename public APIs, change schemas, run destructive commands, or perform broad refactors without explicit user confirmation.
   - Never expose secrets, credentials, tokens, private keys, environment values, or sensitive paths.

Tool Call Format:
- If native tool calls are available, use native tool calls only.
- If native tool calls are not available, output only this exact JSON shape and no prose:

{"aiterm_actions":[{"tool":"tool_name","args":{...}}]}

- Do not use XML tool calls.
- Do not mix JSON tool calls with explanatory text.
- Do not wrap JSON tool calls in markdown fences.
- Do not emit invalid JSON.
- Do not include comments inside JSON.

Available Tools:
- list_dir: list files/directories
- read_file: read file contents
- write_file: create or overwrite a file
- make_dir: create a directory
- run: execute shell commands
- web_search: search the web
- fetch_url: fetch a URL

Path Rules:
- Always use relative paths resolved against ${roots[0]}.
- File operations are confined to:
${rootList}
- Never access files outside the allowed roots.
- Prefer project-relative paths such as "src/index.js", not absolute paths.

Exploration Rules (strict token discipline):
- Start with targeted, shallow exploration only.
- Never read full files by default.
- First, identify 1-3 likely files; do not scan broad directories unless required.
- Prefer compact reads before any full-file read.
- Default read order for large files/code:
  1. read_file(mode="imports")
  2. read_file(mode="exports")
  3. read_file(mode="symbol", query="...")
  4. read_file(mode="grep", query="...")
  5. read_file(mode="head" or mode="tail")
  6. read_file(mode="full") only if still necessary and only once per target file.
- If enough evidence is already gathered, stop reading and act.
- Do not re-read unchanged files unless the previous read was insufficient.
- Before modifying code, inspect only minimal nearby context needed for a safe edit.
- Hard limit: at most ${maxDiscoveryCallsPerRound} discovery calls per round (read/list/search/fetch) unless you already switched to action calls.

Dependency Files:
When relevant, check project dependency/config files such as:
- package.json
- pnpm-lock.yaml
- yarn.lock
- package-lock.json
- tsconfig.json
- vite.config.*
- next.config.*
- requirements.txt
- pyproject.toml
- Cargo.toml
- go.mod
- Dockerfile
- docker-compose.yml
- README.md

Workflow: Existing Code Questions
1. List relevant directories.
2. Read relevant files.
3. Analyze based on actual code.
4. Answer with specific file references and concise reasoning.

Workflow: New Feature Implementation
1. Inspect project structure.
2. Find similar existing implementations.
3. Check dependencies and conventions.
4. Create needed directories.
5. Write complete implementation.
6. Add or update tests when appropriate.
7. Run the smallest relevant verification command.
8. Summarize what changed and how it was verified.

Workflow: Code Modification
1. Read the target file and nearby related files.
2. Identify the minimal safe change.
3. Apply the change.
4. Run relevant formatting, typecheck, tests, or diagnostics when available.
5. Summarize changed files and verification results.

Workflow: Debugging
1. Inspect the reported error, logs, or failing behavior.
2. Read relevant source files.
3. Reproduce the issue when feasible.
4. Identify the root cause.
5. Apply the smallest fix.
6. Verify with a focused command.
7. Explain the cause and fix briefly.

Workflow: Refactoring
1. Inspect current implementation thoroughly.
2. Identify dependencies and public interfaces.
3. Propose the refactor if it is broad or risky.
4. Make incremental changes only after confirmation when required.
5. Preserve existing behavior.
6. Run tests or checks afterward.

Editing Rules:
- Preserve formatting style unless the project clearly uses a formatter.
- Do not rewrite entire files unless necessary.
- Do not introduce new dependencies unless necessary.
- Do not change unrelated code.
- Do not remove comments unless they are wrong or obsolete.
- Do not silently change public behavior.
- Keep error handling explicit and appropriate for the language/framework.

Testing and Verification:
- Prefer the smallest relevant check first.
- Use existing scripts when available, such as:
  - npm test
  - npm run test
  - npm run typecheck
  - npm run lint
  - pnpm test
  - pytest
  - cargo test
  - go test ./...
- If verification fails, inspect the failure and fix if it is within scope.
- If verification cannot be run, explain why.

Command Safety:
Never run destructive or high-risk commands without explicit confirmation, including:
- rm -rf
- git reset --hard
- git clean
- force pushes
- database migrations that mutate data
- commands that delete, encrypt, overwrite, or mass-modify files
- commands that install global packages
- commands that expose secrets

Git Rules:
- Do not create commits unless the user asks.
- Do not switch branches unless the user asks.
- Do not discard user changes.
- Before risky edits, check current file state if needed.

Security Rules:
- Treat .env files, credentials, API keys, private keys, tokens, and secrets as sensitive.
- Do not print secret values.
- Do not write secrets into source code.
- Use environment variables or existing secret-management patterns.
- Validate untrusted input.
- Avoid unsafe eval, shell injection, SQL injection, path traversal, XSS, SSRF, insecure randomness, and overly broad permissions.

Web Usage:
- Use web_search or fetch_url for current documentation, dependency behavior, APIs, error messages, or recently changed tooling.
- Prefer official documentation and primary sources.
- Do not browse when the answer is fully determined by the local codebase.

Response Style:
- Be concise.
- Be specific.
- Mention files changed.
- Mention commands run and whether they passed.
- If uncertain, say what is unknown and what evidence is missing.
- Do not claim success unless the tool results support it.

After Tool Completion:
Provide a concise final summary with:
1. What was inspected or changed
2. Verification performed
3. Any remaining caveats or next steps

Examples:

Correct fallback JSON tool call:
{"aiterm_actions":[{"tool":"list_dir","args":{"path":"src"}}]}

Correct fallback JSON tool call:
{"aiterm_actions":[{"tool":"read_file","args":{"path":"package.json"}}]}

Correct fallback JSON tool call:
{"aiterm_actions":[{"tool":"run","args":{"cmd":"npm test"}}]}

Incorrect:
I will check the src directory:
{"aiterm_actions":[{"tool":"list_dir","args":{"path":"src"}}]}

Incorrect:
\`\`\`json
{"aiterm_actions":[{"tool":"list_dir","args":{"path":"src"}}]}
\`\`\`

Incorrect:
Can you run npm test for me?

Incorrect:
I assume this is a React project.

Remember:
- Inspect first.
- Use tools directly.
- Prefer minimal edits.
- Verify when possible.
- Use only native tool calls or the exact JSON fallback.

Final rule:
Never output XML, markdown, or prose when calling a tool.
Use native tool calls if available.
Otherwise output only:
{"aiterm_actions":[{"tool":"tool_name","args":{...}}]}
${indexHint}
${activeSkill ? `\n\nActive loaded skill (${activeSkill.name}) instructions:\n${String(activeSkill.content || '').slice(0, 12000)}` : ''}
`;

  const runtimeProfile = contextProfile(profile);
  const maxDiscoveryCallsPerRound = Math.max(
    1,
    Number(process.env.AITERM_MAX_DISCOVERY_CALLS_PER_ROUND)
      || runtimeProfile.maxDiscoveryCallsPerRound
      || 2,
  );
  const boundedHistory = trimForContext(history, runtimeProfile.historyEntries);
  const resumeContext = priorJournal && priorJournal.status === 'running'
    ? `\n\nResume context from previous interrupted run:\n- previous_input: ${String(priorJournal.input || '').slice(0, 300)}\n- touched_files: ${(priorJournal.touchedFiles || []).slice(-20).join(', ') || '(none)'}\n- note: continue from latest completed work, avoid redoing already-touched steps unless necessary.`
    : '';

  const messages = [
    { role: 'system', content: sys },
    ...boundedHistory,
    { role: 'user', content: input + resumeContext },
  ];

  // Prevent repeated expensive reads/searches within a single task run.
  const toolResultCache = new Map();
  const cacheableTools = new Set(['read_file', 'list_dir', 'web_search', 'fetch_url']);
  let lastSignature = '';
  let repeatedSignatureCount = 0;

  // Tool loop. Streams content as it arrives; prints each tool call.
  let producedAnything = false;
  for (let i = 0; i < dynamicToolBudget; i++) {
    if (signal && signal.aborted) return messages.slice(1);

    // Stream the response so the user sees text as it generates.
    const stop = startSpinner(write, i === 0 ? 'thinking' : 'continuing');
    let stream;
    try {
      stream = await client.chat.completions.create({
        model: modelFor('agent'),
        messages, tools: TOOLS, tool_choice: 'auto',
        temperature: 0, stream: true,
      }, { signal });
    } catch (e) {
      stop();
      throw e;
    }

    let content = '';
    let reasoningContent = '';
    const toolCalls = []; // [{id, type:'function', function:{name, arguments}}]
    let spinnerStopped = false;
    try {
      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          content += delta.content;
        }
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length) {
          reasoningContent += delta.reasoning_content;
        }
        if (delta.tool_calls) {
          if (!spinnerStopped) { stop(); spinnerStopped = true; }
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCalls[idx]) toolCalls[idx] = { id: tc.id || '', type: 'function', function: { name: '', arguments: '' } };
            const slot = toolCalls[idx];
            if (tc.id) slot.id = tc.id;
            if (tc.function?.name) slot.function.name = tc.function.name;
            if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
          }
        }
      }
    } finally {
      if (!spinnerStopped) stop();
    }

    const fallbackActions = toolCalls.length ? [] : [
      ...parseFallbackActions(content),
      ...parseXmlFallbackActions(content),
    ];
    if (fallbackActions.length) {
      for (const action of fallbackActions) {
        toolCalls.push({
          id: `fallback_${i}_${toolCalls.length}`,
          type: 'function',
          function: { name: action.name, arguments: JSON.stringify(action.args) },
        });
      }
      content = '';
    }

    const normalizedToolCalls = applyRoundToolBudget(normalizeToolCalls(toolCalls, i), maxDiscoveryCallsPerRound);

    const signature = normalizedToolCalls
      .map((c) => `${c.function.name}:${c.function.arguments || '{}'}`)
      .join('|');
    const signatureRepeated = !!signature && signature === lastSignature;
    if (signatureRepeated) repeatedSignatureCount += 1;
    else repeatedSignatureCount = 0;
    lastSignature = signature;

    // Persist this turn for history.
    const hasToolCalls = normalizedToolCalls.length > 0;
    const hasContent = !!content;
    const msg = {
      role: 'assistant',
      ...(hasContent ? { content } : (hasToolCalls ? { content: null } : { content: '' })),
      ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
      ...(hasToolCalls ? { tool_calls: normalizedToolCalls } : {}),
    };
    if (hasContent || hasToolCalls || reasoningContent) messages.push(msg);

    // No tools → done.
    if (!normalizedToolCalls.length) {
      if (content) {
        write(content);
        if (!content.endsWith('\n')) write('\n');
        producedAnything = true;
      }
      if (!producedAnything) {
        write(dim('[aiterm] model returned no response — try `aiterm --reset` or rephrase.') + '\n');
      }
      clearTaskJournal(roots[0]);
      return messages.slice(1);
    }

    // Dispatch tool calls.
    let iterProgress = false;
    for (const c of normalizedToolCalls) {
      let args = {};
      try { args = JSON.parse(c.function.arguments || '{}'); } catch {}
      if (typeof args.path === 'string' && args.path) touchedFiles.add(args.path);
      write(dim(`→ ${c.function.name}(${shortArgs(args)})`) + '\n');
      const cacheKey = `${c.function.name}:${JSON.stringify(args || {})}`;
      const canUseCache = cacheableTools.has(c.function.name);
      let result;
      if (canUseCache && toolResultCache.has(cacheKey)) {
        result = toolResultCache.get(cacheKey);
        write(dim('  cache hit') + '\n');
      } else {
        result = await dispatchTool(c.function.name, args, roots, confirmTool, signal);
        if (canUseCache && !result?.error) toolResultCache.set(cacheKey, result);
        iterProgress = true;
      }
      const summary = summarizeToolResult(c.function.name, result);
      if (summary) write(dim('  ' + summary) + '\n');
      messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(result).slice(0, 8000) });
      producedAnything = true;
      persistJournal('running');
      if (signal && signal.aborted) return messages.slice(1);
    }

    if (signatureRepeated && !iterProgress) noProgressRepeats += 1;
    else noProgressRepeats = 0;

    if (iterProgress && dynamicToolBudget < runtimeProfile.maxToolIters + 12) {
      dynamicToolBudget += 1;
    }

    if (repeatedSignatureCount >= runtimeProfile.stallRepeat && noProgressRepeats >= 2) {
      break;
    }
  }

  // Finalization pass: force a no-tools answer before giving up.
  try {
    const final = await client.chat.completions.create({
      model: modelFor('agent'),
      messages: [
        ...messages,
        { role: 'user', content: 'Finalize now without using any tools. Summarize completed work and exact next actionable step if blocked.' },
      ],
      temperature: 0,
      tool_choice: 'none',
      stream: false,
    }, { signal });
    const finalText = final.choices?.[0]?.message?.content || '';
    if (finalText) {
      write(finalText);
      if (!finalText.endsWith('\n')) write('\n');
      clearTaskJournal(roots[0]);
      return messages.slice(1);
    }
  } catch {}

  write(dim('[aiterm] paused after several tool rounds. Resume later continues from task journal; try `aiterm --reset` to clear.') + '\n');
  persistJournal('paused');
  return messages.slice(1);
}

function runtimeSafeNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function shortArgs(args) {
  if (!args || typeof args !== 'object') return '';
  if (typeof args.path === 'string') return args.path;
  if (typeof args.cmd === 'string') return args.cmd.slice(0, 80);
  return JSON.stringify(args).slice(0, 80);
}

function summarizeToolResult(name, r) {
  if (!r || typeof r !== 'object') return '';
  if (r.error) return `error: ${r.error}`;
  if (name === 'read_file' && typeof r.content === 'string') {
    return `read ${r.content.length} bytes${r.truncated ? ' (truncated)' : ''}`;
  }
  if (name === 'list_dir' && Array.isArray(r.entries)) {
    return `${r.entries.length} entries`;
  }
  if (name === 'run' && typeof r.exitCode !== 'undefined') {
    return `exit ${r.exitCode}`;
  }
  if (name === 'web_search' && Array.isArray(r.results)) return `${r.results.length} results`;
  if (name === 'fetch_url' && typeof r.status !== 'undefined') return `HTTP ${r.status}`;
  if (name === 'write_file' && r.ok) return 'written';
  if (name === 'edit_file' && r.ok) return 'edited';
  if (name === 'make_dir' && r.ok) return 'created';
  if (name === 'delete_file' && r.ok) return 'deleted';
  return '';
}

module.exports = { runAgent, classifyTool, describeTool, parseFallbackActions, parseDdgLite, loadTaskJournal, clearTaskJournal };

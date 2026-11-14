// Tool definitions, classification, dispatch, and fallback parsing.
// Extracted from agent.js. Depends on ./safety and ./web for run/search/fetch.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { classifyRunCommand, isSecretPath } = require('./safety');
const { webSearch, fetchUrl } = require('./web');
const { dispatchBrowser, classifyBrowserCommand } = require('./browser');
const { recordEdit } = require('./edit-tracker');
const { appendMemory } = require('./memory');

const MAX_FILE_BYTES = 64 * 1024;

// Resolve a path against a list of allowed roots. Returns the absolute
// path if it lies inside any root, or null otherwise. The first root in
// the list is used as the base for relative resolution.
//
// Uses realpath to defeat symlink traversal: a path that appears to be
// inside a root via lexical resolution but points outside via a symlink
// chain will be rejected.
function within(roots, p) {
  if (!roots || !roots.length) return null;
  if (typeof p !== 'string' || !p.trim()) return null;
  const base = path.resolve(roots[0]);
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(base, p);

  // Resolve to real path to defeat symlink escapes.
  let realAbs;
  try {
    realAbs = fs.realpathSync(abs);
  } catch {
    // Path doesn't exist yet (e.g. write_file target).
    // Resolve the deepest existing ancestor to guard against symlinks
    // in parent directories.
    let d = path.dirname(abs);
    while (d && d !== path.dirname(d)) {
      try { realAbs = path.join(fs.realpathSync(d), path.relative(d, abs)); break; }
      catch { d = path.dirname(d); }
    }
    if (!realAbs) return null;
  }

  for (const r of roots) {
    let rr;
    try { rr = fs.realpathSync(r); } catch { rr = path.resolve(r); }
    if (realAbs === rr || realAbs.startsWith(rr + path.sep)) return abs;
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
  { type: 'function', function: {
    name: 'remember',
    description: 'Save a durable fact to agent memory so it survives across sessions. Use for codebase quirks, API gotchas, user preferences, or anything you wouldn\'t want to re-discover next session. Keep facts short and specific.',
    parameters: {
      type: 'object',
      required: ['fact'],
      properties: {
        fact: { type: 'string', description: 'Short single-line fact, e.g. "Auth uses HS256 JWTs, secret in $JWT_SECRET"' },
        category: { type: 'string', description: 'Section to file the fact under. Examples: Codebase, Preferences, Gotchas, API quirks. Default: Notes.' },
        scope: { type: 'string', enum: ['global', 'workspace'], description: 'global = applies to all workspaces; workspace = only this project. Default: workspace (project-specific facts are usually safer to scope).' },
      },
    },
  }},
  { type: 'function', function: {
    name: 'browser',
    description: 'Control a headless browser. Commands: navigate (go to URL), click (CSS selector), type (fill input), read_page (extract page content, links, forms), screenshot (save PNG), evaluate (run JS), select (dropdown), wait (for selector or seconds), scroll (up/down), close.',
    parameters: {
      type: 'object',
      required: ['command'],
      properties: {
        command: { type: 'string', enum: ['navigate', 'click', 'type', 'read_page', 'screenshot', 'evaluate', 'select', 'wait', 'scroll', 'close'] },
        url: { type: 'string', description: 'URL for navigate' },
        selector: { type: 'string', description: 'CSS selector for click/type/select/wait' },
        text: { type: 'string', description: 'Text to type or option to select' },
        code: { type: 'string', description: 'JavaScript for evaluate' },
        seconds: { type: 'number', description: 'Seconds to wait' },
        direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction' },
      },
    },
  }},
];

// Tools available in read-only "chat" mode. Everything that can mutate the
// workspace (writes, edits, deletes, shell, browser interactions) is excluded;
// web access and long-term memory are kept so a read-only conversation stays
// useful for questions and research.
const CHAT_MODE_TOOLS = new Set(['read_file', 'list_dir', 'web_search', 'fetch_url', 'remember']);

// Tool safety classification.
// 'safe'      → auto mode runs it without asking; review mode asks with [Y/n]
// 'unsafe'    → both modes ask, defaulting to No  ([y/N])
// 'uncertain' → both modes ask, defaulting to No  ([y/N])
function classifyTool(name, args, mcpManager) {
  if (name.startsWith('mcp__') && mcpManager) return mcpManager.classifyTool(name);
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
  if (name === 'browser') return classifyBrowserCommand(args);
  if (name === 'remember') return 'safe';
  return 'uncertain';
}

function describeTool(name, args, mcpManager) {
  if (name.startsWith('mcp__') && mcpManager) return mcpManager.describeTool(name, args);
  if (name === 'read_file') return `read ${args.path}${args.mode ? ` (${args.mode})` : ''}`;
  if (name === 'list_dir') return `list ${args.path || '.'}`;
  if (name === 'write_file') return `write ${args.path} (${(args.content || '').length} bytes)`;
  if (name === 'edit_file') return `edit ${args.path}`;
  if (name === 'make_dir') return `mkdir ${args.path}`;
  if (name === 'delete_file') return `delete ${args.path}`;
  if (name === 'run') return `run command (see below)`;
  if (name === 'web_search') return `web search: "${(args.query || '').slice(0, 100)}"`;
  if (name === 'fetch_url') return `fetch ${args.url}`;
  if (name === 'remember') return `remember [${args.scope || 'workspace'}/${args.category || 'Notes'}]: ${(args.fact || '').slice(0, 100)}`;
  if (name === 'browser') {
    const cmd = args.command || '';
    if (cmd === 'navigate') return `browser navigate ${args.url || ''}`;
    if (cmd === 'click') return `browser click ${args.selector || ''}`;
    if (cmd === 'type') return `browser type into ${args.selector || ''}`;
    if (cmd === 'read_page') return 'browser read page content';
    if (cmd === 'screenshot') return 'browser screenshot';
    if (cmd === 'evaluate') return `browser eval JS`;
    return `browser ${cmd}`;
  }
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

async function dispatchTool(name, args, roots, confirmTool, signal, mcpManager, allowedTools) {
  if (signal && signal.aborted) return { error: 'aborted' };
  if (allowedTools && !allowedTools.has(name)) return { error: 'not available in chat mode (read-only)' };
  const safety = classifyTool(name, args, mcpManager);
  if (confirmTool) {
    const ok = await confirmTool({ name, args, safety, description: describeTool(name, args, mcpManager) });
    if (!ok) return { error: 'user declined' };
  }
  if (signal && signal.aborted) return { error: 'aborted' };
  // MCP tools: route to MCP manager
  if (name.startsWith('mcp__') && mcpManager) {
    return mcpManager.dispatchTool(name, args, signal);
  }
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
    const oldContent = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, args.content ?? '');
    recordEdit({ filePath: p, oldContent, newContent: args.content ?? '', tool: 'write_file' });
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
      recordEdit({ filePath: p, oldContent: content, newContent: updated, tool: 'edit_file' });
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
  if (name === 'browser') {
    return await dispatchBrowser(args);
  }
  if (name === 'remember') {
    const r = appendMemory({
      category: args.category,
      fact: args.fact,
      scope: args.scope === 'global' ? 'global' : 'workspace',
      cwd: roots[0],
    });
    return r.ok
      ? { ok: true, saved_to: r.path, line: r.line }
      : { error: r.error };
  }
  return { error: `unknown tool: ${name}` };
}

// ── Tool call normalization & budgeting ────────────────────────────────────

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

// ── Fallback action parsing (text-based tool calls) ─────────────────────────

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

  const rawActions = Array.isArray(obj?.shmakk_actions) ? obj.shmakk_actions : [];
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
  // Normalize DeepSeek DSML format: <｜｜DSML｜｜tool_calls> → <tool_calls>
  // DSML uses fullwidth vertical bars (U+FF5C) around tag names.
  const text = String(content || '').replace(/<(\/?)(?:｜+DSML)?｜+/g, '<$1').replace(/｜+>/g, '>');
  if (!text) return [];
  const allowed = new Set(TOOLS.map((t) => t.function.name));
  const actions = [];

  // Old Anthropic format:
  //   <tool_call><function=tool_name><parameter=key>val</parameter></function></tool_call>
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
      args[k] = parseXmlParamValue(p[2]);
    }
    actions.push({ name, args });
  }

  // New Anthropic format:
  //   <tool_calls><invoke name="tool_name"><parameter name="key" string="true">val</parameter></invoke></tool_calls>
  const tcsRe = /<tool_calls>([\s\S]*?)<\/tool_calls>/gi;
  while ((m = tcsRe.exec(text))) {
    const block = m[1];
    const invRe = /<invoke\s+name\s*=\s*"([a-zA-Z0-9_]+)"\s*>([\s\S]*?)<\/invoke>/gi;
    let inv;
    while ((inv = invRe.exec(block))) {
      const name = inv[1];
      if (!allowed.has(name)) continue;
      const body = inv[2] || '';
      const args = {};
      const pRe = /<parameter\s+name\s*=\s*"([a-zA-Z0-9_]+)"([^>]*?)>([\s\S]*?)<\/parameter>/gi;
      let p;
      while ((p = pRe.exec(body))) {
        const k = p[1];
        args[k] = parseXmlParamValue(p[3]);
      }
      actions.push({ name, args });
    }
  }

  return actions;
}

function parseXmlParamValue(raw) {
  const v = (raw || '').trim();
  if (/^(true|false)$/i.test(v)) return /^true$/i.test(v);
  if (/^-?\d+(?:\.\d+)?$/.test(v)) return Number(v);
  return v;
}

module.exports = {
  TOOLS,
  CHAT_MODE_TOOLS,
  classifyTool,
  describeTool,
  dispatchTool,
  runCmd,
  normalizeToolCalls,
  applyRoundToolBudget,
  within,
  parseFallbackActions,
  parseXmlFallbackActions,
  stripJsonFence,
};

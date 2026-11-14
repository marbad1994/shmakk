// REST API for the web UI. Each route is the GUI equivalent of a CLI flag or
// self-command; the heavy lifting stays in the same modules the CLI uses.

const fs = require('fs');
const os = require('os');
const path = require('path');

const skills = require('../skills');
const memory = require('../memory');
const rules = require('../rules');
const planner = require('../planner');
const workflows = require('../workflows');
const sessionSearch = require('../session-search');
const audit = require('../audit');
const endpoints = require('../endpoints');
const llm = require('../llm');
const { PRESETS, normalizeProfile } = require('../profiles');
const { loadTaskJournal, clearTaskJournal } = require('../agent');
const { getEdits, clearEdits } = require('../edit-tracker');
const { unifiedDiff, newFileDiff } = require('../edit-viewer');
const { AGENT_ROSTER } = require('../team');
const { SPECIALISTS } = require('../coordinator');
const { HELP } = require('../cli');
const { workspaceWarning } = require('../safety');
const terminal = require('./terminal');
const { createGitHub, GitHubError } = require('./github');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function canResolve(mod) {
  try { require.resolve(mod); return true; } catch { return false; }
}

function maskKey(key) {
  if (!key) return null;
  const k = String(key);
  return k.length <= 12 ? '•'.repeat(k.length) : `${k.slice(0, 6)}…${k.slice(-4)}`;
}

function readText(p, max = 512 * 1024) {
  try {
    if (!fs.existsSync(p)) return '';
    const buf = fs.readFileSync(p);
    return buf.slice(0, max).toString('utf8');
  } catch { return ''; }
}

function writeText(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, String(content ?? ''), 'utf8');
}

function mcpPaths(workspace) {
  return {
    global: path.join(os.homedir(), '.config', 'shmakk', 'mcp.json'),
    workspace: path.join(workspace, '.shmakk', 'mcp.json'),
  };
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// app: { settings, saveSettings, chat, getWorkspace, setWorkspace, getMcp,
//        restartMcp, broadcast, version, shutdown, applyProvider }
// What the browser gets to see of the settings: no token, no API key.
function publicSettings(settings) {
  const { token: _t, provider: _p, github: _g, ...rest } = settings;
  return rest;
}

function createApi(app) {
  const routes = [];
  const add = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:([a-zA-Z]+)/g, (_m, k) => { keys.push(k); return '([^/]+)'; })}$`);
    routes.push({ method, re, keys, handler });
  };

  const ws = () => app.getWorkspace();
  const github = createGitHub({ settings: app.settings, saveSettings: app.saveSettings });
  app.github = github;

  function providerInfo() {
    const active = endpoints.getCurrentEndpoint();
    const key = active?.api_key || process.env.SHMAKK_API_KEY || '';
    return {
      configured: llm.isConfigured(),
      endpoint: endpoints.getCurrentEndpointName(),
      endpoints: endpoints.listEndpoints(ws()),
      baseUrl: active?.base_url || process.env.SHMAKK_BASE_URL || '',
      model: process.env.SHMAKK_MODEL || active?.model || '',
      apiKeyMasked: maskKey(key),
      hasApiKey: !!key,
      headers: active?.headers || process.env.SHMAKK_HEADERS || '',
      registry: active?.registry || process.env.SHMAKK_REGISTRY || '',
    };
  }
  app.providerInfo = providerInfo;

  function features() {
    return {
      terminal: terminal.isAvailable(),
      terminalReason: terminal.unavailableReason(),
      sessionSearch: sessionSearch.isAvailable(),
      stt: canResolve('@huggingface/transformers'),
      tts: canResolve('kokoro-js'),
      browser: canResolve('playwright'),
      desktop: !!process.versions.electron,
    };
  }

  function statusInfo() {
    const root = ws();
    const journal = loadTaskJournal(root);
    const active = skills.readActiveSkill(root) || skills.readActiveSkillGlobally();
    let auditEvents = 0;
    try {
      const p = audit.logPath();
      if (fs.existsSync(p)) auditEvents = fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).length;
    } catch {}
    const mcp = app.getMcp().status();
    return {
      pid: process.pid,
      version: app.version,
      workspace: root,
      workspaceWarning: workspaceWarning(root),
      uptimeSec: Math.round(process.uptime()),
      journal: journal ? {
        status: journal.status, input: String(journal.input || '').slice(0, 200), profile: journal.profile,
        updatedAt: journal.updatedAt, startedAt: journal.startedAt,
        touchedFiles: Array.isArray(journal.touchedFiles) ? journal.touchedFiles : [],
      } : null,
      activeSkill: active ? { name: active.name, version: active.version || '1', loadedAt: active.loadedAt || null } : null,
      auditEvents,
      auditPath: audit.logPath(),
      edits: getEdits().length,
      plan: planner.loadPlan(root),
      mcp: { servers: mcp.serverCount, tools: mcp.toolCount },
      glossary: glossaryStatus(),
    };
  }

  function glossaryStatus() {
    try {
      const { defaultGlossaryPath } = require('../glossary');
      const p = defaultGlossaryPath();
      if (!fs.existsSync(p)) return { exists: false, path: p };
      const st = fs.statSync(p);
      let commands = 0;
      try { commands = Object.keys(JSON.parse(fs.readFileSync(p, 'utf8')).commands || {}).length; } catch {}
      return { exists: true, path: p, updatedAt: st.mtimeMs, commands };
    } catch { return { exists: false }; }
  }

  // ── bootstrap / status ────────────────────────────────────────────────

  add('GET', '/api/bootstrap', () => ({
    version: app.version,
    workspace: ws(),
    home: os.homedir(),
    platform: process.platform,
    settings: publicSettings(app.settings),
    provider: providerInfo(),
    profiles: Object.entries(PRESETS).map(([name, p]) => ({ name, ...p })),
    features: features(),
    hosted: !!app.hosted,
    conversations: app.chat.list(),
    status: statusInfo(),
  }));

  add('GET', '/api/status', () => statusInfo());
  add('GET', '/api/help', () => ({ text: HELP }));

  add('GET', '/api/config', () => {
    const p = providerInfo();
    return {
      review: !!app.settings.review, yesFiles: !!app.settings.yesFiles, noAi: !!app.settings.noAi,
      noCorrection: !!app.settings.noCorrection, workspace: ws(), shell: process.env.SHELL || null,
      term: process.env.TERM || null, endpoint: p.endpoint, baseUrl: p.baseUrl || null, apiKey: p.apiKeyMasked,
      model: p.model || null, registry: p.registry || null, profile: app.settings.profile || 'auto',
      debug: !!app.settings.debug, ttsAuto: !!app.settings.ttsAuto, ttsVoice: app.settings.ttsVoice || null,
    };
  });

  // ── settings (review / yes-files / correction / profile / voice …) ─────

  add('GET', '/api/settings', () => publicSettings(app.settings));
  add('PATCH', '/api/settings', ({ body }) => {
    const bools = ['review', 'yesFiles', 'noCorrection', 'noAi', 'debug', 'ttsAuto', 'voiceHandsFree'];
    for (const k of bools) if (typeof body[k] === 'boolean') app.settings[k] = body[k];
    if ('profile' in body) {
      if (body.profile === null || body.profile === 'auto' || body.profile === '') app.settings.profile = null;
      else {
        const p = normalizeProfile(body.profile);
        if (!p) throw new HttpError(400, 'invalid profile');
        app.settings.profile = p;
      }
    }
    if ('ttsVoice' in body) app.settings.ttsVoice = body.ttsVoice ? String(body.ttsVoice).slice(0, 60) : null;
    if ('voiceLanguage' in body) app.settings.voiceLanguage = body.voiceLanguage ? String(body.voiceLanguage).slice(0, 20) : null;
    app.saveSettings();
    return publicSettings(app.settings);
  });

  // ── provider / endpoints / models ─────────────────────────────────────

  add('GET', '/api/provider', () => providerInfo());
  add('PUT', '/api/provider', ({ body }) => {
    app.applyProvider(body || {}, { persist: true });
    return providerInfo();
  });
  add('POST', '/api/endpoints/use', ({ body }) => {
    if (!body.name) { endpoints.clearEndpoint(); app.broadcastProvider(); return providerInfo(); }
    if (!endpoints.applyEndpoint(String(body.name), ws())) throw new HttpError(404, `endpoint "${body.name}" not found`);
    llm.ensureMakkorch().catch(() => {});
    app.broadcastProvider();
    return providerInfo();
  });
  add('GET', '/api/models', async () => {
    if (!llm.isConfigured()) return { models: [], error: 'provider not configured' };
    try {
      const client = llm.makeClient();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const page = await client.models.list({ signal: ctrl.signal });
      clearTimeout(timer);
      const ids = (page.data || []).map((m) => m.id).filter(Boolean).sort();
      return { models: ids };
    } catch (e) {
      return { models: [], error: String(e.message || e) };
    }
  });
  add('POST', '/api/provider/test', async () => {
    if (!llm.isConfigured()) return { ok: false, error: 'provider not configured' };
    const started = Date.now();
    try {
      const client = llm.makeClient();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      const r = await client.chat.completions.create({
        model: llm.modelFor(), messages: [{ role: 'user', content: 'Reply with the single word: ok' }], max_tokens: 8, stream: false,
      }, { signal: ctrl.signal });
      clearTimeout(timer);
      return { ok: true, ms: Date.now() - started, model: r.model || llm.modelFor(), reply: String(r.choices?.[0]?.message?.content || '').slice(0, 80) };
    } catch (e) {
      return { ok: false, ms: Date.now() - started, error: String(e.message || e) };
    }
  });

  // ── workspace & file browsing ─────────────────────────────────────────

  add('GET', '/api/workspace', () => ({ workspace: ws(), warning: workspaceWarning(ws()), recent: app.settings.recentWorkspaces || [] }));
  add('POST', '/api/workspace', ({ body }) => {
    const target = path.resolve(String(body.path || '').replace(/^~(?=$|\/)/, os.homedir()));
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new HttpError(400, 'not a directory');
    app.setWorkspace(target);
    return { workspace: ws(), warning: workspaceWarning(ws()) };
  });
  // Directory listing for the folder picker (directories only, anywhere the
  // user can read) and for @-mentions (files too, inside the workspace).
  add('GET', '/api/fs/list', ({ query }) => {
    const base = query.path ? path.resolve(String(query.path).replace(/^~(?=$|\/)/, os.homedir())) : ws();
    const dirsOnly = query.dirs === '1';
    let entries = [];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true })
        .filter((e) => (dirsOnly ? e.isDirectory() : true))
        .filter((e) => query.hidden === '1' || !e.name.startsWith('.'))
        .filter((e) => e.name !== 'node_modules')
        .map((e) => ({ name: e.name, dir: e.isDirectory() }))
        .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
        .slice(0, 500);
    } catch (e) { throw new HttpError(400, String(e.message)); }
    return { path: base, parent: path.dirname(base) === base ? null : path.dirname(base), entries };
  });

  // ── conversations ─────────────────────────────────────────────────────

  add('GET', '/api/conversations', () => ({ conversations: app.chat.list() }));
  add('POST', '/api/conversations', ({ body }) => app.chat.snapshot(app.chat.create({ title: body.title }).id));
  add('GET', '/api/conversations/:id', ({ params }) => {
    const snap = app.chat.snapshot(params.id);
    if (!snap) throw new HttpError(404, 'conversation not found');
    return snap;
  });
  add('PATCH', '/api/conversations/:id', ({ params, body }) => {
    const r = app.chat.update(params.id, body || {});
    if (!r) throw new HttpError(404, 'conversation not found');
    return r;
  });
  add('DELETE', '/api/conversations/:id', ({ params, query }) => {
    const conv = app.chat.get(params.id);
    const dir = conv && conv.repo ? conv.workspace : null;
    const ok = app.chat.remove(params.id);
    // Cloud sessions own their clone; remove it with the session unless asked not to.
    if (dir && query.keepWorkspace !== '1') {
      try {
        github.removeWorkspace(dir);
        if (ws() === dir) app.setWorkspace(app.homeWorkspace);
      } catch {}
    }
    return { ok };
  });
  // --reset / --compact for one conversation
  add('POST', '/api/conversations/:id/reset', ({ params }) => {
    const conv = app.chat.get(params.id);
    if (!conv) throw new HttpError(404, 'conversation not found');
    if (conv.run) throw new HttpError(409, 'stop the current run first');
    app.chat.resetConversation(conv);
    return { ok: true };
  });
  add('POST', '/api/conversations/:id/messages', async ({ params, body }) => {
    const r = await app.chat.send(params.id, body.text, { mode: body.mode });
    if (!r.ok) throw new HttpError(409, r.error);
    return r;
  });
  add('POST', '/api/conversations/:id/stop', ({ params }) => ({ ok: app.chat.stop(params.id) }));
  add('POST', '/api/conversations/:id/answer', ({ params, body }) => ({ ok: app.chat.answer(params.id, body.askId, body.value) }));

  // ── skills ────────────────────────────────────────────────────────────

  add('GET', '/api/skills', () => {
    const all = skills.listAllSkills(ws());
    const wsStatus = skills.skillStatus(ws());
    const gStatus = skills.skillStatusGlobally();
    const active = wsStatus.active || gStatus.active || null;
    const categories = [];
    for (const [id, list] of skills.groupByCategory(all)) {
      const info = skills.categoryInfo(id);
      categories.push({ id, label: info ? info.label : id, blurb: info ? info.blurb : '', count: list.length });
    }
    return {
      active,
      total: all.length,
      categories,
      skills: all.map((s) => ({
        name: s.name, version: s.version || '1', category: s.category || 'general', scope: s.scope,
        description: s.description || '', active: !!(active && active.name === s.name), bytes: s.bytes || 0,
      })),
    };
  });
  add('GET', '/api/skills/:name', ({ params }) => {
    const all = skills.listAllSkills(ws());
    const s = all.find((x) => x.name === skills.safeName(params.name));
    if (!s) throw new HttpError(404, 'skill not found');
    const file = s.localPath || s.source;
    return { ...s, content: file && fs.existsSync(file) ? readText(file) : '' };
  });
  add('POST', '/api/skills/load', ({ body }) => {
    const res = body.global ? skills.loadSkillGlobally(body.name) : skills.loadSkillToWorkspace(body.name, ws());
    if (!res.ok) throw new HttpError(400, res.error + (res.searched ? ` (searched ${res.searched.length} locations)` : ''));
    return res;
  });
  add('POST', '/api/skills/unload', ({ body }) => {
    let res = skills.unloadSkill(body.name, ws());
    if (!res.ok) res = skills.unloadSkillGlobally(body.name);
    if (!res.ok) throw new HttpError(400, res.error);
    return res;
  });
  // Deactivate without removing from the registry.
  add('POST', '/api/skills/deactivate', () => {
    try { fs.rmSync(path.join(ws(), '.shmakk', 'state', 'active-skill.json'), { force: true }); } catch {}
    return { ok: true };
  });
  add('POST', '/api/skills/install', async ({ body }) => {
    const res = body.global ? await skills.installSkillFromUrlGlobally(body.url) : await skills.installSkillFromUrl(body.url, ws());
    if (!res.ok) throw new HttpError(400, res.error);
    return res;
  });

  // ── memory & rules ────────────────────────────────────────────────────

  add('GET', '/api/memory', () => ({
    status: memory.memoryStatus(ws()),
    global: readText(memory.globalMemoryPath()),
    workspace: readText(memory.workspaceMemoryPath(ws())),
  }));
  add('PUT', '/api/memory', ({ body }) => {
    const p = body.scope === 'global' ? memory.globalMemoryPath() : memory.workspaceMemoryPath(ws());
    writeText(p, body.content);
    return { ok: true, path: p };
  });
  add('POST', '/api/memory/add', ({ body }) => {
    const r = memory.appendMemory({ category: body.category || 'Notes', fact: body.fact, scope: body.scope === 'global' ? 'global' : 'workspace', cwd: ws() });
    if (!r.ok) throw new HttpError(400, r.error);
    return r;
  });
  add('POST', '/api/memory/forget', ({ body }) => {
    if (!body.pattern) throw new HttpError(400, 'pattern required');
    return memory.forgetMemory(String(body.pattern), ws());
  });

  add('GET', '/api/rules', () => ({
    status: rules.rulesStatus(ws()),
    global: readText(rules.globalRulesPath()),
    workspace: readText(rules.workspaceRulesPath(ws())),
  }));
  add('PUT', '/api/rules', ({ body }) => {
    const p = body.scope === 'global' ? rules.globalRulesPath() : rules.workspaceRulesPath(ws());
    writeText(p, body.content);
    return { ok: true, path: p };
  });

  // ── plan / resume journal ─────────────────────────────────────────────

  add('GET', '/api/plan', () => ({ plan: planner.loadPlan(ws()), journal: loadTaskJournal(ws()) }));
  add('DELETE', '/api/plan', () => { planner.clearPlan(ws()); return { ok: true }; });
  add('DELETE', '/api/journal', () => { clearTaskJournal(ws()); return { ok: true }; });

  // ── MCP ───────────────────────────────────────────────────────────────

  add('GET', '/api/mcp', () => {
    const paths = mcpPaths(ws());
    const g = readJson(paths.global);
    const w = readJson(paths.workspace);
    const live = app.getMcp().status();
    const liveByName = new Map((live.servers || []).map((s) => [s.name, s]));
    const merged = { ...(g?.mcpServers || {}), ...(w?.mcpServers || {}) };
    return {
      paths,
      exists: { global: fs.existsSync(paths.global), workspace: fs.existsSync(paths.workspace) },
      raw: { global: readText(paths.global), workspace: readText(paths.workspace) },
      toolCount: live.toolCount,
      servers: Object.entries(merged).map(([name, cfg]) => ({
        name,
        source: w?.mcpServers?.[name] ? 'workspace' : 'global',
        command: `${cfg.command || ''} ${(cfg.args || []).join(' ')}`.trim(),
        disabled: !!cfg.disabled,
        safety: cfg.safety || null,
        safeTools: cfg.safeTools || [],
        env: Object.keys(cfg.env || {}),
        live: liveByName.get(name) || null,
      })),
      tools: app.getMcp().getToolDefinitions().map((d) => ({ name: d.function.name, description: d.function.description })),
    };
  });
  add('PUT', '/api/mcp', async ({ body }) => {
    const paths = mcpPaths(ws());
    const p = body.scope === 'workspace' ? paths.workspace : paths.global;
    let parsed;
    try { parsed = JSON.parse(String(body.content || '{}')); } catch (e) { throw new HttpError(400, `invalid JSON: ${e.message}`); }
    if (!parsed || typeof parsed !== 'object' || (parsed.mcpServers && typeof parsed.mcpServers !== 'object')) throw new HttpError(400, 'expected { "mcpServers": { … } }');
    writeText(p, JSON.stringify(parsed, null, 2) + '\n');
    return { ok: true, path: p, results: await app.restartMcp() };
  });
  add('POST', '/api/mcp/restart', async () => ({ ok: true, results: await app.restartMcp() }));

  // ── workflows & agents ────────────────────────────────────────────────

  add('GET', '/api/workflows', () => ({
    workflows: workflows.listWorkflows().map((w) => {
      const full = workflows.getWorkflow(w.id);
      return { ...w, steps: (full?.steps || []).map((s) => ({ role: s.role, task: s.task })) };
    }),
  }));
  add('GET', '/api/agents', () => ({
    agents: Object.entries(AGENT_ROSTER).map(([role, spec]) => {
      const line = String(spec.hint || '').trim().split('\n').find((l) => l.startsWith('Specialist:')) || '';
      return { role, profile: spec.profile, description: line.replace(/^Specialist:\s*/, '') || role };
    }),
    specialists: Object.entries(SPECIALISTS).map(([name, spec]) => ({ name, profile: spec.profile, indicator: spec.indicator || name })),
  }));

  // ── cross-session recall ──────────────────────────────────────────────

  add('GET', '/api/search', ({ query }) => {
    if (!sessionSearch.isAvailable()) return { available: false, groups: [] };
    const q = String(query.q || '').trim();
    if (!q) return { available: true, groups: [] };
    const hits = sessionSearch.searchTurns(q, { limit: 50 });
    const groups = sessionSearch.expandHits(hits, 0).map((g) => ({
      sessionId: g.sessionId, startedAt: g.startedAt, workspace: g.workspace,
      hits: g.hits.slice(0, 6).map((h) => ({ role: h.role, snippet: h.snippet })),
    }));
    return { available: true, total: hits.length, groups };
  });
  add('GET', '/api/sessions', () => {
    if (!sessionSearch.isAvailable()) return { available: false, sessions: [], stats: sessionSearch.dbStats() };
    return { available: true, sessions: sessionSearch.listSessions({ limit: 40 }), stats: sessionSearch.dbStats() };
  });
  add('GET', '/api/sessions/:id', ({ params }) => {
    if (!sessionSearch.isAvailable()) throw new HttpError(404, 'session search unavailable');
    return { turns: sessionSearch.getSessionTurns(params.id, { limit: 300 }) };
  });

  // ── edits (review changes) ────────────────────────────────────────────

  add('GET', '/api/edits', () => ({
    edits: getEdits().map((e, i) => {
      const rel = path.relative(ws(), e.filePath);
      const shown = rel.startsWith('..') ? e.filePath : rel;
      let diff = null;
      try { diff = e.oldContent == null ? newFileDiff(e.newContent, shown) : unifiedDiff(e.oldContent, e.newContent, shown); } catch {}
      return { index: i, path: shown, tool: e.tool, created: e.oldContent == null, timestamp: e.timestamp, diff: diff ? diff.slice(0, 200 * 1024) : null };
    }),
  }));
  add('DELETE', '/api/edits', () => { clearEdits(); return { ok: true }; });
  // Undo one recorded edit by restoring the content it replaced.
  add('POST', '/api/edits/:index/revert', ({ params }) => {
    const e = getEdits()[Number(params.index)];
    if (!e) throw new HttpError(404, 'edit not found');
    const current = fs.existsSync(e.filePath) ? fs.readFileSync(e.filePath, 'utf8') : null;
    if (current !== e.newContent) throw new HttpError(409, 'file changed since this edit — revert it by hand');
    if (e.oldContent == null) fs.rmSync(e.filePath, { force: true });
    else fs.writeFileSync(e.filePath, e.oldContent);
    audit.append({ kind: 'edit-reverted', path: e.filePath, via: 'web' });
    return { ok: true };
  });

  // ── audit log ─────────────────────────────────────────────────────────

  add('GET', '/api/audit', ({ query }) => {
    const limit = Math.max(1, Math.min(1000, Number(query.limit) || 200));
    const p = audit.logPath();
    let events = [];
    try {
      const st = fs.statSync(p);
      const size = Math.min(st.size, 512 * 1024);
      const fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, st.size - size);
      fs.closeSync(fd);
      const lines = buf.toString('utf8').split('\n').filter(Boolean);
      events = lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
    } catch {}
    return { path: p, events };
  });

  // ── maintenance: glossary, history, completions ───────────────────────

  add('POST', '/api/glossary/update', async () => {
    const { updateGlossary } = require('../glossary');
    const origOut = process.stdout.write;
    let log = '';
    process.stdout.write = (s) => { log += String(s); return true; };
    try { await updateGlossary({ debug: false }); } finally { process.stdout.write = origOut; }
    app.chat.reloadGlossary();
    return { ok: true, log: log.trim(), status: glossaryStatus() };
  });
  add('POST', '/api/history/build', ({ body }) => {
    const hist = require('../history-parser');
    const files = Array.isArray(body.files) && body.files.length ? body.files.map(String) : hist.autoDetectHistoryFiles();
    if (!files.length) throw new HttpError(400, 'no shell history files found');
    const freq = hist.buildFreqMap(files);
    const saved = hist.saveFreqMap(freq);
    return { ok: true, files, unique: Object.keys(freq).length, total: Object.values(freq).reduce((a, b) => a + b, 0), saved };
  });
  add('GET', '/api/completions/:shell', ({ params }) => {
    const { generate } = require('../completions');
    try { return { shell: params.shell, script: generate(params.shell) }; }
    catch (e) { throw new HttpError(400, e.message); }
  });

  // ── voice (server-side Whisper / Kokoro; browser falls back to Web Speech)

  add('GET', '/api/voice/status', async ({ query }) => {
    const f = features();
    const out = { stt: { installed: f.stt, cached: false }, tts: { installed: f.tts, cached: false }, voices: [] };
    if (f.stt) { try { out.stt.cached = require('../services/stt').isCached(); } catch {} }
    if (f.tts) {
      try {
        const tts = require('../services/tts');
        out.tts.cached = tts.isCached();
        if (query.voices === '1') out.voices = await tts.listVoices();
      } catch (e) { out.tts.error = String(e.message || e); }
    }
    return out;
  });
  add('POST', '/api/voice/transcribe', async ({ raw, query }) => {
    if (!features().stt) throw new HttpError(501, 'server speech-to-text not installed (npm run setup:voice)');
    if (!raw || raw.length < 1000) return { text: '' };
    const tmp = path.join(os.tmpdir(), `shmakk-web-stt-${process.pid}-${Date.now()}.wav`);
    fs.writeFileSync(tmp, raw);
    try {
      const { transcribe } = require('../services/stt');
      const text = await transcribe(tmp, { language: query.language || app.settings.voiceLanguage || 'english' });
      return { text: /^[\s.,;:!?]*$/.test(text) ? '' : text };
    } finally {
      try { fs.rmSync(tmp, { force: true }); } catch {}
    }
  });
  add('POST', '/api/voice/speak', async ({ body }) => {
    if (!features().tts) throw new HttpError(501, 'server text-to-speech not installed (npm run setup:voice)');
    const text = String(body.text || '').trim().slice(0, 4000);
    if (!text) throw new HttpError(400, 'empty text');
    const tts = require('../services/tts');
    const voice = body.voice || app.settings.ttsVoice || process.env.SHMAKK_TTS_VOICE || 'af_heart';
    const { audioPath } = await tts.generate(text, { voice });
    const data = fs.readFileSync(audioPath);
    try { fs.rmSync(audioPath, { force: true }); } catch {}
    return { __binary: data, contentType: 'audio/wav' };
  });

  // ── GitHub: account, repositories, cloud sessions ─────────────────────

  add('GET', '/api/github', () => github.status());
  add('POST', '/api/github/connect', ({ body }) => github.connect(body.token));
  add('POST', '/api/github/disconnect', () => github.disconnect());
  add('POST', '/api/github/device/start', () => github.deviceStart());
  add('POST', '/api/github/device/poll', ({ body }) => github.devicePoll(String(body.deviceCode || '')));
  add('GET', '/api/github/repos', ({ query }) => github.listRepos({ q: query.q || '', refresh: query.refresh === '1' }));
  add('GET', '/api/github/branches', ({ query }) => github.listBranches(query.repo));

  // Clone a repository into its own workspace and open a conversation on it.
  add('POST', '/api/github/sessions', async ({ body }) => {
    const prompt = String(body.prompt || '').trim();
    const { dir, repo } = await github.prepareWorkspace({ repo: body.repo, branch: body.branch || '', newBranch: body.newBranch || '', label: prompt || body.newBranch });
    const conv = app.chat.create({ title: prompt ? undefined : `${repo.fullName} · ${repo.branch}`, workspace: dir, repo });
    app.setWorkspace(dir);
    if (prompt) await app.chat.send(conv.id, prompt, { mode: 'ask' });
    return app.chat.snapshot(conv.id);
  });

  const repoConv = (id) => {
    const conv = app.chat.get(id);
    if (!conv) throw new HttpError(404, 'conversation not found');
    if (!conv.repo) throw new HttpError(400, 'not a GitHub session');
    return conv;
  };
  add('GET', '/api/github/sessions/:id', async ({ params }) => {
    const conv = repoConv(params.id);
    const status = await github.gitStatus(conv.workspace);
    if (status.branch && status.branch !== conv.repo.branch) { conv.repo.branch = status.branch; app.chat.update(conv.id, {}); }
    const pr = status.branch !== conv.repo.baseBranch ? await github.findPullRequest(conv.repo.fullName, status.branch) : null;
    return { repo: conv.repo, status, pr };
  });
  add('POST', '/api/github/sessions/:id/push', async ({ params, body }) => {
    const conv = repoConv(params.id);
    if (conv.run) throw new HttpError(409, 'wait for the current run to finish');
    return github.commitAndPush(conv.workspace, { message: body.message });
  });
  add('POST', '/api/github/sessions/:id/pr', async ({ params, body }) => {
    const conv = repoConv(params.id);
    const status = await github.gitStatus(conv.workspace);
    if (status.branch === conv.repo.baseBranch) throw new HttpError(400, 'create a branch first — this session is on the base branch');
    return github.createPullRequest(conv.repo.fullName, { head: status.branch, base: body.base || conv.repo.baseBranch, title: body.title, body: body.body, draft: body.draft });
  });

  // ── lifecycle (--exit) ────────────────────────────────────────────────

  add('POST', '/api/shutdown', () => { setTimeout(() => app.shutdown(), 150); return { ok: true }; });

  async function handle(method, pathname, ctx) {
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      try {
        return { found: true, result: await r.handler({ ...ctx, params }) };
      } catch (e) {
        if (e instanceof GitHubError) throw new HttpError(e.status === 401 ? 400 : e.status, e.message);
        throw e;
      }
    }
    return { found: false };
  }

  return { handle, providerInfo, features, statusInfo };
}

module.exports = { createApi, HttpError, publicSettings };

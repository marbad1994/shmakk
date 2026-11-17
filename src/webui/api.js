// REST API for the web UI. Each route is the GUI equivalent of a CLI flag or
// self-command; the heavy lifting stays in the same modules the CLI uses.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const skills = require('../skills');
const memory = require('../memory');
const rules = require('../rules');
const planner = require('../planner');
const workflows = require('../workflows');
const ssh = require('../ssh');
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
const design = require('./design');
const { AutomationError } = require('./automations');
const store = require('./store');
const artefacts = require('./artefacts');
const capture = require('../services/capture');
const { registerWorkRoutes } = require('./work-routes');

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
// What the browser gets to see of the settings: no token, no API key, no
// cloud token (the node proxy injects it server-side).
function publicSettings(settings) {
  const { token: _t, provider: _p, github: _g, cloud: _c, ...rest } = settings;
  if (!_c) return rest;
  return { ...rest, cloud: { ..._c, token: undefined } };
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

  function envModelList() {
    return String(process.env.SHMAKK_MODELS || process.env.SHMAKK_REGISTRY || '')
      .split(',').map((m) => m.trim()).filter(Boolean);
  }

  // The model registry is ~/.config/shmakk/endpoints.json: every entry in it is
  // a model the user can pick. Its data is the source of truth for the model
  // selectors; plain SHMAKK_* env vars are only the fallback.
  function registryModels() {
    let registry = null;
    try { registry = endpoints.getModelRegistry(ws()); } catch { registry = null; }
    const all = (registry && registry.models) || {};
    const names = [registry && registry.main, ...Object.keys(all)]
      .filter((n, i, arr) => n && all[n] && arr.indexOf(n) === i);
    return names.map((name) => {
      const cfg = all[name];
      return {
        name,
        model: cfg.model || name,
        provider: cfg.provider || null,
        vision: !!cfg.vision,
        hasApiKey: !!cfg.api_key,
        default: name === (registry.main || null),
        fast: name === (registry.fast || null),
      };
    });
  }

  function providerInfo() {
    const active = endpoints.getCurrentEndpoint();
    const registry = registryModels();
    // Endpoints can list the models they expose as a comma-separated string.
    const endpointList = String(active?.models || active?.registry || '')
      .split(',').map((m) => m.trim()).filter(Boolean);
    const key = active?.api_key || process.env.SHMAKK_API_KEY || '';
    const model = active?.model || process.env.SHMAKK_MODEL || '';
    // Selectable models: the active model, then everything the registry (or, in
    // its absence, the endpoint list / the environment) says exists.
    const models = [];
    const push = (m) => { const v = String(m || '').trim(); if (v && !models.includes(v)) models.push(v); };
    push(model);
    for (const entry of registry) push(entry.model);
    endpointList.forEach(push);
    if (!registry.length && !endpointList.length) envModelList().forEach(push);
    if (!models.length) push(process.env.SHMAKK_MODEL);
    return {
      configured: llm.isConfigured(),
      endpoint: endpoints.getCurrentEndpointName(),
      endpoints: endpoints.listEndpoints(ws()),
      baseUrl: active?.base_url || process.env.SHMAKK_BASE_URL || '',
      model,
      apiKeyMasked: maskKey(key),
      hasApiKey: !!key,
      headers: active?.headers || process.env.SHMAKK_HEADERS || '',
      modelList: endpointList.join(', ') || envModelList().join(', '),
      models,
      registry,
      modelsSource: registry.length ? 'registry' : endpointList.length ? 'endpoint' : 'env',
      vision: llm.supportsVision(),
      visionFromEndpoint: !!endpoints.getCurrentEndpoint(),
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
      capture: capture.isAvailable(),
      preview: !!app.preview,
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

  // Chats filed under a project are shown in the project view, not in the
  // sidebar history, so `?project=none` returns only the ones with no project.
  // Clients that send no filter keep getting every chat; `?project=<id>`
  // narrows the list to a single project.
  const historyList = (query) => {
    const p = query && query.project;
    const own = typeof p !== 'string' || !p || p === 'all' ? app.chat.list() : app.chat.list({ project: p });
    // Remote sessions (exposed by desktop nodes) are listed alongside the
    // cloud's own conversations so they can be opened and driven from here.
    const remotes = (app.nodes && app.nodes.remoteMetaList()) || [];
    if (!remotes.length) return own;
    const list = own.filter((c) => !remotes.some((r) => r.id === c.id)).concat(remotes);
    return list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  };

  add('GET', '/api/bootstrap', ({ query }) => ({
    version: app.version,
    workspace: ws(),
    home: os.homedir(),
    platform: process.platform,
    settings: publicSettings(app.settings),
    provider: providerInfo(),
    profiles: Object.entries(PRESETS).map(([name, p]) => ({ name, ...p })),
    features: features(),
    hosted: !!app.hosted,
    projects: app.projects.list(),
    conversations: historyList(query),
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
      model: p.model || null, modelList: p.modelList || null, profile: app.settings.profile || 'auto',
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
    if ('systemPrompt' in body) app.settings.systemPrompt = typeof body.systemPrompt === 'string' ? body.systemPrompt.slice(0, 20000) : '';
    if ('workspacesRoot' in body) app.settings.workspacesRoot = body.workspacesRoot ? String(body.workspacesRoot).trim() || null : null;
    if ('transfer' in body) app.settings.transfer = body.transfer === 'move' ? 'move' : 'copy';
    if ('cloud' in body) {
      const c = body.cloud;
      const prev = app.settings.cloud || {};
      if (!c || c === null) {
        app.settings.cloud = null;
      } else {
        app.settings.cloud = {
          enabled: c.enabled !== false,
          url: c.url != null ? String(c.url).trim().replace(/\/+$/, '') : prev.url,
          token: (typeof c.token === 'string' && c.token.trim()) ? c.token.trim() : (prev.token || null),
          label: c.label != null ? String(c.label).slice(0, 60) : prev.label,
          sshHost: c.sshHost != null ? String(c.sshHost).slice(0, 120) : prev.sshHost,
          remotePort: c.remotePort != null ? Number(c.remotePort) : prev.remotePort,
          remoteBind: c.remoteBind != null ? String(c.remoteBind).slice(0, 40) : prev.remoteBind,
        };
      }
    }
    if (body.modelByMode && typeof body.modelByMode === 'object') {
      const cur = app.settings.modelByMode || {};
      const next = { ...cur };
      for (const k of store.MODES) {
        if (!(k in body.modelByMode)) continue;
        const v = body.modelByMode[k];
        next[k] = (v === null || v === '') ? null : String(v).slice(0, 120);
      }
      app.settings.modelByMode = next;
    }
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

  // ── managed workspaces: created as direct children of the configured root ──
  // New workspaces can only be created in the root set in Settings, never in a
  // sub-folder of it, and never elsewhere. The location is chosen in the
  // background: the caller supplies just a name.
  function workspacesRoot() {
    const raw = app.settings.workspacesRoot || process.env.SHMAKK_WORKSPACES_DIR || '';
    return raw ? path.resolve(String(raw).replace(/^~(?=$|\/)/, os.homedir())) : null;
  }
  function listWorkspaces(root) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => ({ name: e.name, path: path.join(root, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch { /* root missing or unreadable */ }
    return entries;
  }
  add('GET', '/api/workspaces', () => {
    const root = workspacesRoot();
    return { root, workspaces: root ? listWorkspaces(root) : [] };
  });
  add('POST', '/api/workspaces', ({ body }) => {
    const root = workspacesRoot();
    if (!root) throw new HttpError(400, 'Set a workspaces root in Settings first');
    const name = String(body.name || '').trim();
    if (!name) throw new HttpError(400, 'A name is required');
    if (name.length > 80) throw new HttpError(400, 'Name is too long (80 characters max)');
    if (name !== path.basename(name) || name === '.' || name === '..' || /[\\/]/.test(name) || name.includes('\0')) {
      throw new HttpError(400, 'Name must be a single folder name');
    }
    const target = path.join(root, name);
    const rel = path.relative(root, target);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new HttpError(400, 'Invalid workspace name');
    try { fs.mkdirSync(root, { recursive: true }); } catch (e) { throw new HttpError(500, `Cannot create workspaces root: ${e.message}`); }
    if (fs.existsSync(target)) throw new HttpError(409, `"${name}" already exists`);
    try { fs.mkdirSync(target); } catch (e) { throw new HttpError(500, String(e.message)); }
    app.setWorkspace(target);
    return { workspace: ws(), warning: workspaceWarning(ws()), name };
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

  // History list; `?project=none` skips chats that belong to a project.
  add('GET', '/api/conversations', ({ query }) => ({ conversations: historyList(query) }));
  add('POST', '/api/conversations', ({ body }) => {
    const project = body.projectId ? app.projects.get(body.projectId) : null;
    if (body.projectId && !project) throw new HttpError(404, 'project not found');
    const mode = store.MODES.includes(body.mode) ? body.mode : 'code';
    // A project can pin the folder its code and cowork chats work in.
    const workspace = project && project.workspace && (mode === 'code' || mode === 'cowork') && fs.existsSync(project.workspace) ? project.workspace : undefined;
    return app.chat.snapshot(app.chat.create({ title: body.title, mode, projectId: project ? project.id : null, workspace }).id);
  });
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

  // ── node federation ─────────────────────────────────────────────────────

  const nodesHub = () => app.nodes;

  // One generic proxy target resolver: "cloud" is the configured cloud node;
  // any other name is looked up in the remote-session registry.
  function proxyTarget(node) {
    if (!app.nodes) return null;
    return app.nodes.proxyTarget(node);
  }

  function transferMode(body) {
    if (body && (body.transfer === 'move' || body.transfer === 'copy')) return body.transfer;
    return app.settings.transfer === 'move' ? 'move' : 'copy';
  }

  // Re-root an extracted workspace into the node's workspaces root, avoiding
  // collisions. Returns the final directory.
  async function settleImportedWorkspace(srcDir, convData) {
    const root = workspacesRoot() || path.join(os.homedir(), 'workspaces');
    const base = path.basename(String(convData.workspace || '').replace(/[\\/]+$/, '')) || 'workspace';
    fs.mkdirSync(root, { recursive: true });
    let target = path.join(root, base);
    let n = 2;
    while (fs.existsSync(target)) target = path.join(root, `${base}-${n++}`);
    fs.mkdirSync(target, { recursive: true });
    for (const ent of await fs.promises.readdir(srcDir)) {
      await fs.promises.rename(path.join(srcDir, ent), path.join(target, ent));
    }
    return target;
  }

  // Accept a session bundle uploaded by another node. The server streams the
  // request body here (see server.js), so this never buffers the workspace.
  async function importSession(req) {
    const { unpackStream } = require('./tarball');
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'shmakk-import-'));
    try {
      const convData = await unpackStream(req, tmp);
      if (!convData) throw new HttpError(400, 'invalid session bundle');
      const wsDir = path.join(tmp, 'workspace');
      let targetWs = null;
      if (fs.existsSync(wsDir)) targetWs = await settleImportedWorkspace(wsDir, convData);
      const conv = app.chat.importConv(convData, { workspaceDir: targetWs });
      return { ok: true, conv: { id: conv.id, title: conv.title } };
    } finally {
      fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }
  app.importSession = importSession;

  add('GET', '/api/nodes', () => ({
    nodes: nodesHub() ? nodesHub().nodes() : [{ id: 'local', label: 'This computer', kind: 'local', url: '', online: true }],
    tunnel: nodesHub() ? nodesHub().tunnelStatus() : { up: false, exposed: [] },
  }));

  // Remote-session registry, called by desktop nodes over the authenticated
  // proxy. The cloud keeps `sessionId → { nodeId, endpoint, token }`.
  add('POST', '/api/remote/register', ({ body }) => {
    const b = body || {};
    const sessionId = String(b.sessionId || '').trim();
    const nodeId = String(b.nodeId || '').slice(0, 80);
    const token = String(b.token || '').slice(0, 200);
    const remotePort = Number(b.remotePort) || 0;
    if (!sessionId || !nodeId || !token || !remotePort) throw new HttpError(400, 'sessionId, nodeId, token and remotePort are required');
    if (!nodesHub()) throw new HttpError(500, 'node hub unavailable');
    nodesHub().registerRemote(sessionId, {
      nodeId,
      token,
      remotePort,
      endpoint: `${nodesHub().remoteGateway()}:${remotePort}`,
      meta: b.meta && typeof b.meta === 'object' ? b.meta : {},
    });
    return { ok: true };
  });

  add('POST', '/api/remote/unregister', ({ body }) => {
    const sessionId = String((body || {}).sessionId || '').trim();
    if (nodesHub()) nodesHub().unregisterRemote(sessionId);
    return { ok: true };
  });

  // Local → cloud: stream this conversation's bundle to the cloud node.
  add('POST', '/api/conversations/:id/push', async ({ params, body }) => {
    const cfg = nodesHub() && nodesHub().cloudConfig();
    if (!cfg) throw new HttpError(400, 'cloud not configured');
    const exp = app.chat.exportConv(params.id);
    if (!exp) throw new HttpError(404, 'conversation not found');
    const { packBundle } = require('./tarball');
    const stream = packBundle(exp.conv, exp.workspaceDir);
    const res = await nodesHub().postStream({ url: cfg.url, token: cfg.token }, '/api/import/session', stream);
    const buf = Buffer.from(await res.arrayBuffer());
    let result = null;
    try { result = JSON.parse(buf.toString('utf8')); } catch { /* non-JSON error body */ }
    if (res.status >= 300 || !result || !result.ok) throw new HttpError(res.status, (result && result.error) || 'import failed');
    if (transferMode(body) === 'move') app.chat.remove(params.id);
    return { ok: true, conv: { id: result.conv.id, node: 'cloud' } };
  });

  // Cloud → local: download a cloud conversation's bundle and import it here.
  add('POST', '/api/conversations/:id/pull', async ({ params, body }) => {
    const cfg = nodesHub() && nodesHub().cloudConfig();
    if (!cfg) throw new HttpError(400, 'cloud not configured');
    const res = await nodesHub().getStream({ url: cfg.url, token: cfg.token }, `/api/conversations/${params.id}/export`);
    if (res.status >= 300) {
      const buf = Buffer.from(await res.arrayBuffer());
      let msg = 'export failed';
      try { msg = JSON.parse(buf.toString('utf8')).error || msg; } catch { /* not JSON */ }
      throw new HttpError(res.status, msg);
    }
    const { unpackStream } = require('./tarball');
    const { Readable } = require('stream');
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'shmakk-import-'));
    let conv;
    try {
      const convData = await unpackStream(Readable.fromWeb(res.body), tmp);
      if (!convData) throw new HttpError(400, 'invalid session bundle');
      const wsDir = path.join(tmp, 'workspace');
      const targetWs = fs.existsSync(wsDir) ? await settleImportedWorkspace(wsDir, convData) : null;
      const isMove = transferMode(body) === 'move';
      conv = app.chat.importConv(convData, { workspaceDir: targetWs, newId: !isMove });
    } finally {
      fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
    if (transferMode(body) === 'move') {
      await nodesHub().proxy({ url: cfg.url, token: cfg.token }, 'DELETE', `/api/conversations/${params.id}`, { body: {} }).catch(() => {});
    }
    return { ok: true, conv: { id: conv.id, node: 'local' } };
  });

  // Export a conversation's bundle as a streaming tar (consumed by pull).
  add('GET', '/api/conversations/:id/export', ({ params }) => {
    const exp = app.chat.exportConv(params.id);
    if (!exp) throw new HttpError(404, 'conversation not found');
    const { packBundle } = require('./tarball');
    return { __stream: packBundle(exp.conv, exp.workspaceDir), contentType: 'application/x-shmakk-bundle' };
  });

  // Continue a paused conversation (after a mid-conversation move).
  add('POST', '/api/conversations/:id/resume', async ({ params }) => {
    const r = await app.chat.resume(params.id);
    if (!r || r.ok === false) throw new HttpError(409, (r && r.error) || 'cannot resume');
    return { ok: true };
  });

  // Expose a local conversation to the cloud node over the SSH reverse tunnel.
  // The cloud keeps a registry entry and proxies traffic back through the tunnel.
  add('POST', '/api/conversations/:id/expose', async ({ params }) => {
    if (!nodesHub()) throw new HttpError(500, 'node hub unavailable');
    const meta = app.chat.list().find((c) => c.id === params.id);
    if (!meta) throw new HttpError(404, 'conversation not found');
    const r = await nodesHub().expose(params.id, meta);
    if (r && r.ok === false) throw new HttpError(400, r.error || 'expose failed');
    return { ok: true, exposed: true };
  });

  add('POST', '/api/conversations/:id/unexpose', async ({ params }) => {
    if (nodesHub()) await nodesHub().unexpose(params.id);
    return { ok: true, exposed: false };
  });

  // ── artefacts ──────────────────────────────────────────────────────────
  // Files the AI made outside the project, listed across every workspace.

  add('GET', '/api/artefacts', ({ query }) => ({
    artefacts: artefacts.list({ q: query.q, mode: query.mode }),
  }));
  add('POST', '/api/artefacts', ({ body }) => {
    const b = body || {};
    let art;
    if (b.path) {
      let abs = String(b.path);
      if (!path.isAbsolute(abs) && b.convId) {
        const conv = app.chat.get(b.convId);
        if (conv) abs = path.join(app.chat.roots(conv)[0], abs);
      }
      art = artefacts.fromFile(abs, { name: b.name, mode: b.mode, convId: b.convId || null, workspace: b.workspace || null, note: b.note });
    } else if (typeof b.content === 'string') {
      art = artefacts.create({ name: b.name, content: b.content, mimeType: b.mimeType, mode: b.mode, convId: b.convId || null, workspace: b.workspace || null, note: b.note });
    } else {
      throw new HttpError(400, 'provide path or content');
    }
    app.broadcast({ t: 'artefacts.changed' });
    return art;
  });
  add('GET', '/api/artefacts/:id', ({ params }) => {
    const a = artefacts.get(params.id);
    if (!a) throw new HttpError(404, 'artefact not found');
    return a;
  });
  add('PATCH', '/api/artefacts/:id', ({ params, body }) => {
    const a = artefacts.update(params.id, body || {});
    if (!a) throw new HttpError(404, 'artefact not found');
    app.broadcast({ t: 'artefacts.changed' });
    return a;
  });
  add('DELETE', '/api/artefacts/:id', ({ params }) => {
    const ok = artefacts.remove(params.id);
    app.broadcast({ t: 'artefacts.changed' });
    return { ok };
  });
  add('POST', '/api/artefacts/:id/open', ({ params }) => {
    const a = artefacts.get(params.id);
    if (!a) throw new HttpError(404, 'artefact not found');
    const p = a.path;
    if (!p || !fs.existsSync(p)) throw new HttpError(404, 'the file no longer exists on disk');
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', p] : [p];
    try { execFile(opener, args, { stdio: 'ignore' }, () => {}); } catch {}
    return { ok: true };
  });
  add('POST', '/api/artefacts/:id/discuss', async ({ params, body }) => {
    const a = artefacts.get(params.id);
    if (!a) throw new HttpError(404, 'artefact not found');
    const text = String((body && body.text) || '').trim();
    if (!text) throw new HttpError(400, 'ask something about the file');
    const conv = app.chat.create({ mode: 'chat', title: a.name });
    const attachment = { name: a.name, size: a.size, mimeType: a.mimeType };
    if (a.binary && /^image\//.test(a.mimeType)) attachment.data = a.content;
    else attachment.content = a.content || '';
    const r = await app.chat.send(conv.id, text, { mode: 'ask', attachments: [attachment] });
    if (!r.ok) throw new HttpError(409, r.error);
    return app.chat.snapshot(conv.id);
  });

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
        description: String(s.description || '').replace(/^['"]/, '').replace(/['"]$/, ''), active: !!(active && active.name === s.name), bytes: s.bytes || 0,
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
    const name = skills.safeName(body.name);
    // Catalog entries are keyed by their frontmatter name, which can differ from
    // the file name (dev-adr-review.md → "adr-review"), so load from the real file.
    const entry = skills.listAllSkills(ws()).find((s) => s.name === name);
    let res;
    if (body.global) res = skills.loadSkillGlobally(body.name);
    else if (entry && entry.scope !== 'workspace' && entry.localPath && fs.existsSync(entry.localPath)) {
      res = skills.importSkillContent(fs.readFileSync(entry.localPath, 'utf8'), entry.localPath, ws(), name);
    } else res = skills.loadSkillToWorkspace(body.name, ws());
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
  // Create / upload: the browser sends the finished markdown (frontmatter + body).
  add('POST', '/api/skills/import', ({ body }) => {
    const raw = String(body.raw || '');
    if (!raw.trim()) throw new HttpError(400, 'skill content is empty');
    const res = body.global ? skills.importGlobalSkillContent(raw, 'web', body.name) : skills.importSkillContent(raw, 'web', ws(), body.name);
    if (!res.ok) throw new HttpError(400, res.error);
    return res;
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

  // ── remote hosts (SSH) ────────────────────────────────────────────────
  // The same files the agent reads: .shmakk/hosts.json (this workspace) and
  // ~/.config/shmakk/hosts.json (everywhere). Aliases imported from
  // ~/.ssh/config are listed read-only.

  add('GET', '/api/ssh', () => {
    const paths = ssh.configFiles(ws());
    const local = {
      workspace: paths.workspace ? ssh.readHostFile(paths.workspace) : { hosts: {} },
      global: ssh.readHostFile(paths.global),
    };
    const cfg = ssh.loadHostConfig(ws());
    const hosts = Object.entries(cfg.hosts)
      .map(([name, entry]) => {
        const source = local.workspace.hosts[name] ? 'workspace' : local.global.hosts[name] ? 'global' : 'config';
        return {
          name,
          host: entry.host || name,
          port: entry.port || 22,
          auto_approve: !!entry.auto_approve,
          timeout_sec: entry.timeout_sec || cfg.default_timeout_sec,
          source,
          editable: source !== 'config',
        };
      })
      .sort((a, b) => Number(a.source === 'config') - Number(b.source === 'config') || a.name.localeCompare(b.name));
    return {
      hosts,
      paths,
      allowSshConfig: cfg.allow_ssh_config,
      defaultTimeoutSec: cfg.default_timeout_sec,
      sshConfigPath: path.join(os.homedir(), '.ssh', 'config'),
    };
  });

  add('PUT', '/api/ssh', ({ body }) => {
    try {
      return { ok: true, allowSshConfig: ssh.setAllowSshConfig(ws(), !!body.allowSshConfig) };
    } catch (e) { throw new HttpError(400, e.message); }
  });

  add('PUT', '/api/ssh/:name', ({ params, body }) => {
    const scope = body.scope === 'workspace' ? 'workspace' : 'global';
    try {
      ssh.saveHost(scope, ws(), params.name, body);
    } catch (e) { throw new HttpError(400, e.message); }
    return { ok: true, scope };
  });

  add('DELETE', '/api/ssh/:name', ({ params, query }) => {
    const scope = query.scope === 'workspace' ? 'workspace' : 'global';
    let removed = false;
    try { removed = ssh.deleteHost(scope, ws(), params.name); } catch (e) { throw new HttpError(400, e.message); }
    if (!removed) throw new HttpError(404, `no host named "${params.name}" in the ${scope} config`);
    return { ok: true };
  });

  add('POST', '/api/ssh/test', async ({ body }) => ssh.testHost(body || {}));

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

  // ── capture: screen + audio show-and-tell recorder ────────────────────

  add('GET', '/api/capture', () => ({
    capabilities: capture.detect(),
    sessions: app.capture.list(),
  }));

  add('POST', '/api/capture', async ({ body }) => {
    const d = capture.detect();
    if (!d.available) throw new HttpError(501, d.reasons.join('; ') || 'capture is not available on this machine');
    const meta = await app.capture.start({
      fps: body.fps,
      width: body.width,
      height: body.height,
      traceAudio: body.traceAudio,
      outputDir: body.outputDir,
    });
    return meta;
  });

  add('GET', '/api/capture/:id', ({ params }) => {
    const m = app.capture.get(params.id);
    if (!m) throw new HttpError(404, 'capture session not found');
    return m;
  });

  // Return the persisted frames summary (`<id>.frames.json`) written by
  // src/services/frames.js. The `frames` field is an ordered array; the 1-based
  // evidence frame numbers produced downstream are positions into this array,
  // so the review UI can map "frame N" to frames[N-1].file (frame_000.png).
  add('GET', '/api/capture/:id/frames', ({ params }) => {
    const m = app.capture.get(params.id);
    if (!m) throw new HttpError(404, 'capture session not found');
    const file = path.resolve(m.paths.frames);
    let stat;
    try { stat = fs.statSync(file); } catch { throw new HttpError(404, 'frames not found'); }
    if (!stat.isFile()) throw new HttpError(404, 'frames not found');
    let summary;
    try { summary = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { throw new HttpError(500, 'frames summary is malformed'); }
    return summary;
  });

  // Serve an extracted frame PNG/JPG. Frames live on disk under the session's
  // framesDir and are not exposed any other way, so the browser needs a route.
  add('GET', '/api/capture/:id/frames/:file', ({ params }) => {
    const m = app.capture.get(params.id);
    if (!m) throw new HttpError(404, 'capture session not found');
    const name = path.basename(params.file);
    // `:file` is a single path segment, but decoding can still smuggle in a
    // slash (`%2F`), so insist the decoded name round-trips and matches the
    // exact frame naming scheme (frame_000.png) before touching the disk.
    if (name !== params.file || !/^frame_\d{3}\.(png|jpg)$/.test(name)) {
      throw new HttpError(400, 'invalid frame name');
    }
    const dir = path.resolve(m.paths.framesDir);
    const file = path.resolve(dir, name);
    if (!file.startsWith(dir + path.sep)) throw new HttpError(400, 'invalid frame name');
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new HttpError(404, 'frame not found');
    return {
      __binary: fs.readFileSync(file),
      contentType: name.endsWith('.jpg') ? 'image/jpeg' : 'image/png',
    };
  });

  add('POST', '/api/capture/:id/pause', async ({ params }) => app.capture.pause(params.id));
  add('POST', '/api/capture/:id/resume', async ({ params }) => app.capture.resume(params.id));
  add('POST', '/api/capture/:id/stop', async ({ params }) => app.capture.stop(params.id));
  add('POST', '/api/capture/:id/transcribe', async ({ params, body }) => {
    if (!features().stt) throw new HttpError(501, 'server speech-to-text not installed (npm run setup:voice)');
    return app.capture.transcribe(params.id, { language: body && body.language });
  });
  add('POST', '/api/capture/:id/analyze', async ({ params, body }) => app.capture.analyze(params.id, body || {}));
  add('POST', '/api/capture/:id/plan', async ({ params, body }) => app.capture.plan(params.id, body || {}));
  add('POST', '/api/capture/:id/automation', async ({ params, body }) => app.capture.automation(params.id, body || {}));
  add('DELETE', '/api/capture/:id', async ({ params }) => ({ ok: await app.capture.remove(params.id) }));

  // ── projects ──────────────────────────────────────────────────────────

  const projectView = (p) => {
    const convs = app.chat.list().filter((c) => c.projectId === p.id);
    return { ...p, conversations: convs.length, modes: Array.from(new Set(convs.map((c) => c.mode))) };
  };
  add('GET', '/api/projects', () => ({ projects: app.projects.list().map(projectView) }));
  add('POST', '/api/projects', ({ body }) => { const p = app.projects.create(body || {}); app.broadcast({ t: 'projects.changed' }); return projectView(p); });
  add('GET', '/api/projects/:id', ({ params }) => {
    const p = app.projects.get(params.id);
    if (!p) throw new HttpError(404, 'project not found');
    return { project: projectView(p), conversations: app.chat.list().filter((c) => c.projectId === p.id), automations: app.automations.list().filter((a) => a.projectId === p.id) };
  });
  add('PATCH', '/api/projects/:id', ({ params, body }) => {
    if (body && body.workspace && !(fs.existsSync(body.workspace) && fs.statSync(body.workspace).isDirectory())) throw new HttpError(400, 'workspace folder not found');
    const p = app.projects.update(params.id, body || {});
    if (!p) throw new HttpError(404, 'project not found');
    app.broadcast({ t: 'projects.changed' });
    return projectView(p);
  });
  // Deleting a project keeps its conversations; they just leave the project.
  add('DELETE', '/api/projects/:id', ({ params }) => {
    for (const c of app.chat.list().filter((x) => x.projectId === params.id)) app.chat.update(c.id, { projectId: null });
    for (const a of app.automations.list().filter((x) => x.projectId === params.id)) app.automations.update(a.id, { projectId: null });
    const ok = app.projects.remove(params.id);
    app.broadcast({ t: 'projects.changed' });
    return { ok };
  });

  // ── design mode: files, versions, preview links ───────────────────────

  const designConv = (id) => {
    const conv = app.chat.get(id);
    if (!conv) throw new HttpError(404, 'conversation not found');
    if (conv.mode !== 'design') throw new HttpError(400, 'not a design conversation');
    return conv;
  };
  add('GET', '/api/design/:id', ({ params }) => {
    const conv = designConv(params.id);
    const dir = design.ensureDir(conv.id);
    return { base: `/artifact/${conv.id}/${design.sign(app.artifactSecret, conv.id)}/`, dir, files: design.listFiles(dir), versions: design.listVersions(dir) };
  });
  add('GET', '/api/design/:id/file', ({ params, query }) => {
    const conv = designConv(params.id);
    const hit = design.resolveArtifact(app.artifactSecret, conv.id, design.sign(app.artifactSecret, conv.id), String(query.path || ''));
    if (!hit) throw new HttpError(404, 'file not found');
    return { path: query.path, content: readText(hit.file) };
  });
  add('POST', '/api/design/:id/restore', ({ params, body }) => {
    const conv = designConv(params.id);
    if (conv.run) throw new HttpError(409, 'wait for the current run to finish');
    if (!design.restore(design.ensureDir(conv.id), body.version)) throw new HttpError(404, 'version not found');
    app.broadcast({ t: 'design.changed', convId: conv.id });
    return { ok: true };
  });
  add('PUT', '/api/design/:id/file', ({ params, body }) => {
    const conv = designConv(params.id);
    if (conv.run) throw new HttpError(409, 'wait for the current run to finish');
    if (!design.writeFile(design.ensureDir(conv.id), String(body.path || ''), String(body.content ?? ''))) {
      throw new HttpError(404, 'file not found');
    }
    return { ok: true };
  });
  add('POST', '/api/design/:id/snapshot', ({ params }) => {
    const conv = designConv(params.id);
    if (conv.run) throw new HttpError(409, 'wait for the current run to finish');
    const v = design.snapshot(design.ensureDir(conv.id), 'edited in the canvas');
    if (v) app.broadcast({ t: 'design.changed', convId: conv.id });
    return { ok: true, version: v && v.n };
  });
  add('POST', '/api/design/:id/ai', async ({ params, body }) => {
    const conv = designConv(params.id);
    if (conv.run) throw new HttpError(409, 'wait for the current run to finish');
    const prompt = String(body.prompt || '').trim();
    if (!prompt) throw new HttpError(400, 'empty prompt');
    const el = body.element && typeof body.element === 'object' ? body.element : null;
    const r = await app.chat.send(conv.id, prompt, { mode: 'ask', hint: design.elementEditHint(String(body.file || ''), el) });
    if (!r.ok) throw new HttpError(409, r.error);
    return { ok: true };
  });

  // ── cowork: automations (manual, scheduled, webhook) ──────────────────

  add('GET', '/api/automations', () => ({
    automations: app.automations.list(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    templates: workflows.listWorkflows().map((w) => {
      const full = workflows.getWorkflow(w.id);
      return { id: w.id, name: w.id.replace(/-/g, ' '), description: w.description, steps: (full?.steps || []).map((s) => ({ title: s.role, prompt: s.task.replace(/\{input\}/g, 'the task described in this automation') })) };
    }),
  }));
  add('POST', '/api/automations', ({ body }) => app.automations.create(body || {}));
  add('PATCH', '/api/automations/:id', ({ params, body }) => {
    const a = app.automations.update(params.id, body || {});
    if (!a) throw new HttpError(404, 'automation not found');
    return a;
  });
  add('DELETE', '/api/automations/:id', ({ params }) => ({ ok: app.automations.remove(params.id) }));
  add('POST', '/api/automations/:id/run', ({ params }) => app.automations.run(params.id, { trigger: 'manual' }));
  add('GET', '/api/automations/:id/webhook', ({ params }) => {
    const p = app.automations.webhookPath(params.id);
    if (!p) throw new HttpError(404, 'this automation has no webhook trigger');
    return { path: p };
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

  registerWorkRoutes(add, app, { HttpError, ws });

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
        if (e instanceof AutomationError) throw new HttpError(400, e.message);
        throw e;
      }
    }
    return { found: false };
  }

  return { handle, providerInfo, features, statusInfo };
}

module.exports = { createApi, HttpError, publicSettings };

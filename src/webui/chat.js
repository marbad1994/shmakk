// Chat engine for the web UI.
//
// This is the GUI counterpart of ./session.js: the same pipeline
// (self-commands → correction → team / plan-first / single agent, tool
// confirmations, review mode) but driven by messages instead of a PTY, and
// reporting progress as structured transcript items rather than ANSI text.
//
// A conversation's transcript is a flat list of items. The server owns it:
// every change is broadcast as an upsert so any number of windows stay in
// sync, and a page reload simply re-reads the list.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { setMaxListeners } = require('events');

const { correct } = require('../correction');
const { runAgent, clearTaskJournal, summarizeToolResult } = require('../agent');
const { TOOLS, dispatchTool } = require('../tools');
const { makeClientForModel, modelFor, userContentWithImages, stripImageBlocks, getReasoningOptions } = require('../llm');
const { renderMemoryForPrompt } = require('../memory');
const design = require('./design');
const { buildContext } = require('./projects');
const { coworkTools, COWORK_HINT } = require('./automations');
const { route: routeToSpecialist } = require('../coordinator');
const { shouldPlan, generatePlan } = require('../planner');
const { clearIndex } = require('../workspace-index');
const { loadGlossary } = require('../glossary');
const { isConfigured } = require('../llm');
const { getEdits, clearEdits } = require('../edit-tracker');
const { unifiedDiff, newFileDiff } = require('../edit-viewer');
const { matchSelfCommand, executeSelfCommand } = require('../self-commands');
const { runTeam, looksMultiDomain } = require('../team');
const { classifyRunCommand } = require('../safety');
const sessionSearch = require('../session-search');
const { HELP } = require('../cli');
const audit = require('../audit');
const store = require('./store');
const artefacts = require('./artefacts');

const HISTORY_MAX_ENTRIES = 30;
const MAX_SHELL_OUTPUT = 200 * 1024;
const MAX_DIFF_BYTES = 80 * 1024;
const MAX_ARG_PREVIEW = 6000;
const CWD_MARKER = '__SHMAKK_CWD__';

const TOOL_EXPLAIN = {
  read_file: 'Reads a file from your workspace to analyze it.',
  list_dir: 'Lists directory contents to explore project structure.',
  write_file: 'Creates or overwrites a file in your workspace.',
  edit_file: 'Makes a precise string replacement in an existing file.',
  make_dir: 'Creates a new directory (with parents if needed).',
  delete_file: 'Deletes a file from your workspace.',
  run: 'Runs a shell command in your workspace directory.',
  web_search: 'Searches the web for current information.',
  fetch_url: 'Fetches content from a URL.',
  browser: 'Drives the built-in automation browser.',
  remember: 'Saves a fact to long-term memory.',
};
const SAFETY_EXPLAIN = {
  safe: 'No destructive potential — reads, lists, searches, or safe shell commands.',
  uncertain: 'Could modify files or run commands with side effects.',
  unsafe: 'Potentially destructive — deletes, secrets, or commands flagged as dangerous.',
};

function isAbortError(e) {
  return e && (e.name === 'AbortError' || /aborted|paused|stopped/i.test(String(e.message || '')));
}

function stripAnsi(s) {
  return String(s || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

function trimHistory(history) {
  if (history.length <= HISTORY_MAX_ENTRIES) return history;
  let cut = history.length - HISTORY_MAX_ENTRIES;
  while (cut > 0 && history[cut].role === 'tool') cut--;
  return history.slice(cut);
}

// Did the user explicitly ask for a file to be kept as an artefact?
// ("create a report as an artefact", "save this as an artefact", …)
function artefactRequested(text) {
  const t = String(text || '').toLowerCase();
  if (!/\bartef?act/.test(t)) return false;
  return /\b(create|save|make|generate|export|write|turn)\b/.test(t);
}

function titleFrom(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim().replace(/^[$!+]\s*/, '');
  return t.length > 52 ? `${t.slice(0, 50).trimEnd()}…` : (t || 'New chat');
}

// Render attached files into a text block the model can reference. Text files
// are inlined (clipped); anything binary/unreadable is reported as such.
const MAX_ATTACHMENT_CHARS = 60000;

function attachmentBlock(a, i) {
  const label = (a && a.name) || `attachment-${i + 1}`;
  const size = a && typeof a.size === 'number' ? a.size : 0;
  const content = a && typeof a.content === 'string' ? a.content : '';
  if (a && typeof a.data === 'string' && a.data) {
    const kind = (a.mimeType || 'image').replace(/^image\//, '') || 'image';
    // No claim about it being viewable: formats the provider cannot read are
    // converted or reported separately by the image pipeline.
    return `[Attached image ${i + 1}: ${label} (${kind}, ${size} bytes)]`;
  }
  if (content) {
    const clipped = content.length > MAX_ATTACHMENT_CHARS ? `${content.slice(0, MAX_ATTACHMENT_CHARS)}\n… (truncated)` : content;
    return `[Attached file ${i + 1}: ${label}]\n<<< ${label}\n${clipped}\n${label} >>>`;
  }
  return `[Attached file ${i + 1}: ${label} (${size} bytes, binary or unreadable, not shown)]`;
}

function attachmentContext(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return '';
  return attachments.map(attachmentBlock).join('\n\n');
}

// Image attachments travel as vision content blocks, not as prompt text.
function imageAttachments(refs) {
  return (Array.isArray(refs) ? refs : [])
    .filter((a) => a && typeof a.data === 'string' && a.data)
    .map((a) => ({ mimeType: a.mimeType || 'image/png', data: a.data, dataLength: a.data.length, name: a.name || 'image' }));
}

// Keep transcripts light: large string arguments (file bodies) are clipped.
function previewArgs(args) {
  const out = {};
  for (const [k, v] of Object.entries(args || {})) {
    if (typeof v === 'string' && v.length > MAX_ARG_PREVIEW) {
      out[k] = `${v.slice(0, MAX_ARG_PREVIEW)}\n… (${v.length - MAX_ARG_PREVIEW} more characters)`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function previewResult(name, result) {
  if (!result || typeof result !== 'object') return null;
  if (name === 'run') {
    return {
      exitCode: result.exitCode,
      stdout: String(result.stdout || '').slice(-12000),
      stderr: String(result.stderr || '').slice(-6000),
    };
  }
  if (name === 'read_file') {
    return { bytes: typeof result.content === 'string' ? result.content.length : 0, mode: result.mode, truncated: !!result.truncated };
  }
  if (name === 'list_dir') return { entries: (result.entries || []).slice(0, 200) };
  if (name === 'web_search') return { results: (result.results || []).slice(0, 8) };
  if (name === 'fetch_url') return { status: result.status, title: result.title || null };
  const json = JSON.stringify(result);
  return json.length > 4000 ? { text: `${json.slice(0, 4000)}…` } : result;
}

class ChatManager {
  // ctx: { settings, saveSettings, broadcast, mcpManager, getWorkspace, onProviderChanged }
  constructor(ctx) {
    this.ctx = ctx;
    this.convs = new Map(); // id → live conversation
    this.glossary = loadGlossary();
  }

  // Per-mode model override from settings, falling back to the default model.
  _modelFor(conv) {
    const byMode = this.ctx.settings && this.ctx.settings.modelByMode;
    const override = byMode && byMode[conv.mode];
    return override || modelFor();
  }

  // ── conversation lifecycle ──────────────────────────────────────────────

  // `project` narrows the list: 'none' (or null) keeps only chats that belong to
  // no project, a project id keeps that project's chats, undefined keeps all.
  list({ project } = {}) {
    const metas = store.listConversations();
    // live conversations may be newer than what's on disk
    const byId = new Map(metas.map((m) => [m.id, m]));
    for (const c of this.convs.values()) byId.set(c.id, { ...store.metaOf(c), running: !!c.run });
    let out = Array.from(byId.values()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (project === 'none' || project === null) out = out.filter((c) => !c.projectId);
    else if (project !== undefined) out = out.filter((c) => c.projectId === project);
    return out;
  }

  // workspace/repo are set for GitHub cloud sessions; plain chats use the
  // server's current workspace.
  create({ title, workspace: ws, repo = null, mode = 'code', projectId = null, automationId = null } = {}) {
    const now = Date.now();
    const workspace = ws || this.ctx.getWorkspace();
    const conv = {
      id: store.newId('c'),
      title: title || 'New chat',
      createdAt: now,
      updatedAt: now,
      pinned: false,
      workspace,
      cwd: workspace,
      preview: '',
      sessionId: null,
      repo,
      mode: store.MODES.includes(mode) ? mode : 'code',
      projectId,
      automationId,
      items: [],
      history: [],
    };
    this._adopt(conv);
    store.saveConversation(conv);
    this.ctx.broadcast({ t: 'conv', conv: store.metaOf(conv) });
    return conv;
  }

  _adopt(conv) {
    conv.run = null;       // { ctrl, activity }
    conv.asks = new Map(); // askId → resolve fn
    conv.seq = conv.items.reduce((m, it) => Math.max(m, Number(String(it.id).slice(1)) || 0), 0);
    conv.saveTimer = null;
    this.convs.set(conv.id, conv);
    return conv;
  }

  get(id) {
    if (this.convs.has(id)) return this.convs.get(id);
    const conv = store.loadConversation(id);
    return conv ? this._adopt(conv) : null;
  }

  snapshot(id) {
    const conv = this.get(id);
    if (!conv) return null;
    return {
      ...store.metaOf(conv),
      cwd: conv.cwd,
      items: conv.items,
      running: !!conv.run,
      activity: conv.run ? conv.run.activity : null,
      historyEntries: conv.history.length,
    };
  }

  update(id, patch) {
    const conv = this.get(id);
    if (!conv) return null;
    if (typeof patch.title === 'string' && patch.title.trim()) conv.title = patch.title.trim().slice(0, 120);
    if (typeof patch.pinned === 'boolean') conv.pinned = patch.pinned;
    if ('projectId' in patch) conv.projectId = patch.projectId || null;
    this._persistSoon(conv);
    this.ctx.broadcast({ t: 'conv', conv: { ...store.metaOf(conv), running: !!conv.run } });
    return store.metaOf(conv);
  }

  remove(id) {
    const conv = this.convs.get(id);
    if (conv) {
      this.stop(id);
      if (conv.saveTimer) clearTimeout(conv.saveTimer);
      if (conv.sessionId) { try { sessionSearch.recordSessionEnd({ sessionId: conv.sessionId }); } catch {} }
      this.convs.delete(id);
    }
    store.deleteConversation(id);
    try { const d = design.designDir(id); if (d) fs.rmSync(d, { recursive: true, force: true }); } catch {}
    this.ctx.broadcast({ t: 'conv.deleted', id });
    return true;
  }

  shutdown() {
    for (const conv of this.convs.values()) {
      if (conv.run) conv.run.ctrl.abort(new Error('stopped'));
      if (conv.saveTimer) clearTimeout(conv.saveTimer);
      store.saveConversation(conv);
      if (conv.sessionId) { try { sessionSearch.recordSessionEnd({ sessionId: conv.sessionId }); } catch {} }
    }
  }

  reloadGlossary() { this.glossary = loadGlossary(); }

  // ── transcript primitives ───────────────────────────────────────────────

  _persistSoon(conv) {
    if (conv.saveTimer) return;
    conv.saveTimer = setTimeout(() => {
      conv.saveTimer = null;
      store.saveConversation(conv);
    }, 400);
  }

  _add(conv, item) {
    item.id = `i${++conv.seq}`;
    item.at = Date.now();
    conv.items.push(item);
    conv.updatedAt = item.at;
    this.ctx.broadcast({ t: 'item', convId: conv.id, item });
    this._persistSoon(conv);
    return item;
  }

  _touch(conv, item) {
    this.ctx.broadcast({ t: 'item', convId: conv.id, item });
    this._persistSoon(conv);
  }

  _append(conv, item, field, text) {
    item[field] = (item[field] || '') + text;
    this.ctx.broadcast({ t: 'delta', convId: conv.id, id: item.id, field, text });
    this._persistSoon(conv);
  }

  _removeItem(conv, item) {
    const i = conv.items.indexOf(item);
    if (i !== -1) conv.items.splice(i, 1);
    this.ctx.broadcast({ t: 'remove', convId: conv.id, id: item.id });
    this._persistSoon(conv);
  }

  _notice(conv, text, level = 'info', extra = {}) {
    return this._add(conv, { type: 'notice', level, text, ...extra });
  }

  _activity(conv, label) {
    if (!conv.run) return;
    conv.run.activity = label;
    this.ctx.broadcast({ t: 'run', convId: conv.id, running: true, activity: label });
  }

  // Ask the user something and wait. Resolves false if the run is stopped.
  _ask(conv, item) {
    // Unattended runs (automations) have nobody to ask: plan/confirm questions
    // take their default; tool permissions are settled in _confirmTool.
    const unattended = conv.run && conv.run.unattended;
    if (unattended && unattended !== 'ask') {
      const yes = unattended === 'full' ? true : !!item.defaultYes;
      this._add(conv, { type: 'ask', ...item, status: yes ? 'yes' : 'no', auto: true, answeredAt: Date.now() });
      return Promise.resolve(yes);
    }
    const it = this._add(conv, { type: 'ask', status: 'pending', ...item });
    this._activity(conv, 'waiting for you');
    return new Promise((resolve) => {
      // An automation waiting on a person gives up eventually instead of hanging forever.
      const timer = unattended === 'ask' ? setTimeout(() => { const r = conv.asks.get(it.id); if (r) r('aborted'); }, conv.run.askTimeoutMs || 3600e3) : null;
      if (timer) timer.unref();
      conv.asks.set(it.id, (value) => {
        if (timer) clearTimeout(timer);
        conv.asks.delete(it.id);
        it.status = value === 'aborted' ? 'expired' : (value ? 'yes' : 'no');
        it.answeredAt = Date.now();
        this._touch(conv, it);
        resolve(value === true);
      });
    });
  }

  answer(convId, askId, value) {
    const conv = this.convs.get(convId);
    const resolve = conv && conv.asks.get(askId);
    if (!resolve) return false;
    resolve(!!value);
    return true;
  }

  stop(convId) {
    const conv = this.convs.get(convId);
    if (!conv || !conv.run) return false;
    conv.run.ctrl.abort(new Error('stopped'));
    for (const resolve of Array.from(conv.asks.values())) resolve('aborted');
    return true;
  }

  roots(conv) {
    if (conv.mode === 'design') return [design.ensureDir(conv.id)];
    const ws = path.resolve(conv.workspace || this.ctx.getWorkspace());
    const cwd = path.resolve(conv.cwd || ws);
    const roots = cwd === ws ? [ws] : [ws, cwd];
    // In a project that shares context, the designs made in it are readable
    // from its code and cowork chats (so "build what we designed" just works).
    for (const s of this._siblings(conv)) if (s.mode === 'design' && s.designDir && fs.existsSync(s.designDir)) roots.push(s.designDir);
    return roots;
  }

  _project(conv) {
    return conv.projectId && this.ctx.projects ? this.ctx.projects.get(conv.projectId) : null;
  }

  // Other conversations in the same project — only when the project shares context.
  _siblings(conv) {
    const project = this._project(conv);
    if (!project || !project.shareContext) return [];
    // Looked up once per run — this is consulted on every tool call.
    if (conv.run && conv.run.siblings) return conv.run.siblings;
    const found = this.list().filter((m) => m.projectId === project.id && m.id !== conv.id).slice(0, 9).map((m) => {
      const c = this.get(m.id);
      if (!c) return null;
      const dir = c.mode === 'design' ? design.designDir(c.id) : null;
      return { id: c.id, title: c.title, mode: c.mode || 'code', updatedAt: c.updatedAt, items: c.items, workspace: c.workspace, designDir: dir, designFiles: dir ? design.listFiles(dir).map((f) => f.path) : [] };
    }).filter(Boolean);
    if (conv.run) conv.run.siblings = found;
    return found;
  }

  _projectContext(conv) {
    return buildContext(this._project(conv), conv, this._siblings(conv));
  }

  // The user's global instruction, prepended to every conversation in every
  // mode. Project instructions and shared context are layered after it.
  _globalPrompt() {
    const p = this.ctx.settings && this.ctx.settings.systemPrompt;
    return typeof p === 'string' && p.trim() ? p.trim() : null;
  }

  // ── entry point ─────────────────────────────────────────────────────────

  // mode: 'ask' (default) or 'shell'. A leading "$ " also means shell.
  // unattended: 'auto' | 'ask' | 'full' — set for automation runs (see _confirmTool).
  async send(convId, rawText, { mode = 'ask', unattended = null, askTimeoutMs = null, attachments = null, hint = null, direct = false, effort = null } = {}) {
    const conv = this.get(convId);
    if (!conv) return { ok: false, error: 'conversation not found' };
    if (conv.run) return { ok: false, error: 'a run is already in progress' };
    let text = String(rawText || '').trim();
    const refs = Array.isArray(attachments) ? attachments.filter((a) => a && (a.name || a.content)) : [];
    const refContext = attachmentContext(refs);
    if (!text && !refContext) return { ok: false, error: 'empty message' };

    if (/^\$\s+/.test(text)) { mode = 'shell'; text = text.replace(/^\$\s+/, ''); }

    const ctrl = new AbortController();
    setMaxListeners(0, ctrl.signal);
    let finish;
    const done = new Promise((r) => { finish = r; });
    const images = imageAttachments(refs);
    conv.run = { ctrl, activity: 'starting', unattended, askTimeoutMs, error: null, finish, images, hint, direct: !!direct, artefactRequested: artefactRequested(text), effort: effort || null };
    this.ctx.broadcast({ t: 'run', convId: conv.id, running: true, activity: 'starting' });

    this._add(conv, { type: 'user', text, mode, attachments: refs.map((a) => ({ name: a.name || 'file', size: typeof a.size === 'number' ? a.size : 0 })) });
    if (!conv.preview || conv.title === 'New chat') {
      const label = text || (refs.length ? `📎 ${refs.map((a) => a.name).join(', ')}` : '');
      if (conv.title === 'New chat') conv.title = titleFrom(label);
      conv.preview = label.slice(0, 140);
      this.ctx.broadcast({ t: 'conv', conv: { ...store.metaOf(conv), running: true } });
    }

    if (!conv.sessionId) {
      conv.sessionId = sessionSearch.makeSessionId();
      try { sessionSearch.recordSessionStart({ sessionId: conv.sessionId, workspace: conv.workspace, pid: process.pid }); } catch {}
      audit.append({ kind: 'session-start', sessionId: conv.sessionId, workspace: conv.workspace, via: 'web', review: !!this.ctx.settings.review, pid: process.pid });
    }

    // Fire and forget — progress flows through broadcasts.
    const prompt = refContext ? `${text}\n\n${refContext}`.trim() : text;
    this._run(conv, prompt, mode, ctrl).catch(() => {});
    return { ok: true, done };
  }

  // Send and resolve when the run is over: { status: 'ok' | 'error' | 'stopped', error, summary }.
  async sendAndWait(convId, text, opts = {}) {
    const r = await this.send(convId, text, opts);
    if (!r.ok) return { status: 'error', error: r.error };
    return r.done;
  }

  // ── pause / resume / move ────────────────────────────────────────────────

  // Stop a running conversation at the next safe point and persist it so it can
  // be transferred mid-conversation. Unlike stop(), the state is labelled
  // "paused" and a resume prompt is remembered.
  pause(convId) {
    const conv = this.get(convId);
    if (!conv) return false;
    if (conv.run) {
      conv.run.paused = true;
      conv.run.ctrl.abort(new Error('paused'));
    }
    for (const resolve of Array.from(conv.asks.values())) resolve('aborted');
    conv.paused = true;
    const lastUser = [...conv.items].reverse().find((i) => i.type === 'user');
    if (lastUser) conv.resumePrompt = lastUser.text;
    store.saveConversation(conv);
    this.ctx.broadcast({ t: 'conv', conv: { ...store.metaOf(conv), running: !!conv.run } });
    return true;
  }

  // Continue a conversation that was paused (or moved in while paused).
  async resume(convId) {
    const conv = this.get(convId);
    if (!conv) return { ok: false, error: 'conversation not found' };
    if (conv.run) return { ok: false, error: 'a run is already in progress' };
    conv.paused = false;
    const prompt = conv.resumePrompt || 'Continue';
    conv.resumePrompt = null;
    store.saveConversation(conv);
    this.ctx.broadcast({ t: 'conv', conv: store.metaOf(conv) });
    return this.send(convId, prompt, { mode: 'ask' });
  }

  // A clean, serialisable snapshot with live-run state settled, ready to send
  // to another node.
  _cleanCopy(conv) {
    const items = (conv.items || []).map((it) => {
      const c = { ...it };
      if (c.streaming) c.streaming = false;
      if (c.type === 'ask' && c.status === 'pending') c.status = 'expired';
      if (c.type === 'tool' && c.status === 'running') c.status = 'interrupted';
      if (c.type === 'shell' && c.running) { c.running = false; c.interrupted = true; }
      if (c.type === 'team' && Array.isArray(c.agents)) for (const a of c.agents) if (a.status === 'running') a.status = 'interrupted';
      return c;
    });
    return {
      id: conv.id, title: conv.title, createdAt: conv.createdAt, updatedAt: conv.updatedAt,
      pinned: !!conv.pinned, workspace: conv.workspace || null, cwd: conv.cwd || null,
      preview: conv.preview || '', sessionId: null, repo: conv.repo || null,
      mode: store.MODES.includes(conv.mode) ? conv.mode : 'code',
      projectId: conv.projectId || null, automationId: null,
      items, history: Array.isArray(conv.history) ? conv.history : [],
      node: conv.node || 'local', remote: !!conv.remote, paused: false, resumePrompt: conv.resumePrompt || null,
    };
  }

  // Serialise a conversation for transfer. Includes the workspace directory
  // only for real (non-chat) sessions that own one.
  exportConv(id) {
    const conv = this.get(id);
    if (!conv) return null;
    if (conv.run) this.pause(id);
    const data = this._cleanCopy(conv);
    const includeWorkspace = conv.mode !== 'chat' && conv.workspace && fs.existsSync(conv.workspace);
    return { conv: data, workspaceDir: includeWorkspace ? path.resolve(conv.workspace) : null };
  }

  // Import a conversation that arrived from another node. `workspaceDir` is the
  // already-extracted workspace (or null). Move keeps the id, copy mints a new
  // one; a move that collides falls back to a fresh id.
  importConv(data, { workspaceDir = null, newId = false } = {}) {
    let id = newId ? store.newId('c') : (store.safeId(data.id) || store.newId('c'));
    if (!newId && store.loadConversation(id)) id = store.newId('c');
    const conv = {
      id, title: data.title || 'Imported chat', createdAt: data.createdAt || Date.now(), updatedAt: Date.now(),
      pinned: !!data.pinned, workspace: workspaceDir || data.workspace || null, cwd: workspaceDir || data.cwd || data.workspace || null,
      preview: data.preview || '', sessionId: null, repo: data.repo || null,
      mode: store.MODES.includes(data.mode) ? data.mode : 'code',
      projectId: data.projectId || null, automationId: null,
      items: Array.isArray(data.items) ? data.items : [],
      history: Array.isArray(data.history) ? data.history : [],
      node: 'local', remote: false, paused: false, resumePrompt: data.resumePrompt || null,
    };
    this._adopt(conv);
    store.saveConversation(conv);
    this.ctx.broadcast({ t: 'conv', conv: store.metaOf(conv) });
    return conv;
  }

  async _run(conv, text, mode, ctrl) {
    let outcome = 'ok';
    try {
      const selfCmd = matchSelfCommand(text);
      if (conv.mode === 'chat') {
        await this._plainChat(conv, text, ctrl);
      } else if (conv.mode === 'design') {
        await this._design(conv, text, ctrl);
      } else if (selfCmd.matched && mode !== 'shell' && !conv.run.unattended) {
        await this._selfCommand(conv, text, selfCmd);
      } else if (mode === 'shell') {
        await this._shell(conv, text, ctrl);
      } else {
        await this._task(conv, text, ctrl);
      }
    } catch (e) {
      if (isAbortError(e) || ctrl.signal.aborted) {
        outcome = 'stopped';
        this._notice(conv, conv.run && conv.run.paused ? 'Paused for transfer.' : 'Stopped.', 'warn');
      } else {
        outcome = 'error';
        conv.run.error = String(e && e.message ? e.message : e);
        this._notice(conv, `Task error: ${e && e.message ? e.message : e}`, 'error');
        if (this.ctx.settings.debug && e && e.stack) this._add(conv, { type: 'output', title: 'stack trace', text: e.stack });
      }
    } finally {
      for (const resolve of Array.from(conv.asks.values())) resolve('aborted');
      for (const it of conv.items) {
        if (it.streaming) { it.streaming = false; this._touch(conv, it); }
        if (it.type === 'tool' && it.status === 'running') { it.status = 'interrupted'; this._touch(conv, it); }
      }
      const run = conv.run;
      if (outcome === 'ok' && run.error) outcome = 'error';
      const last = [...conv.items].reverse().find((i) => i.type === 'assistant' && !i.interim && i.text);
      conv.run = null;
      conv.updatedAt = Date.now();
      store.saveConversation(conv);
      run.finish({ status: outcome, error: run.error, summary: last ? last.text : '' });
      this.ctx.broadcast({ t: 'run', convId: conv.id, running: false });
      this.ctx.broadcast({ t: 'conv', conv: { ...store.metaOf(conv), running: false } });
    }
  }

  // ── self-commands ("list skills", "review on", "reset", …) ──────────────

  resetConversation(conv, { quiet = false } = {}) {
    conv.history = [];
    const root = this.roots(conv)[0];
    try { clearTaskJournal(root); } catch {}
    try { clearIndex(root); } catch {}
    clearEdits();
    if (!quiet) this._notice(conv, 'Conversation context, task journal and workspace index cleared.', 'ok');
    this._persistSoon(conv);
  }

  async _selfCommand(conv, text, match) {
    const { settings } = this.ctx;
    audit.append({ kind: 'self-command', cmd: text, action: match.action, via: 'web' });

    if (match.confirm) {
      const go = await this._ask(conv, { kind: 'confirm', question: `Run “${match.action}”${match.arg ? ` (${match.arg})` : ''}?`, defaultYes: true });
      if (!go) return;
    }

    // Commands that signal the parent CLI process need GUI-native handling.
    switch (match.action) {
      case 'reset':
      case 'compact':
        this.resetConversation(conv);
        return;
      case 'status':
        this._notice(conv, `shmakk web UI running — pid ${process.pid}, workspace ${conv.workspace}`, 'info');
        return;
      case 'set-profile': {
        const { normalizeProfile } = require('../profiles');
        const p = normalizeProfile(match.arg);
        if (!p) { this._notice(conv, `Unknown profile “${match.arg}”. Valid: tiny, balanced, deep, builder, large-app.`, 'error'); return; }
        settings.profile = p;
        this.ctx.saveSettings();
        this._notice(conv, `Profile set to ${p}.`, 'ok');
        return;
      }
      case 'review-edits':
        this._notice(conv, getEdits().length ? `${getEdits().length} edit(s) this session.` : 'No edits to review this session.', 'info', { action: 'open:changes' });
        return;
      default:
    }

    // Everything else reuses the CLI implementation verbatim; its terminal
    // output (some via `write`, some straight to stdout) is captured.
    let buf = '';
    const cap = (s) => { buf += String(s); return true; };
    const origOut = process.stdout.write;
    const origErr = process.stderr.write;
    const prevCwd = process.cwd();
    process.stdout.write = cap;
    process.stderr.write = cap;
    try {
      try { process.chdir(conv.workspace); } catch {}
      executeSelfCommand(match, cap, { opts: settings, HELP, setColors: () => {} });
    } catch (e) {
      buf += `\n[shmakk] ${e.message}\n`;
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
      try { process.chdir(prevCwd); } catch {}
    }
    this.ctx.saveSettings();
    this.ctx.onProviderChanged();
    this._add(conv, { type: 'output', title: text, text: buf.replace(/\r\n/g, '\n').trimEnd() || '(no output)' });
  }

  // ── shell mode: run → on failure, correction engine → else hand to agent ─

  _exec(conv, cmd, ctrl, { corrected = null } = {}) {
    const item = this._add(conv, { type: 'shell', cmd, cwd: conv.cwd, output: '', running: true, exitCode: null, correctedFrom: corrected });
    this._activity(conv, 'running command');
    return new Promise((resolve) => {
      const sh = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
      const wrapped = `${cmd}\n__shmakk_s=$?; printf '\\n${CWD_MARKER}%s\\n' "$PWD"; exit $__shmakk_s`;
      let child;
      try {
        child = spawn(sh, ['-c', wrapped], {
          cwd: fs.existsSync(conv.cwd) ? conv.cwd : conv.workspace,
          env: { ...process.env, SHMAKK: '1', TERM: 'xterm-256color', FORCE_COLOR: '1', CLICOLOR_FORCE: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        item.running = false; item.exitCode = 127; item.output = String(e.message);
        this._touch(conv, item);
        return resolve(item);
      }
      let total = 0;
      let tail = '';
      const onData = (chunk) => {
        let s = tail + chunk.toString('utf8');
        tail = '';
        // Hold back anything that might be (the start of) the cwd marker.
        const idx = s.indexOf(`\n${CWD_MARKER}`);
        if (idx !== -1) { tail = s.slice(idx); s = s.slice(0, idx); }
        else if (s.length > CWD_MARKER.length + 1) {
          const keep = s.lastIndexOf('\n');
          if (keep !== -1 && s.length - keep <= CWD_MARKER.length + 1) { tail = s.slice(keep); s = s.slice(0, keep); }
        }
        if (!s) return;
        total += s.length;
        if (total > MAX_SHELL_OUTPUT) {
          if (!item.truncated) { item.truncated = true; this._touch(conv, item); }
          return;
        }
        this._append(conv, item, 'output', s);
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      const onAbort = () => {
        try { child.kill('SIGINT'); } catch {}
        setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 800);
      };
      ctrl.signal.addEventListener('abort', onAbort, { once: true });
      child.on('error', (e) => {
        ctrl.signal.removeEventListener('abort', onAbort);
        item.running = false; item.exitCode = 127;
        this._append(conv, item, 'output', String(e.message));
        this._touch(conv, item);
        resolve(item);
      });
      child.on('close', (code, sig) => {
        ctrl.signal.removeEventListener('abort', onAbort);
        const m = tail.match(new RegExp(`\\n${CWD_MARKER}(.*)\\n?$`));
        if (m) {
          const next = m[1].trim();
          if (next && fs.existsSync(next)) conv.cwd = next;
          const rest = tail.slice(0, m.index);
          if (rest) item.output += rest;
        } else if (tail) {
          item.output += tail;
        }
        item.running = false;
        item.exitCode = code == null ? (sig ? 130 : 1) : code;
        item.cwdAfter = conv.cwd;
        this._touch(conv, item);
        resolve(item);
      });
    });
  }

  async _shell(conv, cmd, ctrl) {
    const { settings } = this.ctx;

    // A GUI has no "the user typed it at their own prompt" moment, so risky
    // commands are confirmed in review mode before they run.
    if (settings.review && classifyRunCommand(cmd) === 'unsafe') {
      const go = await this._ask(conv, { kind: 'confirm', question: 'This command is flagged as risky. Run it?', detail: cmd, defaultYes: false, safety: 'unsafe' });
      if (!go) return;
    }

    const res = await this._exec(conv, cmd, ctrl);
    if (ctrl.signal.aborted) throw new Error('stopped');
    if (res.exitCode === 0) return;
    if (settings.noAi) return;

    audit.append({ kind: 'failed-command', cmd, exit: res.exitCode, cwd: conv.cwd, via: 'web' });

    let decision;
    if (settings.noCorrection) {
      decision = { category: 'not_a_correction', proposed: null, safety: 'uncertain', reason: 'correction disabled' };
    } else {
      try { decision = await correct({ input: cmd, glossary: this.glossary }); }
      catch (e) { decision = { category: 'not_a_correction', proposed: null, safety: 'uncertain', reason: `correction failed: ${e.message}` }; }
    }
    audit.append({ kind: 'correction-decision', cmd, decision });

    if (decision.category === 'command_correction' && decision.proposed) {
      const safe = decision.safety === 'safe' && classifyRunCommand(decision.proposed) === 'safe';
      let go = safe && !settings.review;
      if (!go) {
        go = await this._ask(conv, {
          kind: 'correction',
          question: 'Run the corrected command?',
          input: cmd,
          proposed: decision.proposed,
          safety: safe ? 'safe' : (decision.safety === 'safe' ? 'unsafe' : decision.safety),
          reason: decision.reason || 'deterministic match against your command glossary',
          defaultYes: safe,
        });
      }
      if (go) {
        audit.append({ kind: 'correction-run', proposed: decision.proposed, via: 'web' });
        await this._exec(conv, decision.proposed, ctrl, { corrected: cmd });
      }
      return;
    }

    // Not a typo — treat the failure as a task for the agent, like the CLI.
    if (!isConfigured()) {
      this._notice(conv, 'Command failed. Configure an AI provider in Settings to have shmakk investigate failures.', 'warn', { action: 'open:settings' });
      return;
    }
    if (settings.review) {
      const go = await this._ask(conv, { kind: 'confirm', question: 'Command failed. Hand it to the agent as a task?', detail: decision.reason || '', defaultYes: true });
      if (!go) return;
    }
    const out = stripAnsi(res.output).trim().slice(-3000);
    const input = out
      ? `${cmd}\n\n[The command above was run in ${res.cwd} and exited with status ${res.exitCode}. Output:]\n${out}`
      : cmd;
    await this._task(conv, input, ctrl);
  }

  // ── tool confirmation policy (mirrors session.js makeToolConfirm) ───────

  _confirmTool(conv, ctrl) {
    const { settings } = this.ctx;
    return async ({ name, args, safety, description }) => {
      audit.append({ kind: 'tool-proposed', name, args, safety, mode: settings.review ? 'review' : 'auto', via: 'web' });
      const fileCreateAllowed = settings.yesFiles
        && (name === 'write_file' || name === 'edit_file' || name === 'make_dir')
        && safety !== 'unsafe';
      const isFileTool = name === 'write_file' || name === 'edit_file' || name === 'make_dir';
      // Design chats only ever write inside their own artifact folder.
      const designOk = conv.mode === 'design' && isFileTool && safety !== 'unsafe';
      const wouldAuto = safety === 'safe' || fileCreateAllowed || designOk;

      // Automation runs: nobody is watching, so the automation's own policy decides.
      const unattended = conv.run && conv.run.unattended;
      if (unattended === 'full') { audit.append({ kind: 'tool-allowed', name, args, via: 'automation-full' }); return true; }
      if (unattended === 'auto') {
        const ok = safety !== 'unsafe' && (safety === 'safe' || isFileTool || name.startsWith('mcp__'));
        audit.append({ kind: ok ? 'tool-allowed' : 'tool-declined', name, args, via: 'automation' });
        if (!ok) this._notice(conv, `Skipped (needs approval, and this automation runs unattended): ${description}`, 'warn');
        return ok;
      }

      if (!unattended && !settings.review && wouldAuto) {
        audit.append({ kind: 'tool-allowed', name, args, via: fileCreateAllowed ? 'yes-files' : 'auto-safe' });
        return true;
      }
      if (ctrl.signal.aborted) return false;

      // Show the pending change as a diff where we can compute one.
      let diff = null;
      try {
        if (name === 'edit_file' && args.old_string != null) {
          diff = unifiedDiff(String(args.old_string), String(args.new_string ?? ''), args.path || 'file');
        } else if (name === 'write_file' && typeof args.content === 'string') {
          const roots = this.roots(conv);
          const abs = path.isAbsolute(args.path || '') ? args.path : path.join(roots[0], args.path || '');
          const old = fs.existsSync(abs) && fs.statSync(abs).size < 512 * 1024 ? fs.readFileSync(abs, 'utf8') : null;
          diff = old == null ? newFileDiff(args.content, args.path || 'file') : unifiedDiff(old, args.content, args.path || 'file');
        }
      } catch {}
      if (diff && diff.length > MAX_DIFF_BYTES) diff = `${diff.slice(0, MAX_DIFF_BYTES)}\n… diff truncated`;

      const ok = await this._ask(conv, {
        kind: 'tool',
        question: 'Allow this action?',
        name,
        args: previewArgs(args),
        safety,
        description,
        diff,
        what: TOOL_EXPLAIN[name] || (name.startsWith('mcp__') ? 'Calls a tool on an external MCP server.' : 'Executes the requested action.'),
        why: SAFETY_EXPLAIN[safety] || 'Unknown risk level.',
        defaultYes: wouldAuto,
      });
      audit.append({ kind: ok ? 'tool-allowed' : 'tool-declined', name, args, via: 'web' });
      return ok;
    };
  }

  // When a non-code chat creates a file and the user asked for an artefact,
  // snapshot it into the vault. Code mode is deliberately excluded: its files
  // are project work, not artefacts.
  _captureArtefact(conv, name, args) {
    if (conv.mode === 'code') return;
    if (!conv.run || !conv.run.artefactRequested) return;
    if (name !== 'write_file' && name !== 'edit_file') return;
    const p = args && args.path;
    if (!p) return;
    try {
      const abs = path.isAbsolute(p) ? p : path.join(this.roots(conv)[0], p);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return;
      const art = artefacts.fromFile(abs, { mode: conv.mode, convId: conv.id, workspace: conv.workspace || this.ctx.getWorkspace() });
      this._notice(conv, `Saved to artefacts: ${art.name}`, 'ok', { action: 'open:artefacts' });
      this.ctx.broadcast({ t: 'artefacts.changed' });
    } catch {}
  }

  // ── agent event → transcript item mapping ───────────────────────────────

  _eventSink(conv, { agentLabel = null } = {}) {
    let current = null;            // streaming assistant item
    const tools = new Map();       // tool_call id → item
    const closeCurrent = () => {
      if (current && current.streaming) { current.streaming = false; this._touch(conv, current); }
      current = null;
    };
    const ensure = () => {
      if (!current) current = this._add(conv, { type: 'assistant', text: '', reasoning: '', streaming: true, agent: agentLabel });
      return current;
    };
    const sink = (ev) => {
      switch (ev.type) {
        case 'status':
          this._activity(conv, ev.label);
          break;
        case 'delta':
          this._append(conv, ensure(), 'text', ev.text);
          this._activity(conv, 'writing');
          break;
        case 'reasoning':
          this._append(conv, ensure(), 'reasoning', ev.text);
          this._activity(conv, 'reasoning');
          break;
        case 'retract':
          if (current) {
            if (current.reasoning) { current.text = ''; current.streaming = false; this._touch(conv, current); }
            else this._removeItem(conv, current);
            current = null;
          }
          break;
        case 'message': {
          const it = ensure();
          it.text = ev.content;
          it.streaming = false;
          if (ev.cached) it.cached = true;
          if (ev.interim) it.interim = true;
          this._touch(conv, it);
          sink.lastMessage = ev.content;
          current = null;
          break;
        }
        case 'tool_start': {
          closeCurrent();
          const it = this._add(conv, { type: 'tool', name: ev.name, args: previewArgs(ev.args), status: 'running', agent: agentLabel });
          tools.set(ev.id, it);
          this._activity(conv, `using ${ev.name.replace(/^mcp__/, '')}`);
          break;
        }
        case 'tool_end': {
          const it = tools.get(ev.id) || this._add(conv, { type: 'tool', name: ev.name, args: previewArgs(ev.args), agent: agentLabel });
          tools.delete(ev.id);
          it.status = ev.error ? (ev.error === 'user declined' ? 'declined' : 'error') : 'done';
          it.error = ev.error || null;
          it.summary = ev.summary || '';
          it.result = previewResult(ev.name, ev.result);
          if (!ev.error && (ev.name === 'write_file' || ev.name === 'edit_file')) {
            const edits = getEdits();
            const last = edits[edits.length - 1];
            if (last) {
              try {
                const rel = path.relative(this.roots(conv)[0], last.filePath) || last.filePath;
                let diff = last.oldContent == null ? newFileDiff(last.newContent, rel) : unifiedDiff(last.oldContent, last.newContent, rel);
                if (diff && diff.length > MAX_DIFF_BYTES) diff = `${diff.slice(0, MAX_DIFF_BYTES)}\n… diff truncated`;
                it.diff = diff;
                it.created = last.oldContent == null;
              } catch {}
            }
          }
          if (!ev.error && (ev.name === 'write_file' || ev.name === 'edit_file')) {
            this._captureArtefact(conv, ev.name, ev.args);
          }
          it.endedAt = Date.now();
          this._touch(conv, it);
          break;
        }
        default:
      }
    };
    sink.close = closeCurrent;
    sink.lastMessage = '';
    return sink;
  }

  // Legacy text channel: anything a module still prints through `write`
  // lands in a collapsible console block.
  _logWriter(conv) {
    let item = null;
    const write = (s) => {
      const text = String(s || '').replace(/\r\n/g, '\n').replace(/\r/g, '');
      if (!text) return;
      if (!item || conv.items[conv.items.length - 1] !== item) item = this._add(conv, { type: 'log', text: '' });
      this._append(conv, item, 'text', text);
    };
    return write;
  }

  // ── task pipeline: team → plan-first → single agent ─────────────────────

  async _task(conv, cmd, ctrl) {
    const { settings, mcpManager } = this.ctx;
    if (!isConfigured()) {
      conv.run.error = 'no AI provider configured';
      this._notice(conv, 'No AI provider configured. Add a base URL and model in Settings (or set SHMAKK_BASE_URL).', 'warn', { action: 'open:settings' });
      return;
    }
    process.env.SHMAKK_SESSION_ID = conv.sessionId || '';
    const cowork = conv.mode === 'cowork';
    const hint = (base) => [base, this._globalPrompt(), cowork ? COWORK_HINT : null, this._projectContext(conv)].filter(Boolean).join('\n\n') || null;
    const tools = cowork && this.ctx.automations
      ? coworkTools(mcpManager, this.ctx.automations, { projectId: conv.projectId, workspace: conv.workspace })
      : mcpManager;
    const roots = this.roots(conv);
    const routing = routeToSpecialist(cmd, [...conv.history, { role: 'user', content: cmd }]);
    const agentProfile = settings.profile || routing.profile || 'balanced';
    const sink = this._eventSink(conv);
    const write = this._logWriter(conv);
    const agentOpts = {
      roots,
      glossary: this.glossary,
      confirmTool: this._confirmTool(conv, ctrl),
      write,
      signal: ctrl.signal,
      profile: agentProfile,
      colors: false,
      specialistHint: hint(routing.specialistHint),
      mcpManager: tools,
      onEvent: sink,
      model: this._modelFor(conv),
      effort: (conv.run && conv.run.effort) || null,
    };

    // ── Team mode ──
    // Images are shown to a single agent: a team would each need the payload.
    // Plan tasks (direct) go to one agent: they are already decomposed.
    const direct = !!(conv.run && conv.run.direct);
    if (!direct && !settings.review && !cowork && !(conv.run && conv.run.images && conv.run.images.length) && looksMultiDomain(cmd)) {
      let teamItem = null;
      let summary = '';
      let handled = false;
      try {
        handled = await runTeam({
          input: cmd, roots, write, signal: ctrl.signal, mcpManager, model: this._modelFor(conv),
          onEvent: (ev) => {
            if (ev.type === 'status') this._activity(conv, ev.label);
            else if (ev.type === 'team_start') {
              teamItem = this._add(conv, {
                type: 'team', topology: ev.topology, reason: ev.reason, source: ev.source,
                agents: ev.agents.map((a) => ({ ...a, status: 'pending' })),
              });
              this._activity(conv, `team of ${ev.agents.length} working`);
            } else if (ev.type === 'team_agent' && teamItem && teamItem.agents[ev.index]) {
              Object.assign(teamItem.agents[ev.index], { status: ev.status, error: ev.error || null, toolCount: ev.toolCount, elapsed: ev.elapsed, skillUsed: ev.skill });
              this._touch(conv, teamItem);
            } else if (ev.type === 'team_note') {
              this._notice(conv, ev.text, ev.level || 'info');
            } else if (ev.type === 'team_summary') {
              summary = ev.content;
              this._add(conv, { type: 'assistant', text: ev.content, agent: 'pm' });
            }
          },
        });
      } catch (e) {
        if (isAbortError(e) || ctrl.signal.aborted) throw e;
        this._notice(conv, `Team error: ${e.message} — falling back to a single agent.`, 'warn');
      }
      if (handled) {
        conv.history = trimHistory([...conv.history, { role: 'user', content: cmd }, { role: 'assistant', content: summary || 'Team run completed.' }]);
        return;
      }
    }

    // ── Plan-first ──
    // The plan becomes a review-gated plan (see ./plans.js): tasks are only
    // done once their diff passes review (and your sign-off, if required).
    if (!direct && !settings.review && shouldPlan(cmd) && this.ctx.plans) {
      this._activity(conv, 'generating plan');
      let draft = null;
      try { draft = await generatePlan(cmd, { signal: ctrl.signal, model: this._modelFor(conv) }); }
      catch (e) {
        if (isAbortError(e) || ctrl.signal.aborted) throw e;
        this._notice(conv, 'Plan generation failed — running directly.', 'warn');
      }
      if (draft) {
        const plan = this.ctx.plans.create({
          title: draft.title,
          summary: String(cmd).slice(0, 2000),
          source: 'chat',
          convId: conv.id,
          tasks: draft.tasks.map((t) => ({ title: t.title, instructions: t.description, acceptance: t.acceptance, layer: t.layer, kind: t.kind })),
        });
        const planItem = this._add(conv, { type: 'plan', planId: plan.id, plan: { id: plan.id, title: plan.title, status: plan.status, tasks: plan.tasks.map((t) => ({ id: t.id, title: t.title, description: t.instructions, status: t.status })) } });
        const approved = await this._ask(conv, { kind: 'plan', question: 'Approve this plan?', defaultYes: true });
        if (!approved) {
          planItem.plan.status = 'rejected';
          this._touch(conv, planItem);
          this._notice(conv, 'Plan kept as a draft in Plans — edit it there, or rephrase your request (prefix with ! to run without a plan).', 'warn', { action: 'open:plan' });
          return;
        }
        // The runner waits for this run to end, then executes task by task in
        // this conversation, reviewing each before moving on.
        await this.ctx.plans.run(plan.id);
        this._notice(conv, 'Plan approved. Each task is reviewed against its acceptance criteria before it counts as done; reviewed tasks wait for your sign-off in Plans.', 'ok', { action: 'open:plan' });
        return;
      }
    }

    // ── Single agent ──
    if (routing.indicator) this._add(conv, { type: 'route', specialist: routing.specialist, indicator: routing.indicator, profile: agentProfile });
    const updated = await runAgent({ ...agentOpts, input: cmd, history: conv.history, images: conv.run ? conv.run.images : null });
    sink.close();
    conv.history = trimHistory(updated || conv.history);
    if (ctrl.signal.aborted) throw new Error('stopped');
  }

  // ── Chat mode: a plain conversation — no workspace, no file or shell tools,
  //    just the model (plus web search and page fetch when it needs facts). ──

  async _plainChat(conv, text, ctrl) {
    if (!isConfigured()) {
      conv.run.error = 'no AI provider configured';
      this._notice(conv, 'No AI provider configured. Add a base URL and model in Settings.', 'warn', { action: 'open:settings' });
      return;
    }
    const { client, model: resolvedModel } = makeClientForModel(this._modelFor(conv));
    const tools = TOOLS.filter((t) => t.function.name === 'web_search' || t.function.name === 'fetch_url');
    const system = [
      `You are shmakk, a thoughtful, direct assistant. Today is ${new Date().toDateString()}.`,
      'Answer the question that was asked, at the depth it deserves. Use Markdown where it helps (code blocks, short lists, tables for comparisons).',
      'You can search the web and fetch pages when the answer depends on current or specific facts; say so briefly when you do. You have no access to files or a shell in this mode — if the user wants work done in a codebase, suggest Code mode; for visual work, Design mode; for recurring or scheduled work, Cowork mode.',
      renderMemoryForPrompt(this.ctx.getWorkspace()),
      this._globalPrompt(),
      this._projectContext(conv),
    ].filter(Boolean).join('\n\n');
    const userContent = await userContentWithImages(text, conv.run && conv.run.images, ctrl.signal);
    const messages = [{ role: 'system', content: system }, ...trimHistory(conv.history), { role: 'user', content: userContent }];
    const sink = this._eventSink(conv);

    for (let round = 0; round < 6; round++) {
      sink({ type: 'status', label: round === 0 ? 'thinking' : 'reading' });
      const stream = await client.chat.completions.create({ model: resolvedModel, messages, tools, stream: true, ...getReasoningOptions('chat', conv.run && conv.run.effort, resolvedModel) }, { signal: ctrl.signal });
      let content = '';
      const calls = [];
      for await (const chunk of stream) {
        const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
        if (!delta) continue;
        if (delta.content) { content += delta.content; sink({ type: 'delta', text: delta.content }); }
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) sink({ type: 'reasoning', text: delta.reasoning_content });
        for (const tc of delta.tool_calls || []) {
          const slot = calls[tc.index ?? 0] || (calls[tc.index ?? 0] = { id: '', type: 'function', function: { name: '', arguments: '' } });
          if (tc.id) slot.id = tc.id;
          if (tc.function && tc.function.name) slot.function.name = tc.function.name;
          if (tc.function && tc.function.arguments) slot.function.arguments += tc.function.arguments;
        }
      }
      const toolCalls = calls.filter((c) => c && c.function.name).map((c, i) => ({ ...c, id: c.id || `call_${round}_${i}` }));
      if (!toolCalls.length) {
        if (content) sink({ type: 'message', content });
        else this._notice(conv, 'The model returned an empty reply — try rephrasing.', 'warn');
        messages.push({ role: 'assistant', content });
        break;
      }
      if (content) sink({ type: 'message', content, interim: true });
      messages.push({ role: 'assistant', content: content || null, tool_calls: toolCalls });
      for (const c of toolCalls) {
        let args = {};
        try { args = JSON.parse(c.function.arguments || '{}'); } catch {}
        sink({ type: 'tool_start', id: c.id, name: c.function.name, args });
        const allowed = tools.some((t) => t.function.name === c.function.name);
        const result = allowed ? await dispatchTool(c.function.name, args, [], null, ctrl.signal, null) : { error: 'tool not available in Chat mode' };
        if (c.function.name === 'browser' && args && args.command === 'show' && result && result.ok) {
          try { this.ctx.broadcast({ t: 'browser.open', url: result.url || args.url || '' }); } catch {}
        }
        sink({ type: 'tool_end', id: c.id, name: c.function.name, args, result, summary: summarizeToolResult(c.function.name, result), error: result && result.error ? result.error : null });
        messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(result).slice(0, 8000) });
        if (ctrl.signal.aborted) throw new Error('stopped');
      }
    }
    sink.close();
    conv.history = trimHistory(stripImageBlocks(messages.slice(1)));
    if (ctrl.signal.aborted) throw new Error('stopped');
  }

  // ── Design mode: the agent writes HTML/CSS into this conversation's artifact
  //    folder; the UI previews it live and every run leaves a version. ──

  async _design(conv, text, ctrl) {
    if (!isConfigured()) {
      conv.run.error = 'no AI provider configured';
      this._notice(conv, 'No AI provider configured. Add a base URL and model in Settings.', 'warn', { action: 'open:settings' });
      return;
    }
    const dir = design.ensureDir(conv.id);
    const sink = this._eventSink(conv);
    const changed = () => this.ctx.broadcast({ t: 'design.changed', convId: conv.id });
    const updated = await runAgent({
      input: text,
      roots: [dir],
      glossary: null,
      confirmTool: this._confirmTool(conv, ctrl),
      write: this._logWriter(conv),
      signal: ctrl.signal,
      history: conv.history,
      images: conv.run ? conv.run.images : null,
      profile: this.ctx.settings.profile || 'builder',
      colors: false,
      model: this._modelFor(conv),
      specialistHint: [design.DESIGN_HINT, this._globalPrompt(), this._projectContext(conv), conv.run && conv.run.hint].filter(Boolean).join('\n\n'),
      mcpManager: null,
      onEvent: (ev) => {
        sink(ev);
        if (ev.type === 'tool_end' && !ev.error && /^(write_file|edit_file|delete_file)$/.test(ev.name)) changed();
      },
    });
    sink.close();
    conv.history = trimHistory(updated || conv.history);
    try { if (design.snapshot(dir, text)) changed(); } catch {}
    if (ctrl.signal.aborted) throw new Error('stopped');
  }
}

module.exports = { ChatManager };

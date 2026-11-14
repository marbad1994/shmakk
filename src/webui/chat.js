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
const { runAgent, clearTaskJournal } = require('../agent');
const { CHAT_MODE_TOOLS } = require('../tools');
const { route: routeToSpecialist } = require('../coordinator');
const { shouldPlan, generatePlan, savePlan } = require('../planner');
const { clearIndex } = require('../workspace-index');
const { loadGlossary } = require('../glossary');
const { isConfigured } = require('../llm');
const { getEdits, clearEdits } = require('../edit-tracker');
const { unifiedDiff, newFileDiff } = require('../edit-viewer');
const { matchSelfCommand, executeSelfCommand } = require('../self-commands');
const { runTeam, looksMultiDomain } = require('../team');
const { addPlanTasks, markTaskComplete, markTaskSkipped } = require('../task-file');
const { captureGitSha, runPostPlanReview } = require('../code-reviewer');
const { classifyRunCommand } = require('../safety');
const sessionSearch = require('../session-search');
const { HELP } = require('../cli');
const audit = require('../audit');
const store = require('./store');

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

function titleFrom(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim().replace(/^[$!+]\s*/, '');
  return t.length > 52 ? `${t.slice(0, 50).trimEnd()}…` : (t || 'New chat');
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

  // ── conversation lifecycle ──────────────────────────────────────────────

  list() {
    const metas = store.listConversations();
    // live conversations may be newer than what's on disk
    const byId = new Map(metas.map((m) => [m.id, m]));
    for (const c of this.convs.values()) byId.set(c.id, { ...store.metaOf(c), running: !!c.run });
    return Array.from(byId.values()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  // workspace/repo are set for GitHub cloud sessions; plain chats use the
  // server's current workspace. mode: 'chat' (read-only tools) or 'code'
  // (full tool access, the default).
  create({ title, workspace: ws, repo = null, mode = 'code' } = {}) {
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
      mode: mode === 'chat' ? 'chat' : 'code',
      repo,
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
    if (patch.mode === 'chat' || patch.mode === 'code') conv.mode = patch.mode;
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
    const it = this._add(conv, { type: 'ask', status: 'pending', ...item });
    this._activity(conv, 'waiting for you');
    return new Promise((resolve) => {
      conv.asks.set(it.id, (value) => {
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
    const ws = path.resolve(conv.workspace || this.ctx.getWorkspace());
    const cwd = path.resolve(conv.cwd || ws);
    return cwd === ws ? [ws] : [ws, cwd];
  }

  // ── entry point ─────────────────────────────────────────────────────────

  // mode: 'ask' (default) or 'shell'. A leading "$ " also means shell.
  async send(convId, rawText, { mode = 'ask', attachments = [] } = {}) {
    const conv = this.get(convId);
    if (!conv) return { ok: false, error: 'conversation not found' };
    if (conv.run) return { ok: false, error: 'a run is already in progress' };
    let text = String(rawText || '').trim();
    if (!text) return { ok: false, error: 'empty message' };

    if (/^\$\s+/.test(text)) { mode = 'shell'; text = text.replace(/^\$\s+/, ''); }

    const atts = (Array.isArray(attachments) ? attachments : []).filter((a) => a && typeof a.path === 'string' && a.path);

    const ctrl = new AbortController();
    setMaxListeners(0, ctrl.signal);
    conv.run = { ctrl, activity: 'starting' };
    this.ctx.broadcast({ t: 'run', convId: conv.id, running: true, activity: 'starting' });

    this._add(conv, { type: 'user', text, mode, ...(atts.length ? { attachments: atts } : {}) });
    if (!conv.preview || conv.title === 'New chat') {
      if (conv.title === 'New chat') conv.title = titleFrom(text);
      conv.preview = text.slice(0, 140);
      this.ctx.broadcast({ t: 'conv', conv: { ...store.metaOf(conv), running: true } });
    }

    if (!conv.sessionId) {
      conv.sessionId = sessionSearch.makeSessionId();
      try { sessionSearch.recordSessionStart({ sessionId: conv.sessionId, workspace: conv.workspace, pid: process.pid }); } catch {}
      audit.append({ kind: 'session-start', sessionId: conv.sessionId, workspace: conv.workspace, via: 'web', review: !!this.ctx.settings.review, pid: process.pid });
    }

    // Attachments become readable paths for the agent; the transcript keeps the clean text.
    const agentText = atts.length
      ? `${text}\n\n[Attached files — in the workspace, inspect with read_file if needed:]\n${atts.map((a) => `- ${a.path}`).join('\n')}`
      : text;

    // Fire and forget — progress flows through broadcasts.
    this._run(conv, agentText, mode, ctrl).catch(() => {});
    return { ok: true };
  }

  async _run(conv, text, mode, ctrl) {
    // Chat conversations are read-only: a stray shell request must not execute.
    if (conv.mode === 'chat' && mode === 'shell') mode = 'ask';
    try {
      const selfCmd = matchSelfCommand(text);
      if (selfCmd.matched && mode !== 'shell') {
        await this._selfCommand(conv, text, selfCmd);
      } else if (mode === 'shell') {
        await this._shell(conv, text, ctrl);
      } else {
        await this._task(conv, text, ctrl);
      }
    } catch (e) {
      if (isAbortError(e) || ctrl.signal.aborted) {
        this._notice(conv, 'Stopped.', 'warn');
      } else {
        this._notice(conv, `Task error: ${e && e.message ? e.message : e}`, 'error');
        if (this.ctx.settings.debug && e && e.stack) this._add(conv, { type: 'output', title: 'stack trace', text: e.stack });
      }
    } finally {
      for (const resolve of Array.from(conv.asks.values())) resolve('aborted');
      for (const it of conv.items) {
        if (it.streaming) { it.streaming = false; this._touch(conv, it); }
        if (it.type === 'tool' && it.status === 'running') { it.status = 'interrupted'; this._touch(conv, it); }
      }
      conv.run = null;
      conv.updatedAt = Date.now();
      store.saveConversation(conv);
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
      const wouldAuto = safety === 'safe' || fileCreateAllowed;
      if (!settings.review && wouldAuto) {
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
      this._notice(conv, 'No AI provider configured. Add a base URL and model in Settings (or set SHMAKK_BASE_URL).', 'warn', { action: 'open:settings' });
      return;
    }
    process.env.SHMAKK_SESSION_ID = conv.sessionId || '';
    const roots = this.roots(conv);
    const routing = routeToSpecialist(cmd, [...conv.history, { role: 'user', content: cmd }]);
    const agentProfile = settings.profile || routing.profile || 'balanced';
    const chatMode = conv.mode === 'chat';
    const allowedTools = chatMode ? CHAT_MODE_TOOLS : null;
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
      specialistHint: routing.specialistHint,
      mcpManager,
      allowedTools,
      onEvent: sink,
    };

    // ── Team mode ──
    if (!chatMode && !settings.review && looksMultiDomain(cmd)) {
      let teamItem = null;
      let summary = '';
      let handled = false;
      try {
        handled = await runTeam({
          input: cmd, roots, write, signal: ctrl.signal, mcpManager,
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
    if (!chatMode && !settings.review && shouldPlan(cmd)) {
      this._activity(conv, 'generating plan');
      let plan = null;
      try { plan = await generatePlan(cmd, { signal: ctrl.signal }); }
      catch (e) {
        if (isAbortError(e) || ctrl.signal.aborted) throw e;
        this._notice(conv, 'Plan generation failed — running directly.', 'warn');
      }
      if (plan) {
        const planItem = this._add(conv, { type: 'plan', plan });
        const sync = () => { savePlan(roots[0], plan); planItem.plan = plan; this._touch(conv, planItem); };
        const approved = await this._ask(conv, { kind: 'plan', question: 'Approve this plan?', defaultYes: true });
        if (!approved) {
          plan.status = 'rejected';
          planItem.plan = plan; this._touch(conv, planItem);
          this._notice(conv, 'Plan rejected — rephrase your request, or prefix it with ! to run without a plan.', 'warn');
          return;
        }
        plan.status = 'executing';
        sync();
        const baseSha = captureGitSha(roots[0]);
        try { addPlanTasks(roots[0], plan); } catch {}

        for (let i = 0; i < plan.tasks.length; i++) {
          if (ctrl.signal.aborted) break;
          const task = plan.tasks[i];
          plan.currentTaskIndex = i;
          task.status = 'in_progress';
          sync();
          this._add(conv, { type: 'step', index: i + 1, total: plan.tasks.length, title: task.title, description: task.description });
          const taskInput = `[Task ${i + 1} of ${plan.tasks.length}: ${task.title}]\n${task.description}\n\nOverall goal: ${plan.title}\n\nOriginal request: ${cmd}`;
          try {
            const updated = await runAgent({ ...agentOpts, input: taskInput, history: conv.history });
            sink.close();
            conv.history = trimHistory(updated || conv.history);
            if (ctrl.signal.aborted) { task.status = 'failed'; sync(); throw new Error('stopped'); }
            task.status = 'completed';
            task.completedAt = new Date().toISOString();
            sync();
            try { markTaskComplete(roots[0], task.title, task.completedAt); } catch {}
          } catch (e) {
            task.status = 'failed';
            sync();
            if (isAbortError(e) || ctrl.signal.aborted) { plan.status = 'aborted'; sync(); throw e; }
            this._notice(conv, `Task ${i + 1} failed: ${e.message}`, 'error');
            const skip = await this._ask(conv, { kind: 'confirm', question: `Skip task ${i + 1} and continue?`, defaultYes: false });
            if (!skip) {
              plan.status = 'aborted';
              sync();
              this._notice(conv, 'Plan aborted.', 'warn');
              return;
            }
            task.status = 'skipped';
            sync();
            try { markTaskSkipped(roots[0], task.title); } catch {}
          }
        }

        const completed = plan.tasks.filter((t) => t.status === 'completed').length;
        const skipped = plan.tasks.filter((t) => t.status === 'skipped').length;
        plan.status = 'completed';
        sync();
        this._notice(conv, `Plan done: ${completed}/${plan.tasks.length} tasks completed${skipped ? `, ${skipped} skipped` : ''}.`, 'ok');

        if (completed > 0 && !ctrl.signal.aborted) {
          try {
            this._activity(conv, 'reviewing changes');
            await runPostPlanReview({ plan, baseSha, agentOpts: { ...agentOpts, onEvent: this._eventSink(conv, { agentLabel: 'reviewer' }) }, write });
          } catch (e) {
            if (isAbortError(e) || ctrl.signal.aborted) throw e;
            this._notice(conv, `Review error: ${e.message}`, 'warn');
          }
        }
        return;
      }
    }

    // ── Single agent ──
    if (routing.indicator) this._add(conv, { type: 'route', specialist: routing.specialist, indicator: routing.indicator, profile: agentProfile });
    const updated = await runAgent({ ...agentOpts, input: cmd, history: conv.history });
    sink.close();
    conv.history = trimHistory(updated || conv.history);
    if (ctrl.signal.aborted) throw new Error('stopped');
  }
}

module.exports = { ChatManager };

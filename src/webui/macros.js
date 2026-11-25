// Macros: a trigger word that runs something.
//
// A macro is reached three ways:
//   1. the trigger word alone in a message:            "deploy"
//   2. the trigger word at the end of a sentence:      "bump the version then run the deploy macro"
//   3. offered as a Run macro / Cancel question when    askWhen: "after git push to main or dev"
//      the instruction on the macro matches a command
//
// What a macro does is one of two things:
//   • kind 'automation' — starts a saved automation (src/webui/automations.js)
//     in its own conversation; the automation's steps do the work;
//   • kind 'commands' — runs a short list of shell commands in the conversation
//     the macro was triggered from.

const fs = require('fs');
const path = require('path');
const store = require('./store');

const MAX_COMMANDS = 20;
const MAX_RUNS = 10;
const MAX_TRIGGER = 40;
const MAX_WORKSPACES = 20;
const MAX_WORKSPACE_PATH = 300;

// Words that carry no meaning in an askWhen instruction ("after git push to main").
const STOP = new Set([
  'a', 'an', 'the', 'after', 'before', 'when', 'whenever', 'if', 'then', 'or', 'and', 'to', 'on', 'of',
  'it', 'its', 'is', 'are', 'was', 'were', 'be', 'been', 'has', 'have', 'had', 'do', 'does', 'did',
  'me', 'i', 'you', 'my', 'your', 'that', 'this', 'there', 'here', 'for', 'in', 'at', 'from', 'with',
  'ask', 'run', 'runs', 'macro', 'once', 'any', 'every', 'each', 'just', 'only', 'successfully', 'done',
]);

class MacroError extends Error {}

// ── store ───────────────────────────────────────────────────────────────────

function filePath() { return path.join(store.stateDir(), 'macros.json'); }
function load() { try { const l = JSON.parse(fs.readFileSync(filePath(), 'utf8')); return Array.isArray(l) ? l : []; } catch { return []; } }
function save(list) {
  try {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    const tmp = `${filePath()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, filePath());
  } catch {}
}

// ── trigger matching ────────────────────────────────────────────────────────

// "then run the deploy macro" / "run deploy macro" — the trigger word sits at
// the end of a normal request, and everything before it becomes the input.
const RUN_MACRO = /(?:^|[\s,;:—–-])(?:and\s+)?(?:then\s+)?run\s+(?:the\s+)?["“']?([^"”']{1,60}?)["”']?\s+macro\b[.!]?$/i;

function nameOnly(text) {
  return String(text || '')
    .trim()
    .replace(/^\/+/, '')
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

// Same text with the spaces and dashes squeezed out: "ship it" == "ship-it".
function slug(text) { return nameOnly(text).replace(/[\s_-]+/g, ''); }

// ── askWhen instructions ────────────────────────────────────────────────────

// An instruction like "after git push to main or dev" becomes keyword sets:
// every keyword must appear in the command for it to count as a match.
//   git push to main      → [git, push, main]
//   … or dev              → [git, push, dev]   (the trailing word is swapped)
// A literal /regex/ or `regex` is used as-is for anything the keywords cannot
// express.
function conditionSets(instruction) {
  const text = String(instruction || '').trim();
  if (!text) return null;
  const literal = /^\/(.+)\/([a-z]*)$/i.exec(text) || /^`(.+)`$/.exec(text);
  if (literal) {
    try { return { re: new RegExp(literal[1], literal[2] || 'i') }; } catch { return null; }
  }
  const words = (s) => (s.toLowerCase().match(/[a-z0-9_.\/-]+/g) || []).filter((w) => w.length > 1 && !STOP.has(w));
  const [first, ...rest] = text.split(/\bor\b/i);
  const base = words(first);
  if (!base.length) return null;
  const sets = [base];
  for (const alt of rest) {
    const extra = words(alt);
    if (extra.length) sets.push([...base.slice(0, -1), ...extra]);
  }
  return { sets };
}

function conditionMatches(cond, cmd) {
  if (!cond) return false;
  const hay = String(cmd || '').toLowerCase();
  if (!hay) return false;
  if (cond.re) return cond.re.test(hay);
  return cond.sets.some((set) => set.every((w) => hay.includes(w)));
}

// ── normalise ───────────────────────────────────────────────────────────────

function normalizeTrigger(value) {
  const t = String(value == null ? '' : value).trim().replace(/^\/+/, '').replace(/\s+/g, ' ');
  if (!t) throw new MacroError('A macro needs a trigger word.');
  if (t.length > MAX_TRIGGER) throw new MacroError(`Keep the trigger word under ${MAX_TRIGGER} characters.`);
  if (!/^[\w][\w .'-]*$/u.test(t)) throw new MacroError('Use letters, digits, spaces, dots, dashes or underscores in the trigger word.');
  return t;
}

// ── workspace scope ─────────────────────────────────────────────────────────

// A macro with no workspaces fires anywhere. One or more limits it to those
// directories, compared as resolved paths so "~/repos/x" and "/home/me/repos/x"
// are the same workspace.
function normalizeWorkspaces(value) {
  const raw = Array.isArray(value) ? value : (typeof value === 'string' ? [value] : []);
  const out = [];
  for (const item of raw) {
    const text = String(item == null ? '' : item).trim();
    if (!text || text.length > MAX_WORKSPACE_PATH) continue;
    let resolved = text;
    try { resolved = path.resolve(text.replace(/^~(?=$|\/)/, require('os').homedir())); } catch { /* keep as typed */ }
    if (!out.includes(resolved)) out.push(resolved);
    if (out.length >= MAX_WORKSPACES) break;
  }
  return out;
}

// Is this macro allowed to fire in the given workspace? No list = anywhere.
function inScope(macro, workspace) {
  const scoped = (macro && macro.workspaces) || [];
  if (!scoped.length) return true;
  if (!workspace) return false;
  let here = String(workspace);
  try { here = path.resolve(here); } catch { /* keep as is */ }
  return scoped.includes(here);
}

function normalize(patch, base) {
  const m = { ...base };
  if (typeof patch.name === 'string') m.name = patch.name.trim().slice(0, 80) || m.name;
  if ('trigger' in patch) m.trigger = normalizeTrigger(patch.trigger);
  if (typeof patch.description === 'string') m.description = patch.description.trim().slice(0, 300);

  if (patch.kind === 'automation' || patch.kind === 'commands') m.kind = patch.kind;
  if ('automationId' in patch) m.automationId = patch.automationId ? String(patch.automationId) : null;

  if ('commands' in patch) {
    const raw = Array.isArray(patch.commands) ? patch.commands : String(patch.commands || '').split('\n');
    m.commands = raw.map((c) => String(c).trim()).filter(Boolean).slice(0, MAX_COMMANDS);
  }
  if (typeof patch.askWhen === 'string') m.askWhen = patch.askWhen.trim().slice(0, 200);
  if ('workspaces' in patch) m.workspaces = normalizeWorkspaces(patch.workspaces);
  if (typeof patch.enabled === 'boolean') m.enabled = patch.enabled;

  if (!m.name) m.name = m.trigger;
  if (m.kind === 'automation' && !m.automationId) throw new MacroError('Pick the automation this macro starts.');
  if (m.kind === 'commands' && !(m.commands || []).length) throw new MacroError('Add at least one command.');
  if (m.trigger) {
    // Two macros answering to the same word would be a coin toss.
    const clash = m._siblings && m._siblings.find((o) => o.id !== m.id && slug(o.trigger) === slug(m.trigger));
    if (clash) throw new MacroError(`“${clash.trigger}” already runs the “${clash.name}” macro.`);
  }
  return m;
}

// ── engine ──────────────────────────────────────────────────────────────────

// ctx: { chat, automations, broadcast }
function createMacros(ctx) {
  let list = load();
  const running = new Set();      // macro ids with a run in flight
  const pending = new Map();      // conv id → [{ macroId, cmd }] matched but not offered yet

  const changed = () => { save(list); try { ctx.broadcast({ t: 'macros.changed' }); } catch {} };
  const find = (id) => list.find((m) => m.id === id) || null;
  const view = (m) => ({
    ...m,
    workspaces: Array.isArray(m.workspaces) ? m.workspaces : [],
    automation: m.automationId && ctx.automations ? (ctx.automations.list().find((a) => a.id === m.automationId) || null) : null,
    running: running.has(m.id),
  });

  function create(patch) {
    const now = Date.now();
    const draft = { id: store.newId('m'), name: '', description: '', trigger: '', kind: 'commands', automationId: null, commands: [], askWhen: '', workspaces: [], enabled: true, createdAt: now, updatedAt: now, runs: [], lastRunAt: null, lastStatus: null };
    const m = normalize(patch || {}, { ...draft, _siblings: list });
    delete m._siblings;
    list.unshift(m);
    changed();
    return view(m);
  }

  function update(id, patch) {
    const i = list.findIndex((m) => m.id === id);
    if (i === -1) return null;
    const m = normalize(patch || {}, { ...list[i], _siblings: list });
    delete m._siblings;
    if (typeof patch.name !== 'string' && list[i].name === list[i].trigger) m.name = m.trigger;
    m.updatedAt = Date.now();
    list[i] = m;
    changed();
    return view(m);
  }

  function remove(id) {
    const before = list.length;
    list = list.filter((m) => m.id !== id);
    if (list.length !== before) changed();
    return list.length !== before;
  }

  // Which macro does this message invoke? Either the trigger word on its own,
  // or the "… then run the <trigger> macro" phrasing. `workspace` is the
  // conversation's folder: a macro scoped to other workspaces stays quiet.
  function match(text, workspace = null) {
    const body = String(text || '').trim();
    if (!body) return null;
    const enabled = list.filter((m) => m.enabled && m.trigger && inScope(m, workspace));
    const exact = enabled.find((m) => slug(m.trigger) === slug(body) || nameOnly(m.trigger) === nameOnly(body));
    if (exact) return { macro: view(exact), input: '', via: 'exact' };
    const hit = RUN_MACRO.exec(body);
    if (!hit) return null;
    const wanted = slug(hit[1]);
    if (!wanted) return null;
    const macro = enabled.find((m) => slug(m.trigger) === wanted || slug(m.name) === wanted);
    if (!macro) return null;
    const input = body.slice(0, hit.index).replace(/[\s,;:—–-]+$/, '').trim();
    return { macro: view(macro), input, via: 'phrase' };
  }

  // A command ran in a conversation: remember every macro whose askWhen
  // instruction it satisfies. The question waits until the run is over, so it
  // is never raced by the run's own cleanup.
  function noteCommand(convId, cmd) {
    if (!convId || !cmd) return;
    const conv = ctx.chat && typeof ctx.chat.get === 'function' ? ctx.chat.get(convId) : null;
    if (!conv) return;
    for (const m of list) {
      if (!m.enabled || !m.askWhen) continue;
      if (!inScope(m, conv.workspace)) continue;
      if (!conditionMatches(conditionSets(m.askWhen), cmd)) continue;
      const queue = pending.get(conv.id) || [];
      if (queue.some((q) => q.macroId === m.id)) continue;
      queue.push({ macroId: m.id, cmd: String(cmd).slice(0, 300) });
      pending.set(conv.id, queue);
    }
  }

  // Post the Run macro / Cancel question(s) collected for this conversation.
  // Called when a run ends; a busy conversation is retried on the next flush.
  function flush(conv) {
    if (!conv || conv.run) return;
    const queue = pending.get(conv.id);
    if (!queue || !queue.length) return;
    pending.delete(conv.id);
    for (const { macroId, cmd } of queue) {
      const m = find(macroId);
      if (!m || !m.enabled) continue;
      void offer(conv, m, cmd);
    }
  }

  async function offer(conv, m, cmd) {
    const chat = ctx.chat;
    if (!chat || typeof chat._ask !== 'function') return;
    const yes = await chat._ask(conv, {
      kind: 'confirm',
      title: 'Run this macro?',
      question: `Run the “${m.name}” macro now?`,
      detail: `${m.askWhen}\n\nMatched: ${cmd}`,
      defaultYes: false,
      yesLabel: 'Run macro',
      noLabel: 'Cancel',
      macroId: m.id,
    });
    if (!yes) return;
    await runInConversation(m, { conv, chat, ctrl: new AbortController(), input: '', via: 'condition' });
  }

  // Execute a macro. Commands run in the given conversation (its transcript is
  // the run log); an automation starts its own conversation instead.
  async function runInConversation(macro, { conv, chat, ctrl, input = '', via = 'exact' } = {}) {
    const m = find(macro.id) || macro;
    if (running.has(m.id)) throw new MacroError('this macro is already running');
    const started = Date.now();
    const rec = { id: store.newId('mr'), at: started, via, input: String(input || '').slice(0, 200), status: 'running', convId: conv ? conv.id : null };
    m.runs = [rec, ...(m.runs || [])].slice(0, MAX_RUNS);
    m.lastRunAt = started;
    m.lastStatus = 'running';
    running.add(m.id);
    changed();

    const finish = (status, summary) => {
      rec.status = status;
      rec.summary = String(summary || '').replace(/\s+/g, ' ').slice(0, 240);
      rec.durationMs = Date.now() - started;
      m.lastStatus = status;
      running.delete(m.id);
      changed();
      try { ctx.broadcast({ t: 'macro.finished', id: m.id, name: m.name, status }); } catch {}
    };

    try {
      if (m.kind === 'automation') {
        const a = ctx.automations ? ctx.automations.list().find((x) => x.id === m.automationId) : null;
        if (!a) throw new MacroError('the automation this macro starts no longer exists');
        const r = await ctx.automations.run(a.id, { trigger: 'macro' });
        finish('ok', `started “${a.name}”`);
        if (chat && conv) chat._notice(conv, `Automation “${a.name}” is running in its own conversation.`, 'ok', { macroId: m.id, convId: r && r.convId });
        return { status: 'ok', convId: r && r.convId };
      }
      if (!chat || typeof chat._shell !== 'function') throw new MacroError('commands can only run inside a conversation');
      const prompt = input ? ` (${input})` : '';
      for (const [i, cmd] of (m.commands || []).entries()) {
        if (ctrl && ctrl.signal.aborted) { finish('stopped', 'stopped'); return { status: 'stopped' }; }
        if (chat._notice && i === 0) chat._notice(conv, `Running ${m.commands.length} command${m.commands.length === 1 ? '' : 's'}${prompt}.`, 'info', { macroId: m.id });
        await chat._shell(conv, cmd, ctrl);
      }
      finish('ok', `${m.commands.length} command${m.commands.length === 1 ? '' : 's'} finished`);
      return { status: 'ok' };
    } catch (e) {
      finish('error', e && e.message);
      throw e;
    }
  }

  // Wire the agent's own `run` tool into the askWhen check: commands the agent
  // runs count the same as commands typed after "$".
  try {
    require('../tools').setCommandObserver(({ cmd, scope }) => { if (scope) noteCommand(scope, cmd); });
  } catch {}

  return {
    list: () => list.slice().sort((a, b) => b.updatedAt - a.updatedAt).map(view),
    get: (id) => { const m = find(id); return m ? view(m) : null; },
    create, update, remove,
    match, noteCommand, flush, runInConversation,
    // Run by id from the UI: needs a conversation to write into.
    run(id, { input = '', workspace = null } = {}) {
      const m = find(id);
      if (!m) return null;
      if (m.kind === 'automation') return runInConversation(m, { input, via: 'manual' });
      const conv = ctx.chat.create({ title: `${m.name} · ${new Date().toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}`, mode: 'code', workspace: workspace || undefined });
      const ctrl = new AbortController();
      void runInConversation(m, { conv, chat: ctx.chat, ctrl, input, via: 'manual' }).catch(() => {});
      return { convId: conv.id };
    },
  };
}

module.exports = { createMacros, MacroError, conditionSets, conditionMatches, normalizeTrigger, slug };

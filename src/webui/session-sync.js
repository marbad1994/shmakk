// Mirror sessions started outside the desktop app into its conversation list.
//
// The CLI (`shmakk`) records every session and turn in the shared SQLite index
// at ~/.config/shmakk/sessions.db (see src/session-search.js). The desktop app
// has its own store of conversations under ~/.local/state/shmakk/web/
// conversations. Without this module a terminal session exists in the index
// but never shows up in the sidebar, so the same machine looks like two
// unrelated tools.
//
// Here each indexed session that no conversation owns yet is written out as a
// normal conversation file (`s_<session-id>`), refreshed from the index as new
// turns land. The result is ordinary data: it can be opened, renamed, pinned,
// or continued in the UI. Once the user sends from the app the mirror stops
// updating (`adopt()`), so the two sources never fight over the transcript.
//
// Bookkeeping lives in ~/.local/state/shmakk/web/cli-sessions.json:
//   owned   sessionId → convId   session belongs to a conversation already
//   mirrors sessionId → { convId, turns }   turns already written out
//   hidden  sessionId → ts       user deleted the mirror, don't bring it back

const fs = require('fs');
const path = require('path');
const store = require('./store');
const sessionSearch = require('../session-search');

const MIN_SYNC_MS = 800;     // throttle: list() and the poller both call in
const MAX_SESSIONS = 300;    // newest sessions considered on each pass
const MAX_TITLE = 52;

let lastSyncAt = 0;
let state = null;

function mirrorStatePath() {
  return path.join(store.stateDir(), 'cli-sessions.json');
}

function loadState() {
  if (state) return state;
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(mirrorStatePath(), 'utf8')) || {}; } catch {}
  state = {
    version: 1,
    owned: raw.owned && typeof raw.owned === 'object' ? raw.owned : {},
    mirrors: raw.mirrors && typeof raw.mirrors === 'object' ? raw.mirrors : {},
    hidden: raw.hidden && typeof raw.hidden === 'object' ? raw.hidden : {},
  };
  return state;
}

function saveState() {
  if (!state) return;
  try {
    fs.mkdirSync(path.dirname(mirrorStatePath()), { recursive: true });
    const tmp = `${mirrorStatePath()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, mirrorStatePath());
  } catch { /* best effort: the mirror rebuilds itself from the index */ }
}

// Tests run several homes in one process; drop the memoised state between them.
function _resetForTests() { state = null; lastSyncAt = 0; }

// Stable, safe id (store.safeId wants ^[a-z]_[a-z0-9]{6,40}$). Session ids are
// `<date>-<hex>`, so dropping the punctuation keeps them unique and readable.
function convIdFor(sessionId) {
  const body = String(sessionId || '').replace(/[^a-z0-9]/gi, '').slice(0, 38);
  return `s_${body || 'unknown'}`;
}

function titleFrom(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > MAX_TITLE ? `${t.slice(0, MAX_TITLE - 2).trimEnd()}…` : (t || 'Terminal session');
}

function itemForTurn(turn) {
  const at = Number(turn.ts) || Date.now();
  const text = String(turn.content || '');
  if (turn.role === 'assistant') return { type: 'assistant', text, at, agent: null };
  if (turn.role === 'user') return { type: 'user', text, mode: 'ask', at };
  return { type: 'output', title: String(turn.role || 'output'), text, at };
}

// Mark a session as belonging to a conversation created here, so it is never
// mirrored back as a second, terminal-flavoured chat.
function claim(sessionId, convId) {
  if (!sessionId) return;
  const s = loadState();
  if (s.owned[sessionId] === convId) return;
  s.owned[sessionId] = convId || null;
  saveState();
}

// The user deleted a mirrored conversation: keep the CLI session deleted from
// the app's point of view until they ask for it again.
function hide(sessionId) {
  if (!sessionId) return;
  const s = loadState();
  s.hidden[sessionId] = Date.now();
  delete s.mirrors[sessionId];
  saveState();
}

function forget(sessionId) {
  if (!sessionId) return;
  const s = loadState();
  delete s.mirrors[sessionId];
  delete s.owned[sessionId];
  saveState();
}

// The conversation is continued from the app: it becomes the owner of the
// session and the mirror stops writing turns into it.
function adopt(conv) {
  if (!conv || !conv.sessionId) return;
  const s = loadState();
  delete s.mirrors[conv.sessionId];
  s.owned[conv.sessionId] = conv.id;
  saveState();
}

// One-time backfill: conversations that predate this module already own their
// session (they carry a sessionId), so learn about them before mirroring.
function seedFromConversations() {
  const s = loadState();
  let known = 0;
  for (const meta of store.listConversations()) {
    if (!meta.sessionId) continue;
    if (meta.origin === 'cli') {
      if (!s.mirrors[meta.sessionId]) s.mirrors[meta.sessionId] = { convId: meta.id, turns: 0 };
    } else {
      s.owned[meta.sessionId] = meta.id;
    }
    known++;
  }
  s.seeded = true;
  saveState();
  return known;
}

// Build the transcript for the turns that are new since the last pass.
function appendTurns(conv, turns) {
  const changes = { items: [], touched: false };
  let first = conv.items.length === 0;
  for (const turn of turns) {
    const item = itemForTurn(turn);
    item.id = `i${++conv.seq}`;
    conv.items.push(item);
    const text = String(turn.content || '');
    if (turn.role === 'user' || turn.role === 'assistant') {
      conv.history.push({ role: turn.role, content: text });
      // The index can hold very long sessions; keep the prompt history bounded.
      if (conv.history.length > 60) conv.history.splice(0, conv.history.length - 60);
    }
    conv.updatedAt = Math.max(conv.updatedAt || 0, item.at);
    if (turn.role === 'user') {
      if (first) conv.title = titleFrom(text);
      conv.preview = text.replace(/\s+/g, ' ').trim().slice(0, 140);
    }
    first = false;
    changes.items.push(item);
    changes.touched = true;
  }
  conv.preview = conv.preview || '';
  return changes;
}

function createMirror(row, turns) {
  const workspace = row.workspace || null;
  const firstUser = turns.find((t) => t.role === 'user');
  const conv = {
    id: convIdFor(row.id),
    title: firstUser ? titleFrom(firstUser.content) : 'Terminal session',
    createdAt: Number(row.started_at) || Date.now(),
    updatedAt: Number(row.started_at) || Date.now(),
    pinned: false,
    workspace,
    cwd: workspace,
    preview: '',
    sessionId: row.id,
    repo: null,
    mode: 'code',
    projectId: null,
    automationId: null,
    origin: 'cli',
    items: [],
    history: [],
    seq: 0,
  };
  const changes = appendTurns(conv, turns);
  store.saveConversation(conv);
  return { conv, items: changes.items };
}

// Append whatever the index learned since the last pass.
function refreshMirror(conv, turns) {
  // `seq` is rebuilt from the items already on disk so ids never collide.
  conv.seq = conv.items.reduce((m, it) => Math.max(m, Number(String(it.id).slice(1)) || 0), 0);
  if (!Array.isArray(conv.history)) conv.history = [];
  conv.history = conv.history.filter((h) => h && (h.role === 'user' || h.role === 'assistant'));
  const changes = appendTurns(conv, turns);
  if (changes.touched) store.saveConversation(conv);
  return changes.items;
}

// Pull new turns from the index into the conversation files.
// Returns the conversations that changed plus the items appended to each, so
// the caller can broadcast them to connected windows.
function sync({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastSyncAt < MIN_SYNC_MS) return { changed: [], items: [] };
  lastSyncAt = now;

  const empty = { changed: [], items: [] };
  if (!sessionSearch.isAvailable()) return empty;

  const s = loadState();
  if (!s.seeded) seedFromConversations();

  let rows = [];
  try {
    rows = sessionSearch.listSessionsWithTurns({ limit: MAX_SESSIONS });
  } catch {
    return empty;
  }
  if (!rows.length) return empty;

  const changed = [];
  const items = [];

  for (const row of rows) {
    const sessionId = row.id;
    if (!sessionId || !row.turn_count) continue;
    if (s.hidden[sessionId]) continue;
    if (s.owned[sessionId]) continue;

    const mirror = s.mirrors[sessionId];
    try {
      if (!mirror) {
        // A file may already exist (restored backup, state file lost). Keep it
        // and continue from the items it holds instead of overwriting.
        const convId = convIdFor(sessionId);
        const existing = store.loadConversation(convId);
        if (existing) {
          const turns = Math.min(existing.items.length, row.turn_count);
          s.mirrors[sessionId] = { convId, turns };
          if (row.turn_count > turns) {
            const fresh = sessionSearch.getSessionTurns(sessionId, { limit: row.turn_count }).slice(turns);
            const added = refreshMirror(existing, fresh);
            s.mirrors[sessionId].turns = row.turn_count;
            for (const it of added) items.push({ convId, item: it });
            changed.push(store.metaOf(existing));
          }
          continue;
        }
        const all = sessionSearch.getSessionTurns(sessionId, { limit: row.turn_count });
        if (!all.length) continue;
        const { conv, items: added } = createMirror(row, all);
        s.mirrors[sessionId] = { convId: conv.id, turns: all.length };
        for (const it of added) items.push({ convId: conv.id, item: it });
        changed.push(store.metaOf(conv));
        continue;
      }

      if (row.turn_count <= mirror.turns) continue;
      const conv = store.loadConversation(mirror.convId);
      if (!conv) { delete s.mirrors[sessionId]; continue; }
      // Trust what is actually on disk: if a live in-memory copy overwrote the
      // file, the missing turns are appended again instead of being lost.
      const written = Math.min(mirror.turns, conv.items.length);
      if (row.turn_count <= written) { mirror.turns = written; saveState(); continue; }
      const fresh = sessionSearch.getSessionTurns(sessionId, { limit: row.turn_count }).slice(written);
      if (!fresh.length) { mirror.turns = row.turn_count; continue; }
      const added = refreshMirror(conv, fresh);
      mirror.turns = row.turn_count;
      for (const it of added) items.push({ convId: conv.id, item: it });
      changed.push(store.metaOf(conv));
    } catch {
      // One bad session must not stop the rest.
    }
  }

  if (changed.length) saveState();
  return { changed, items };
}

module.exports = { sync, claim, hide, forget, adopt, convIdFor, mirrorStatePath, _resetForTests };

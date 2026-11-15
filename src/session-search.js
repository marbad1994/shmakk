// Cross-session search via SQLite FTS5.
//
// Indexes every session's turns (user input, assistant output, tool calls)
// into a local SQLite DB at ~/.config/shmakk/sessions.db. Provides full-text
// search and LLM-summarized recall.
//
// Source of truth: the audit log at ~/.local/state/shmakk/audit.log.
// We add new `kind: 'turn'` entries from the agent loop to capture LLM
// conversation that isn't otherwise persisted. The indexer reads forward
// from the last indexed byte offset on each session start.
//
// Dependency: better-sqlite3 (optional). If not installed, all functions
// degrade gracefully — search returns empty, indexing is a no-op.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const audit = require('./audit');

let Database = null;
let dbAvailable = null;     // null = unchecked, true/false = result
function loadDatabase() {
  if (dbAvailable === false) return null;
  if (Database) return Database;
  try {
    Database = require('better-sqlite3');
    dbAvailable = true;
    return Database;
  } catch {
    dbAvailable = false;
    return null;
  }
}

function dbPath() {
  return path.join(os.homedir(), '.config', 'shmakk', 'sessions.db');
}

function indexerStatePath() {
  return path.join(os.homedir(), '.config', 'shmakk', 'sessions-indexer.json');
}

// ── Schema ───────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  workspace   TEXT,
  pid         INTEGER,
  summary     TEXT
);

CREATE TABLE IF NOT EXISTS turns (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  role        TEXT NOT NULL,
  content     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, ts);

CREATE TABLE IF NOT EXISTS files_touched (
  session_id  TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  tool        TEXT NOT NULL,
  path        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_session ON files_touched(session_id);
CREATE INDEX IF NOT EXISTS idx_files_path ON files_touched(path);

CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
  content,
  session_id UNINDEXED,
  ts UNINDEXED,
  role UNINDEXED,
  content='turns',
  content_rowid='id',
  tokenize='porter unicode61'
);

-- Keep FTS in sync with turns table
CREATE TRIGGER IF NOT EXISTS turns_ai AFTER INSERT ON turns BEGIN
  INSERT INTO turns_fts(rowid, content, session_id, ts, role)
  VALUES (new.id, new.content, new.session_id, new.ts, new.role);
END;
CREATE TRIGGER IF NOT EXISTS turns_ad AFTER DELETE ON turns BEGIN
  INSERT INTO turns_fts(turns_fts, rowid, content) VALUES('delete', old.id, old.content);
END;
`;

// ── Connection management ────────────────────────────────────────────────

let _db = null;
function getDB() {
  const D = loadDatabase();
  if (!D) return null;
  if (_db) return _db;
  try {
    fs.mkdirSync(path.dirname(dbPath()), { recursive: true });
    _db = new D(dbPath());
    _db.pragma('journal_mode = WAL');
    _db.pragma('synchronous = NORMAL');
    _db.exec(SCHEMA);
    return _db;
  } catch (e) {
    if (process.env.SHMAKK_DEBUG) process.stderr.write(`[shmakk] session-search: ${e.message}\n`);
    return null;
  }
}

function closeDB() {
  if (_db) {
    try { _db.close(); } catch {}
    _db = null;
  }
}

// ── Session ID generation ────────────────────────────────────────────────

function makeSessionId() {
  const date = new Date().toISOString().slice(0, 10);
  const rand = crypto.randomBytes(4).toString('hex');
  return `${date}-${rand}`;
}

// ── Session resume ────────────────────────────────────────────────────────

// Returns the most recent active session for a workspace, or null if none.
// An "active" session has ended_at IS NULL. No time or PID check; sessions
// live until explicitly ended (by process exit or --new-session).
function findActiveSession(workspace) {
  if (!workspace) return null;
  const db = getDB();
  if (!db) return null;
  try {
    return db.prepare(
      'SELECT * FROM sessions WHERE workspace = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1'
    ).get(workspace) || null;
  } catch {
    return null;
  }
}

// Update the PID for an existing session (called on resume, so the current
// process becomes the session's recorded owner).
function updateSessionPid(sessionId, pid) {
  const db = getDB();
  if (!db) return;
  try {
    db.prepare('UPDATE sessions SET pid = ? WHERE id = ?').run(pid, sessionId);
  } catch {}
}

// ── Recording (called from session/agent code) ───────────────────────────

function recordSessionStart({ sessionId, workspace, pid }) {
  const db = getDB();
  if (!db) return;
  try {
    db.prepare('INSERT OR IGNORE INTO sessions (id, started_at, workspace, pid) VALUES (?, ?, ?, ?)')
      .run(sessionId, Date.now(), workspace || null, pid || null);
  } catch {}
}

function recordSessionEnd({ sessionId, summary = null }) {
  const db = getDB();
  if (!db) return;
  try {
    db.prepare('UPDATE sessions SET ended_at = ?, summary = COALESCE(?, summary) WHERE id = ?')
      .run(Date.now(), summary, sessionId);
  } catch {}
}

function recordTurn({ sessionId, role, content }) {
  if (!sessionId || !content) return;
  const db = getDB();
  if (!db) return;
  const text = String(content).slice(0, 50000);  // cap per-turn size
  try {
    db.prepare('INSERT INTO turns (session_id, ts, role, content) VALUES (?, ?, ?, ?)')
      .run(sessionId, Date.now(), String(role || 'user'), text);
  } catch {}
}

function recordFileTouched({ sessionId, tool, filePath }) {
  if (!sessionId || !filePath) return;
  const db = getDB();
  if (!db) return;
  try {
    db.prepare('INSERT INTO files_touched (session_id, ts, tool, path) VALUES (?, ?, ?, ?)')
      .run(sessionId, Date.now(), String(tool || 'unknown'), String(filePath));
  } catch {}
}

// ── Search ────────────────────────────────────────────────────────────────

// Escape FTS5 special chars in user query (the query is treated as a phrase
// match if it contains spaces and we don't add operators).
function buildFtsQuery(query) {
  const q = String(query || '').trim();
  if (!q) return null;
  // If query contains FTS operators (AND/OR/NOT/quoted), pass through
  if (/\b(AND|OR|NOT|NEAR)\b|["()*]/.test(q)) return q;
  // Otherwise: tokenize and join with implicit AND
  const tokens = q.split(/\s+/).filter(Boolean).map((t) =>
    /^[a-zA-Z0-9_-]+$/.test(t) ? t : `"${t.replace(/"/g, '""')}"`
  );
  return tokens.join(' ');
}

// Returns up to `limit` matching turns, joined with session metadata.
function searchTurns(query, { limit = 10, sinceDays = null } = {}) {
  const db = getDB();
  if (!db) return [];
  const fts = buildFtsQuery(query);
  if (!fts) return [];

  let sql = `
    SELECT
      t.id, t.session_id, t.ts, t.role,
      snippet(turns_fts, 0, '[', ']', '…', 24) AS snippet,
      s.workspace, s.started_at
    FROM turns_fts
    JOIN turns t       ON t.id = turns_fts.rowid
    JOIN sessions s    ON s.id = t.session_id
    WHERE turns_fts MATCH ?
  `;
  const params = [fts];

  if (sinceDays && Number.isFinite(sinceDays) && sinceDays > 0) {
    sql += ` AND t.ts >= ?`;
    params.push(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
  }

  sql += ` ORDER BY rank LIMIT ?`;
  params.push(Math.max(1, Math.min(100, Number(limit) || 10)));

  try {
    return db.prepare(sql).all(...params);
  } catch (e) {
    if (process.env.SHMAKK_DEBUG) process.stderr.write(`[shmakk] search error: ${e.message}\n`);
    return [];
  }
}

// Group hits by session and pull surrounding context (a few turns before/after).
function expandHits(hits, contextTurns = 2) {
  const db = getDB();
  if (!db || !hits.length) return [];

  // Group by session
  const bySession = new Map();
  for (const h of hits) {
    if (!bySession.has(h.session_id)) bySession.set(h.session_id, []);
    bySession.get(h.session_id).push(h);
  }

  const result = [];
  for (const [sessionId, sessionHits] of bySession) {
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    if (!session) continue;

    // For each hit, pull a small context window
    const turnRows = [];
    const seen = new Set();
    for (const h of sessionHits) {
      const around = db.prepare(`
        SELECT id, ts, role, content FROM turns
        WHERE session_id = ?
          AND id BETWEEN ? AND ?
        ORDER BY id
      `).all(sessionId, Math.max(1, h.id - contextTurns), h.id + contextTurns);
      for (const t of around) {
        if (!seen.has(t.id)) {
          seen.add(t.id);
          turnRows.push(t);
        }
      }
    }
    turnRows.sort((a, b) => a.id - b.id);

    result.push({
      sessionId,
      workspace: session.workspace,
      startedAt: session.started_at,
      hits: sessionHits.map((h) => ({ snippet: h.snippet, role: h.role, ts: h.ts })),
      turns: turnRows,
    });
  }

  // Sort sessions newest first
  result.sort((a, b) => b.startedAt - a.startedAt);
  return result;
}

function listSessions({ limit = 20 } = {}) {
  const db = getDB();
  if (!db) return [];
  try {
    return db.prepare(`
      SELECT s.*, (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.id) AS turn_count
      FROM sessions s
      ORDER BY s.started_at DESC
      LIMIT ?
    `).all(Math.max(1, Math.min(200, Number(limit) || 20)));
  } catch {
    return [];
  }
}

function getLastSession() {
  const db = getDB();
  if (!db) return null;
  try {
    return db.prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT 1').get() || null;
  } catch {
    return null;
  }
}

function getSessionTurns(sessionId, { limit = 200 } = {}) {
  const db = getDB();
  if (!db) return [];
  try {
    return db.prepare('SELECT * FROM turns WHERE session_id = ? ORDER BY id LIMIT ?')
      .all(sessionId, limit);
  } catch {
    return [];
  }
}

// ── Audit log indexer (incremental) ──────────────────────────────────────
//
// Catches up any audit events the DB hasn't seen yet. Tracks last indexed
// byte offset in ~/.config/shmakk/sessions-indexer.json so we never re-process.

function loadIndexerState() {
  try {
    const p = indexerStatePath();
    if (!fs.existsSync(p)) return { offset: 0 };
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return { offset: 0 }; }
}

function saveIndexerState(state) {
  try {
    const p = indexerStatePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(state, null, 2));
  } catch {}
}

// Process audit log forward from last offset. Most data is already captured
// via direct recordTurn() calls during a live session — this catches anything
// that was logged via audit.append() but not direct-recorded.
function indexAuditLog() {
  const db = getDB();
  if (!db) return { indexed: 0, skipped: 'no-db' };

  const logPath = audit.logPath();
  if (!fs.existsSync(logPath)) return { indexed: 0, skipped: 'no-log' };

  const state = loadIndexerState();
  let stat;
  try { stat = fs.statSync(logPath); } catch { return { indexed: 0, skipped: 'stat-fail' }; }

  // Log was truncated/rotated — reset
  if (stat.size < state.offset) state.offset = 0;
  if (stat.size === state.offset) return { indexed: 0, skipped: 'up-to-date' };

  let fd;
  try {
    fd = fs.openSync(logPath, 'r');
    const buf = Buffer.alloc(stat.size - state.offset);
    fs.readSync(fd, buf, 0, buf.length, state.offset);
    fs.closeSync(fd);

    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    let indexed = 0;
    const insertSession = db.prepare('INSERT OR IGNORE INTO sessions (id, started_at, workspace, pid) VALUES (?, ?, ?, ?)');
    const updateSession = db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL');
    const insertFile = db.prepare('INSERT INTO files_touched (session_id, ts, tool, path) VALUES (?, ?, ?, ?)');

    db.exec('BEGIN');
    try {
      for (const line of lines) {
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (!entry || !entry.kind) continue;
        const ts = entry.t ? Date.parse(entry.t) : Date.now();
        if (entry.kind === 'session-start' && entry.sessionId) {
          insertSession.run(entry.sessionId, ts, entry.workspace || null, entry.pid || null);
          indexed++;
        } else if (entry.kind === 'session-end' && entry.sessionId) {
          updateSession.run(ts, entry.sessionId);
          indexed++;
        } else if ((entry.kind === 'tool-allowed' || entry.kind === 'tool-proposed') && entry.sessionId && entry.args?.path) {
          insertFile.run(entry.sessionId, ts, entry.name || 'unknown', entry.args.path);
          indexed++;
        }
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    state.offset = stat.size;
    saveIndexerState(state);
    return { indexed };
  } catch (e) {
    if (fd) try { fs.closeSync(fd); } catch {}
    return { indexed: 0, error: e.message };
  }
}

function dbStats() {
  const db = getDB();
  if (!db) return { available: false };
  try {
    const sessions = db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
    const turns = db.prepare('SELECT COUNT(*) AS n FROM turns').get().n;
    const files = db.prepare('SELECT COUNT(*) AS n FROM files_touched').get().n;
    const oldest = db.prepare('SELECT MIN(started_at) AS t FROM sessions').get().t;
    const newest = db.prepare('SELECT MAX(started_at) AS t FROM sessions').get().t;
    return { available: true, path: dbPath(), sessions, turns, files, oldest, newest };
  } catch (e) {
    return { available: false, error: e.message };
  }
}

function isAvailable() {
  return loadDatabase() !== null;
}

module.exports = {
  isAvailable,
  makeSessionId,
  findActiveSession,
  updateSessionPid,
  recordSessionStart,
  recordSessionEnd,
  recordTurn,
  recordFileTouched,
  searchTurns,
  expandHits,
  listSessions,
  getLastSession,
  getSessionTurns,
  indexAuditLog,
  dbStats,
  closeDB,
  dbPath,
  getDB,
};

// Plan storage schema: a real SQLite table, migrated in place.
//
// This is the database half of the create-plan flow. It owns a `plans` table
// with a primary key and NOT NULL required fields, built by an idempotent
// migration, the same way src/session-search.js builds its tables.
//
// The web UI and the CLI plan runner (src/webui/plans.js, src/plan-runner.js)
// keep the authoritative, workspace-portable plan record as JSON files under
// <workspace>/.shmakk/plans/. This store is the durable row for the
// create-plan endpoint (next task): one row per plan, keyed by the same `id`
// the file store uses, so a plan persisted here can be joined back to its
// workspace record.
//
//   CREATE TABLE plans (
//     id        TEXT PRIMARY KEY NOT NULL,  -- plan id (primary key)
//     title     TEXT NOT NULL,
//     owner     TEXT NOT NULL,     -- $SHMAKK_OWNER, else the OS user
//     status    TEXT NOT NULL,
//     createdAt INTEGER NOT NULL,  -- epoch ms
//     updatedAt INTEGER NOT NULL   -- epoch ms
//   );
//
// Dependency: better-sqlite3 (optional). If not installed, every function
// degrades gracefully and isAvailable() reports false.

const fs = require('fs');
const os = require('os');
const path = require('path');

let Database = null;
let dbAvailable = null; // null = unchecked, true/false = result
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

function isAvailable() {
  return !!loadDatabase();
}

// Default store location. Override with SHMAKK_PLANS_DB for tests.
function defaultDbPath() {
  if (process.env.SHMAKK_PLANS_DB) return process.env.SHMAKK_PLANS_DB;
  return path.join(os.homedir(), '.config', 'shmakk', 'plans.db');
}

// Schema version, tracked in PRAGMA user_version. Bump when the DDL changes and
// add a migration step in migrate() below.
const SCHEMA_VERSION = 1;

// Required (NOT NULL) columns, matching the columns PLAN_SCHEMA marks
// non-nullable in src/webui/plans.js.
const REQUIRED_FIELDS = ['id', 'title', 'owner', 'status', 'createdAt', 'updatedAt'];

const PLANS_DDL = `
CREATE TABLE IF NOT EXISTS plans (
  id         TEXT PRIMARY KEY NOT NULL,
  title      TEXT NOT NULL,
  owner      TEXT NOT NULL,
  status     TEXT NOT NULL,
  createdAt  INTEGER NOT NULL,
  updatedAt  INTEGER NOT NULL
);
`;

// ── migration ───────────────────────────────────────────────────────────────

/**
 * Bring a database handle up to SCHEMA_VERSION. Idempotent: running it twice
 * is a no-op. `db` must be a better-sqlite3 handle.
 */
function migrate(db) {
  const D = loadDatabase();
  if (!D) return { ok: false, reason: 'better-sqlite3 unavailable' };
  if (!db || typeof db.exec !== 'function' || typeof db.pragma !== 'function') {
    throw new Error('plans-db: migrate() requires a better-sqlite3 handle');
  }
  const before = Number(db.pragma('user_version', { simple: true }) || 0);
  db.exec(PLANS_DDL);
  if (before < SCHEMA_VERSION) db.pragma(`user_version = ${SCHEMA_VERSION}`);
  return { ok: true, version: SCHEMA_VERSION };
}

// ── connection management ───────────────────────────────────────────────────

/**
 * Open (or reuse) the store and run the migration. Returns null when
 * better-sqlite3 is unavailable, mirroring src/session-search.js.
 */
let _db = null;
function getDB() {
  const D = loadDatabase();
  if (!D) return null;
  if (_db) return _db;
  const p = defaultDbPath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    _db = new D(p);
    _db.pragma('journal_mode = WAL');
    _db.pragma('synchronous = NORMAL');
    migrate(_db);
    return _db;
  } catch (e) {
    if (process.env.SHMAKK_DEBUG) process.stderr.write(`[shmakk] plans-db: ${e.message}\n`);
    _db = null;
    return null;
  }
}

/** Open a store at an explicit path (tests), with the schema already applied. */
function openDb(dbPath) {
  const D = loadDatabase();
  if (!D) return null;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new D(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  migrate(db);
  return db;
}

function closeDb(db) {
  if (!db) return;
  try { db.close(); } catch {}
  if (db === _db) _db = null;
}

// ── row access ──────────────────────────────────────────────────────────────

const ROW_SELECT = 'SELECT id, title, owner, status, createdAt, updatedAt FROM plans';

/** Validate the required fields before the INSERT, so the error names the field. */
function validateRow(row) {
  const problems = [];
  if (row == null || typeof row !== 'object') return ['record is not an object'];
  for (const f of ['id', 'title', 'owner', 'status']) {
    const v = row[f];
    if (typeof v !== 'string' || !v.trim()) problems.push(`${f} is required`);
  }
  if (!Number.isFinite(row.createdAt)) problems.push('createdAt must be an integer timestamp');
  if (!Number.isFinite(row.updatedAt)) problems.push('updatedAt must be an integer timestamp');
  return problems;
}

/**
 * Insert one plan row. Required fields must be present and non-null (validated
 * here and enforced by the NOT NULL constraints). Returns the inserted row.
 */
function createPlan(db, { id, title, owner, status = 'draft', createdAt = Date.now(), updatedAt = createdAt } = {}) {
  const D = loadDatabase();
  if (!D) return null;
  if (!db) throw new Error('plans-db: createPlan() requires a database handle');
  const problems = validateRow({ id, title, owner, status, createdAt, updatedAt });
  if (problems.length) {
    const e = new Error(`plan violates the plans schema: ${problems.join(', ')}`);
    e.status = 400;
    throw e;
  }
  db.prepare(
    'INSERT INTO plans (id, title, owner, status, createdAt, updatedAt) VALUES (@id, @title, @owner, @status, @createdAt, @updatedAt)'
  ).run({ id: id.trim(), title: title.trim(), owner: owner.trim(), status, createdAt, updatedAt });
  return getPlan(db, id.trim());
}

/** Fetch one row by primary key, or null when absent. */
function getPlan(db, id) {
  if (!db) return null;
  return db.prepare(`${ROW_SELECT} WHERE id = ?`).get(id) || null;
}

/** All rows, newest first. */
function listPlans(db) {
  if (!db) return [];
  return db.prepare(`${ROW_SELECT} ORDER BY updatedAt DESC`).all();
}

module.exports = {
  SCHEMA_VERSION,
  REQUIRED_FIELDS,
  PLANS_DDL,
  isAvailable,
  defaultDbPath,
  migrate,
  openDb,
  closeDb,
  getDB,
  createPlan,
  getPlan,
  listPlans,
};

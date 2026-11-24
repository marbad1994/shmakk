// Window awareness for shmakk on KDE Plasma (KWin).
//
// Three parts share this module:
//
//   store      SQLite tables fed by the KWin watcher script
//              (kwin/shmakk-watch) through `shmakk windows-daemon`.
//   predictor  pure functions over focus spans: usage totals and a
//              next-window model (weighted Markov chain, time-of-day aware).
//   layout     builds a one-off KWin script and runs it through
//              org.kde.KWin /Scripting, so placing windows needs no daemon.
//
// Privacy: window titles stay in the local database. The agent tools return
// them only when SHMAKK_WINDOWS_TITLES=1, because tool output goes to the
// model provider.
//
// Dependencies: better-sqlite3 (optional, already used by plans-db.js) for
// the store, gdbus (glib2) for talking to KWin. The daemon additionally needs
// dbus-next (optional) to own a name on the session bus.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const Screens = require('./windows-screens');
const Pairs = require('./windows-pairs');

const BUS_NAME = 'dev.shmakk.Windows';
const OBJ_PATH = '/dev/shmakk/Windows';
const IFACE = 'dev.shmakk.Windows';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const RETENTION_MS = 90 * DAY;

// ── store ───────────────────────────────────────────────────────────────────

let Database = null;
let dbAvailable = null;
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

function defaultDbPath() {
  if (process.env.SHMAKK_WINDOWS_DB) return process.env.SHMAKK_WINDOWS_DB;
  return path.join(os.homedir(), '.config', 'shmakk', 'windows.db');
}

const SCHEMA_VERSION = 3;

const DDL = `
CREATE TABLE IF NOT EXISTS windows (
  id         TEXT PRIMARY KEY NOT NULL,
  app        TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  pid        INTEGER,
  screen     TEXT,
  desktop    TEXT,
  x INTEGER, y INTEGER, w INTEGER, h INTEGER,
  minimized  INTEGER NOT NULL DEFAULT 0,
  isOpen     INTEGER NOT NULL DEFAULT 1,
  firstSeen  INTEGER NOT NULL,
  lastSeen   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS spans (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  windowId   TEXT NOT NULL,
  app        TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  startedAt  INTEGER NOT NULL,
  endedAt    INTEGER
);
CREATE INDEX IF NOT EXISTS spans_started ON spans(startedAt);
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY NOT NULL,
  v TEXT
);
CREATE TABLE IF NOT EXISTS proactive_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  t        INTEGER NOT NULL,
  fromApp  TEXT NOT NULL,
  toApp    TEXT NOT NULL,
  p        REAL NOT NULL,
  mode     TEXT NOT NULL,      -- suggest | auto
  outcome  TEXT NOT NULL       -- pending | split | focus | dismissed | auto | undone | unmuted
);
CREATE INDEX IF NOT EXISTS proactive_pair ON proactive_log(fromApp, toApp, t);
CREATE TABLE IF NOT EXISTS reorder_prefs (
  key    TEXT NOT NULL,        -- '<screens>s:<apps>' or '<screens>s:n<count>'
  kind   TEXT NOT NULL,        -- layout kind, e.g. split, main-stack, span
  score  REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (key, kind)
);
`;

function migrate(db) {
  const before = Number(db.pragma('user_version', { simple: true }) || 0);
  db.exec(DDL);
  if (before < SCHEMA_VERSION) db.pragma(`user_version = ${SCHEMA_VERSION}`);
  return { ok: true, version: SCHEMA_VERSION };
}

function openDb(dbPath = defaultDbPath()) {
  const D = loadDatabase();
  if (!D) return null;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new D(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 2000');
  migrate(db);
  return db;
}

let _db = null;
function getDB() {
  if (_db) return _db;
  try {
    _db = openDb();
  } catch (e) {
    if (process.env.SHMAKK_DEBUG) process.stderr.write(`[shmakk] windows-db: ${e.message}\n`);
    _db = null;
  }
  return _db;
}

function closeDb(db) {
  if (!db) return;
  try { db.close(); } catch {}
  if (db === _db) _db = null;
}

function setKv(db, k, v) {
  db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v == null ? null : String(v));
}

function getKv(db, k) {
  const row = db.prepare('SELECT v FROM kv WHERE k = ?').get(k);
  return row ? row.v : null;
}

function upsertWindow(db, w, t) {
  if (!w || !w.id) return;
  const g = w.geo || {};
  db.prepare(`
    INSERT INTO windows (id, app, title, pid, screen, desktop, x, y, w, h, minimized, isOpen, firstSeen, lastSeen)
    VALUES (@id, @app, @title, @pid, @screen, @desktop, @x, @y, @w, @h, @minimized, 1, @t, @t)
    ON CONFLICT(id) DO UPDATE SET
      app = excluded.app, title = excluded.title, pid = excluded.pid,
      screen = excluded.screen, desktop = excluded.desktop,
      x = excluded.x, y = excluded.y, w = excluded.w, h = excluded.h,
      minimized = excluded.minimized, isOpen = 1, lastSeen = excluded.lastSeen
  `).run({
    id: String(w.id),
    app: String(w.app || 'unknown'),
    title: String(w.title || ''),
    pid: Number.isFinite(w.pid) ? w.pid : null,
    screen: w.screen ? String(w.screen) : null,
    desktop: w.desktop ? String(w.desktop) : null,
    x: Number.isFinite(g.x) ? g.x : null,
    y: Number.isFinite(g.y) ? g.y : null,
    w: Number.isFinite(g.w) ? g.w : null,
    h: Number.isFinite(g.h) ? g.h : null,
    minimized: w.minimized ? 1 : 0,
    t,
  });
}

function openSpan(db) {
  return db.prepare('SELECT id, windowId FROM spans WHERE endedAt IS NULL ORDER BY startedAt DESC LIMIT 1').get() || null;
}

function closeSpans(db, t) {
  db.prepare('UPDATE spans SET endedAt = MAX(startedAt, ?) WHERE endedAt IS NULL').run(t);
}

function focusWindow(db, w, t) {
  const cur = openSpan(db);
  if (w && cur && cur.windowId === String(w.id)) {
    setKv(db, 'active', w.id);
    return;
  }
  closeSpans(db, t);
  if (w && w.id) {
    db.prepare('INSERT INTO spans (windowId, app, title, startedAt) VALUES (?, ?, ?, ?)')
      .run(String(w.id), String(w.app || 'unknown'), String(w.title || ''), t);
  }
  setKv(db, 'active', w && w.id ? w.id : null);
}

/**
 * Apply one watcher event to the store. Events come from
 * kwin/shmakk-watch/contents/code/main.js and from the one-off scripts below.
 */
function recordEvent(db, ev) {
  if (!db || !ev || typeof ev !== 'object') return false;
  const t = Number.isFinite(ev.t) ? ev.t : Date.now();
  const run = db.transaction(() => {
    switch (ev.kind) {
      case 'snapshot': {
        db.prepare('UPDATE windows SET isOpen = 0').run();
        const list = Array.isArray(ev.windows) ? ev.windows : [];
        for (const w of list) upsertWindow(db, w, t);
        const active = list.find((w) => w && w.id === ev.active) || null;
        focusWindow(db, active, t);
        break;
      }
      case 'open':
      case 'geometry':
        upsertWindow(db, ev.window, t);
        break;
      case 'close': {
        const id = ev.window && ev.window.id;
        if (!id) break;
        db.prepare('UPDATE windows SET isOpen = 0, lastSeen = ? WHERE id = ?').run(t, String(id));
        const cur = openSpan(db);
        if (cur && cur.windowId === String(id)) {
          closeSpans(db, t);
          setKv(db, 'active', null);
        }
        break;
      }
      case 'focus':
        if (ev.window) upsertWindow(db, ev.window, t);
        focusWindow(db, ev.window || null, t);
        break;
      default:
        return false;
    }
    setKv(db, 'lastEvent', t);
    return true;
  });
  return run();
}

/** Daemon startup and shutdown: close spans left open by a crash or logout. */
function closeDangling(db, t = Date.now()) {
  closeSpans(db, t);
  setKv(db, 'active', null);
}

function prune(db, now = Date.now(), keepMs = RETENTION_MS) {
  const cut = now - keepMs;
  db.prepare('DELETE FROM spans WHERE startedAt < ?').run(cut);
  db.prepare('DELETE FROM windows WHERE isOpen = 0 AND lastSeen < ?').run(cut);
}

function listOpenWindows(db) {
  return db.prepare(`
    SELECT id, app, title, pid, screen, desktop, x, y, w, h, minimized, lastSeen
    FROM windows WHERE isOpen = 1 ORDER BY lastSeen DESC
  `).all();
}

function loadSpans(db, since, now = Date.now()) {
  return db.prepare(`
    SELECT windowId, app, title, startedAt AS start, COALESCE(endedAt, ?) AS end
    FROM spans WHERE startedAt >= ? ORDER BY startedAt ASC
  `).all(now, since);
}

// ── predictor (pure) ────────────────────────────────────────────────────────

/** 0 night (0-5), 1 morning (6-11), 2 afternoon (12-17), 3 evening (18-23). */
function hourBucket(ms) {
  const h = new Date(ms).getHours();
  if (h < 6) return 0;
  if (h < 12) return 1;
  if (h < 18) return 2;
  return 3;
}

/**
 * Drop focus blips shorter than minDwellMs (alt-tab passes, notifications)
 * and merge consecutive spans of the same app, so transitions mean
 * "moved from working in A to working in B".
 */
function collapseSpans(spans, minDwellMs = 2000) {
  const out = [];
  for (const s of spans || []) {
    if (!s || !s.app) continue;
    const end = Number.isFinite(s.end) ? s.end : s.start;
    if (end - s.start < minDwellMs) continue;
    const last = out[out.length - 1];
    if (last && last.app === s.app) {
      last.end = Math.max(last.end, end);
      continue;
    }
    out.push({ app: s.app, start: s.start, end });
  }
  return out;
}

function addTo(map, key, next, w) {
  let row = map.get(key);
  if (!row) { row = new Map(); map.set(key, row); }
  row.set(next, (row.get(next) || 0) + w);
}

/**
 * Build a transition model. Each A -> B transition is weighted by recency
 * (half-life halfLifeMs) and counted three ways: per time-of-day bucket, per
 * app, and as a global prior on B.
 */
function buildModel(spans, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const halfLifeMs = opts.halfLifeMs || 14 * DAY;
  const seq = collapseSpans(spans, opts.minDwellMs == null ? 2000 : opts.minDwellMs);
  const byApp = new Map();
  const byBucket = new Map();
  const prior = new Map();
  for (let i = 0; i + 1 < seq.length; i++) {
    const a = seq[i].app;
    const b = seq[i + 1].app;
    const t = seq[i + 1].start;
    const w = Math.pow(0.5, Math.max(0, now - t) / halfLifeMs);
    addTo(byApp, a, b, w);
    addTo(byBucket, `${hourBucket(t)}|${a}`, b, w);
    prior.set(b, (prior.get(b) || 0) + w);
  }
  return { byApp, byBucket, prior, transitions: Math.max(0, seq.length - 1) };
}

function normalizeRow(row, exclude) {
  if (!row) return null;
  let total = 0;
  for (const [app, w] of row) if (!exclude.has(app)) total += w;
  if (!(total > 0)) return null;
  const out = new Map();
  for (const [app, w] of row) if (!exclude.has(app)) out.set(app, w / total);
  return out;
}

/**
 * Most likely next apps after `current`. Blends P(next | current, bucket),
 * P(next | current) and the global prior; components with no data drop out
 * and the rest are renormalized. `evidence` is the weighted number of
 * observed transitions out of `current`, a rough confidence signal.
 */
function predictNext(model, current, opts = {}) {
  const when = Number.isFinite(opts.when) ? opts.when : Date.now();
  const k = opts.k || 3;
  const exclude = new Set(opts.exclude || (current ? [current] : []));
  const parts = [
    [0.5, model.byBucket.get(`${hourBucket(when)}|${current}`)],
    [0.35, model.byApp.get(current)],
    [0.15, model.prior],
  ];
  const score = new Map();
  let wsum = 0;
  for (const [lambda, row] of parts) {
    const dist = normalizeRow(row, exclude);
    if (!dist) continue;
    wsum += lambda;
    for (const [app, p] of dist) score.set(app, (score.get(app) || 0) + lambda * p);
  }
  if (!wsum) return { predictions: [], evidence: 0 };
  let evidence = 0;
  const own = model.byApp.get(current);
  if (own) for (const w of own.values()) evidence += w;
  const predictions = [...score]
    .map(([app, s]) => ({ app, p: Math.round((s / wsum) * 1000) / 1000 }))
    .sort((x, y) => y.p - x.p || (x.app < y.app ? -1 : 1))
    .slice(0, k);
  return { predictions, evidence: Math.round(evidence * 100) / 100 };
}

/** Focused time per app, largest first. */
function usage(spans, opts = {}) {
  const per = new Map();
  let total = 0;
  for (const s of collapseSpans(spans, opts.minDwellMs == null ? 1000 : opts.minDwellMs)) {
    const d = s.end - s.start;
    const r = per.get(s.app) || { app: s.app, ms: 0, sessions: 0 };
    r.ms += d;
    r.sessions += 1;
    per.set(s.app, r);
    total += d;
  }
  return [...per.values()]
    .map((r) => ({ ...r, minutes: Math.round(r.ms / 6000) / 10, share: total ? Math.round((r.ms / total) * 1000) / 1000 : 0 }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, opts.limit || 20);
}

const RANGES = { '1h': HOUR, today: null, '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY, '90d': 90 * DAY };

function rangeStart(range, now = Date.now()) {
  if (range === 'today') {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  const ms = RANGES[range] || RANGES['7d'];
  return now - ms;
}

// ── KWin script runner ──────────────────────────────────────────────────────

function gdbus(args, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    execFile('gdbus', ['call', '--session', ...args], { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || '').toString().trim();
        reject(new Error(err.code === 'ENOENT' ? 'gdbus not found (install glib2)' : msg));
        return;
      }
      resolve(String(stdout).trim());
    });
  });
}

/** GVariant string literal for gdbus arguments. */
function gstr(s) {
  return `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * Load, run and unload a one-off KWin script. KWin runs it asynchronously, so
 * the promise resolves once the script was started, not when it finished.
 */
async function runKwinScript(source, opts = {}) {
  const tag = crypto.randomBytes(6).toString('hex');
  const name = `shmakk-oneoff-${tag}`;
  const file = path.join(os.tmpdir(), `${name}.js`);
  fs.writeFileSync(file, source, { mode: 0o600 });
  let id = -1;
  try {
    const out = await gdbus(['--dest', 'org.kde.KWin', '--object-path', '/Scripting',
      '--method', 'org.kde.kwin.Scripting.loadScript', gstr(file), gstr(name)]);
    const m = /-?\d+/.exec(out);
    id = m ? parseInt(m[0], 10) : -1;
    if (id < 0) throw new Error(`KWin refused the script (${out || 'no id'})`);
    await gdbus(['--dest', 'org.kde.KWin', '--object-path', `/Scripting/Script${id}`,
      '--method', 'org.kde.kwin.Script.run']);
  } catch (e) {
    try { fs.unlinkSync(file); } catch {}
    throw e;
  }
  const keepMs = opts.keepMs == null ? 1500 : opts.keepMs;
  // `done` resolves after the script is unloaded and its file removed; a
  // short-lived CLI process should await it before exiting.
  let finish;
  const done = new Promise((res) => { finish = res; });
  const cleanup = async () => {
    await gdbus(['--dest', 'org.kde.KWin', '--object-path', '/Scripting',
      '--method', 'org.kde.kwin.Scripting.unloadScript', gstr(name)]).catch(() => {});
    try { fs.unlinkSync(file); } catch {}
    finish();
  };
  const timer = setTimeout(cleanup, keepMs);
  if (timer.unref && !opts.keepAlive) timer.unref();
  return { id, name, done };
}

async function daemonRunning() {
  try {
    const out = await gdbus(['--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus',
      '--method', 'org.freedesktop.DBus.NameHasOwner', gstr(BUS_NAME)], 2000);
    return /true/.test(out);
  } catch {
    return false;
  }
}

// The watcher's shared block (describe, tracked, send, context, swapScreens)
// is the single source of truth for KWin-side helpers; one-off scripts are
// that block plus a small body.
const WATCHER_MAIN = path.join(__dirname, '..', '..', 'kwin', 'shmakk-watch', 'contents', 'code', 'main.js');
let _shared = null;
function kwinShared() {
  if (_shared) return _shared;
  const src = fs.readFileSync(WATCHER_MAIN, 'utf8');
  const a = src.indexOf('// BEGIN SHARED');
  const b = src.indexOf('// END SHARED');
  if (a < 0 || b < a) throw new Error(`shared block markers missing in ${WATCHER_MAIN}`);
  _shared = src.slice(a, b);
  return _shared;
}

const snapshotScript = () => `${kwinShared()}
(function () {
  var list = workspace.windowList();
  var out = [];
  for (var i = 0; i < list.length; i++) if (tracked(list[i])) out.push(describe(list[i]));
  var a = workspace.activeWindow;
  send({ kind: "snapshot", windows: out, active: tracked(a) ? String(a.internalId) : null });
})();
`;

/** Ask KWin to send a fresh snapshot to the daemon. */
function requestSnapshot() {
  return runKwinScript(snapshotScript());
}

const COMMANDS = ['reorder', 'swap-screens'];

/**
 * Run a shortcut command without the shortcut: 'reorder' sends the current
 * context to the daemon (which plans the layout), 'swap-screens' swaps
 * inside KWin directly.
 */
function runCommand(name, opts = {}) {
  if (!COMMANDS.includes(name)) throw new Error(`unknown command: ${name}`);
  const body = name === 'reorder' ? 'sendCommand("reorder");' : 'swapScreens();';
  return runKwinScript(`${kwinShared()}\n${body}\n`, opts);
}

// ── layout ──────────────────────────────────────────────────────────────────

function num(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Validate and normalize a layout request.
 *
 *   placements: [{ id | app, x, y, w, h, unit: 'fraction' | 'px', screen, focus }]
 *
 * Fractions are relative to the work area (screen minus panels) of the
 * target screen. A placement without geometry only restores and, with
 * focus: true, activates the window.
 */
function normalizeLayout(spec) {
  const placements = Array.isArray(spec && spec.placements) ? spec.placements : null;
  if (!placements || !placements.length) return { error: 'placements must be a non-empty array' };
  if (placements.length > 24) return { error: 'at most 24 placements per layout' };
  const out = [];
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i] || {};
    const ref = p.id ? { id: String(p.id) } : p.app ? { app: String(p.app) } : null;
    if (!ref) return { error: `placement ${i}: give id or app` };
    const unit = p.unit === 'px' ? 'px' : 'fraction';
    const geo = ['x', 'y', 'w', 'h'].map((k) => p[k]);
    const hasGeo = geo.some((v) => v != null);
    const item = { ...ref, focus: !!p.focus };
    if (p.screen) item.screen = String(p.screen);
    if (hasGeo) {
      if (!geo.every(num)) return { error: `placement ${i}: x, y, w and h must all be numbers` };
      const [x, y, w, h] = geo;
      if (!(w > 0 && h > 0)) return { error: `placement ${i}: w and h must be positive` };
      if (unit === 'fraction' && (x < 0 || y < 0 || x + w > 1.0001 || y + h > 1.0001)) {
        return { error: `placement ${i}: fractions must stay inside 0..1` };
      }
      Object.assign(item, { unit, x, y, w, h });
    }
    out.push(item);
  }
  return { placements: out, minimizeOthers: !!(spec && spec.minimizeOthers) };
}

/** JSON is a JS literal, except U+2028/U+2029 in older engines. */
function jsLiteral(v) {
  return JSON.stringify(v).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function buildLayoutScript(layout) {
  return `${kwinShared()}
(function () {
  var L = ${jsLiteral(layout)};
  var all = workspace.windowList();
  var stack = workspace.stackingOrder;
  function find(p) {
    var i;
    if (p.id) {
      for (i = 0; i < all.length; i++) if (String(all[i].internalId) === p.id) return all[i];
      return null;
    }
    for (i = stack.length - 1; i >= 0; i--) {
      var w = stack[i];
      if (tracked(w) && String(w.resourceClass) === p.app) return w;
    }
    return null;
  }
  function outputNamed(name) {
    var s = workspace.screens;
    for (var i = 0; i < s.length; i++) if (String(s[i].name) === name) return s[i];
    return null;
  }
  var placed = [];
  var toFocus = null;
  for (var n = 0; n < L.placements.length; n++) {
    var p = L.placements[n];
    var w = find(p);
    if (!w) continue;
    if (w.minimized) w.minimized = false;
    if (w.fullScreen) w.fullScreen = false;
    var target = w.output;
    if (p.screen) {
      var o = outputNamed(p.screen);
      if (o) {
        if (String(o.name) !== String(w.output && w.output.name)) workspace.sendClientToScreen(w, o);
        target = o;
      }
    }
    if (p.unit) {
      if (typeof w.setMaximize === "function") w.setMaximize(false, false);
      var g;
      if (p.unit === "px") {
        g = { x: p.x, y: p.y, width: p.w, height: p.h };
      } else {
        var a = workspace.clientArea(KWin.MaximizeArea, target, workspace.currentDesktop);
        g = {
          x: Math.round(a.x + p.x * a.width),
          y: Math.round(a.y + p.y * a.height),
          width: Math.round(p.w * a.width),
          height: Math.round(p.h * a.height)
        };
      }
      w.frameGeometry = g;
    }
    placed.push(w);
    if (p.focus) toFocus = w;
  }
  if (L.minimizeOthers) {
    for (var m = 0; m < all.length; m++) {
      var x = all[m];
      if (!tracked(x) || placed.indexOf(x) >= 0 || x.minimized) continue;
      if (x.desktops && x.desktops.length) {
        var here = false;
        for (var d = 0; d < x.desktops.length; d++) if (x.desktops[d].id === workspace.currentDesktop.id) here = true;
        if (!here) continue;
      }
      x.minimized = true;
    }
  }
  // Raise placed windows so the layout is not hidden behind other windows;
  // the focused one is raised last by activating it.
  if (typeof workspace.raiseWindow === "function") {
    for (var q = 0; q < placed.length; q++) if (placed[q] !== toFocus) workspace.raiseWindow(placed[q]);
  }
  if (toFocus) workspace.activeWindow = toFocus;
  for (var r = 0; r < placed.length; r++) send({ kind: "geometry", window: describe(placed[r]) });
})();
`;
}

async function applyLayout(spec) {
  const layout = normalizeLayout(spec);
  if (layout.error) return layout;
  await runKwinScript(buildLayoutScript(layout));
  return { ok: true, applied: layout.placements.length, minimizeOthers: layout.minimizeOthers };
}

// ── agent tools ─────────────────────────────────────────────────────────────

const TOOL_NAMES = new Set(['window_list', 'window_usage', 'window_predict', 'window_layout', 'window_proactive', 'window_reorder', 'window_screens', 'window_pairs']);

function shareTitles() {
  return process.env.SHMAKK_WINDOWS_TITLES === '1';
}

function publicWindow(w) {
  const out = {
    id: w.id,
    app: w.app,
    screen: w.screen || undefined,
    desktop: w.desktop || undefined,
    geometry: num(w.x) ? { x: w.x, y: w.y, w: w.w, h: w.h } : undefined,
    minimized: !!w.minimized,
  };
  if (shareTitles()) out.title = w.title;
  return out;
}

function noStore() {
  return { error: 'window store unavailable: install better-sqlite3 (npm install better-sqlite3) and run `shmakk windows-daemon`' };
}

async function dispatchWindows(name, args = {}) {
  if (name === 'window_layout') {
    try {
      const r = await applyLayout(args);
      if (r.error) return r;
      await new Promise((res) => setTimeout(res, 300));
      const db = getDB();
      if (db) {
        const ids = new Set(normalizeLayout(args).placements.map((p) => p.id).filter(Boolean));
        r.windows = listOpenWindows(db).filter((w) => !ids.size || ids.has(w.id)).slice(0, 12).map(publicWindow);
      }
      return r;
    } catch (e) {
      return { error: `layout failed: ${e.message}` };
    }
  }

  if (name === 'window_reorder') {
    const cmd = args.action === 'swap-screens' ? 'swap-screens' : 'reorder';
    if (cmd === 'reorder' && !(await daemonRunning())) {
      return { error: 'reorder needs the windows daemon; start it with `shmakk windows-daemon`' };
    }
    try {
      await runCommand(cmd);
      return { ok: true, action: cmd, note: cmd === 'reorder' ? 'calling again within 90 seconds moves to the next layout' : undefined };
    } catch (e) {
      return { error: `${cmd} failed: ${e.message}` };
    }
  }

  if (name === 'window_screens') {
    const S = Screens;
    if (Array.isArray(args.order) && args.order.length) {
      const r = await S.setPriorities(args.order, { kscreen: args.kscreen !== false });
      if (r.error) return r;
      const queried = await S.queryScreensSafe();
      return { ...r, ...S.snapshot(queried.screens, r.order, { kscreen: r.kscreen, available: queried.ok, error: queried.ok ? undefined : queried.error }) };
    }
    const queried = await S.queryScreensSafe();
    const stored = S.readConfig();
    return S.snapshot(queried.screens, stored.order, {
      available: queried.ok,
      error: queried.ok ? undefined : queried.error,
      kscreenMirror: stored.kscreen,
      hint: 'pass order: ["DP-1", "HDMI-A-1"] to set which screen is main, which secondary',
    });
  }

  const db = getDB();
  if (!db) return noStore();
  const now = Date.now();

  if (name === 'window_list') {
    const running = await daemonRunning();
    const active = getKv(db, 'active');
    const lastEvent = Number(getKv(db, 'lastEvent')) || null;
    return {
      daemon: running,
      stale: !running,
      lastEventAgoSec: lastEvent ? Math.round((now - lastEvent) / 1000) : null,
      active,
      windows: listOpenWindows(db).map(publicWindow),
      hint: running ? undefined : 'windows daemon is not running; this list may be stale. Start it with `shmakk windows-daemon`.',
    };
  }

  if (name === 'window_usage') {
    const range = RANGES[args.range] !== undefined ? args.range : '7d';
    const spans = loadSpans(db, rangeStart(range, now), now);
    return { range, apps: usage(spans, { limit: Math.min(Math.max(args.limit || 15, 1), 50) }) };
  }

  if (name === 'window_predict') {
    const spans = loadSpans(db, now - 30 * DAY, now);
    const model = buildModel(spans, { now });
    const activeId = getKv(db, 'active');
    const activeRow = activeId ? db.prepare('SELECT app FROM windows WHERE id = ?').get(activeId) : null;
    const current = args.app || (activeRow && activeRow.app) || null;
    if (!current) return { error: 'no active window known; pass app explicitly' };
    const { predictions, evidence } = predictNext(model, current, { when: now, k: Math.min(Math.max(args.k || 3, 1), 10) });
    const open = listOpenWindows(db);
    return {
      current,
      transitionsObserved: model.transitions,
      evidence,
      predictions: predictions.map((p) => {
        const w = open.find((o) => o.app === p.app);
        return { ...p, openWindowId: w ? w.id : null };
      }),
    };
  }

  if (name === 'window_pairs') {
    const spans = loadSpans(db, now - 60 * DAY, now);
    const stats = Pairs.buildPairStats(spans, { now });
    const k = Math.min(Math.max(args.k || 8, 1), 30);
    if (args.app) {
      const app = String(args.app);
      return {
        app,
        spans: stats.spans,
        companions: Pairs.companions(stats, app, { k, minShare: 0, minCount: 1 }).map((c) => ({ ...c, share: Math.round(c.share * 1000) / 1000 })),
      };
    }
    return {
      spans: stats.spans,
      apps: stats.apps.size,
      pairs: Pairs.report(stats, { minShare: 0.1, minCount: 2 }).slice(0, k),
      hint: 'share is mutual attention between the two apps; high share means they belong on screen together',
    };
  }

  if (name === 'window_proactive') {
    const P = require('./windows-proactive');
    if (args.mode) {
      if (!P.MODES.includes(args.mode)) return { error: `mode must be one of ${P.MODES.join(', ')}` };
      setKv(db, 'proactiveMode', args.mode);
    }
    if (args.unmute) P.unmuteAll(db);
    const stored = getKv(db, 'proactiveMode');
    return {
      mode: P.MODES.includes(stored) ? stored : P.defaultOptions().mode,
      daemon: await daemonRunning(),
      last7d: P.stats(db, now - 7 * DAY),
      muted: P.muted(db),
    };
  }

  return { error: `unknown window tool: ${name}` };
}

function classifyWindowsTool(name) {
  if (name === 'window_layout') return process.env.SHMAKK_WINDOWS_STRICT === '1' ? 'uncertain' : 'safe';
  return 'safe';
}

function describeWindowsTool(name, args = {}) {
  if (name === 'window_screens') return Array.isArray(args.order) && args.order.length ? `screen priority: ${args.order.join(' > ')}` : 'screen priority';
  if (name === 'window_pairs') return args.app ? `apps used with ${args.app}` : 'which apps are used together';
  if (name === 'window_layout') {
    const n = Array.isArray(args.placements) ? args.placements.length : 0;
    return `window layout: ${n} window${n === 1 ? '' : 's'}${args.minimizeOthers ? ', minimize others' : ''}`;
  }
  if (name === 'window_usage') return `window usage (${args.range || '7d'})`;
  if (name === 'window_reorder') return args.action === 'swap-screens' ? 'swap screen layouts' : 'reorder windows';
  if (name === 'window_predict') return `predict next window${args.app ? ` after ${args.app}` : ''}`;
  if (name === 'window_proactive') return args.mode || args.unmute ? `window suggestions: ${[args.mode, args.unmute ? 'unmute' : ''].filter(Boolean).join(', ')}` : 'window suggestion status';
  return 'list open windows';
}

const TOOL_DEFS = [
  { type: 'function', function: {
    name: 'window_list',
    description: 'List open desktop windows (KDE Plasma) with id, app class, screen, virtual desktop, geometry in pixels and minimized state, plus which one is active. Titles are included only if the user enabled them.',
    parameters: { type: 'object', properties: {} },
  }},
  { type: 'function', function: {
    name: 'window_usage',
    description: 'How much focused time the user spent per app over a time range, largest first.',
    parameters: {
      type: 'object',
      properties: {
        range: { type: 'string', enum: ['1h', 'today', '24h', '7d', '30d', '90d'], description: 'Time range. Default 7d.' },
        limit: { type: 'number', description: 'Max apps to return. Default 15.' },
      },
    },
  }},
  { type: 'function', function: {
    name: 'window_predict',
    description: 'Predict which apps the user is most likely to switch to next, from their focus history (time of day aware). Returns probabilities and, when the app is open, its window id.',
    parameters: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'App class to predict from. Default: the active window.' },
        k: { type: 'number', description: 'Number of predictions. Default 3.' },
      },
    },
  }},
  { type: 'function', function: {
    name: 'window_layout',
    description: 'Arrange desktop windows. Each placement targets a window by id (from window_list) or by app class, and gives x, y, w, h as fractions (0..1) of the screen work area, or pixels with unit "px". Omit geometry to only restore a window; set focus on one placement to activate it. minimizeOthers minimizes every other window on the current desktop.',
    parameters: {
      type: 'object',
      required: ['placements'],
      properties: {
        placements: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Window id from window_list' },
              app: { type: 'string', description: 'App class; the most recently stacked window of that app is used' },
              x: { type: 'number' },
              y: { type: 'number' },
              w: { type: 'number' },
              h: { type: 'number' },
              unit: { type: 'string', enum: ['fraction', 'px'], description: 'Default fraction' },
              screen: { type: 'string', description: 'Output name to move the window to, e.g. DP-1' },
              focus: { type: 'boolean' },
            },
          },
        },
        minimizeOthers: { type: 'boolean', description: 'Minimize windows not in placements. Default false.' },
      },
    },
  }},
  { type: 'function', function: {
    name: 'window_reorder',
    description: 'Same as the keyboard shortcuts. action "reorder" (Ctrl+Alt+;) arranges the windows the user is working with into the most fitting layout; calling it again within 90 seconds switches to the next layout. action "swap-screens" (Ctrl+Alt+\') swaps the window layouts of the active screen and the next one.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['reorder', 'swap-screens'], description: 'Default reorder' },
      },
    },
  }},
  { type: 'function', function: {
    name: 'window_proactive',
    description: 'Status and control of proactive window suggestions made by the windows daemon. mode: off (never), suggest (notification with Side by side / Switch buttons), auto (arrange confident predictions immediately, with Undo). Without arguments returns the current mode, last 7 days of outcomes and muted app pairs. unmute clears pairs muted after repeated dismissals.',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['off', 'suggest', 'auto'] },
        unmute: { type: 'boolean', description: 'Clear all muted pairs' },
      },
    },
  }},
  { type: 'function', function: {
    name: 'window_screens',
    description: 'Screen configuration and priority for window arranging. Returns connected outputs in priority order with resolution, scale, orientation and position. Pass order as output names, most important first (for example ["DP-1", "HDMI-A-1"]), to set which screen is the main one, which is secondary and which are extras. The order is also mirrored into KScreen so Plasma and KWin agree, unless kscreen is false. Reorder then puts the window you are working in on the main screen.',
    parameters: {
      type: 'object',
      properties: {
        order: { type: 'array', items: { type: 'string' }, description: 'Output names, main screen first' },
        kscreen: { type: 'boolean', description: 'Also set KScreen priority (default true)' },
      },
    },
  }},
  { type: 'function', function: {
    name: 'window_pairs',
    description: 'Which apps the user uses together, learned from focus spans: mutual attention share and alternation count per app pair. With app, returns its companions only. share is what fraction of the attention both apps give to each other, so 0.3 means they belong on screen together.',
    parameters: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'App class to list companions for' },
        k: { type: 'number', description: 'Max rows. Default 8.' },
      },
    },
  }},
];

module.exports = {
  BUS_NAME,
  OBJ_PATH,
  RANGES,
  IFACE,
  TOOL_NAMES,
  TOOL_DEFS,
  isAvailable,
  defaultDbPath,
  openDb,
  getDB,
  closeDb,
  migrate,
  getKv,
  setKv,
  gdbus,
  gstr,
  recordEvent,
  closeDangling,
  prune,
  listOpenWindows,
  loadSpans,
  hourBucket,
  collapseSpans,
  buildModel,
  predictNext,
  usage,
  rangeStart,
  runKwinScript,
  requestSnapshot,
  runCommand,
  COMMANDS,
  kwinShared,
  daemonRunning,
  normalizeLayout,
  buildLayoutScript,
  applyLayout,
  dispatchWindows,
  classifyWindowsTool,
  describeWindowsTool,
  Screens,
  Pairs,
};

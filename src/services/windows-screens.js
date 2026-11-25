// Screen configuration and priority for shmakk window arranging.
//
// Priority is the order you care about the screens in: 1 is the main screen,
// 2 the secondary, the rest are extras. shmakk keeps that order in
// ~/.config/shmakk/screens.json so it survives restarts, works without the
// daemon and needs no SQLite. When KScreen is available the same order is
// mirrored into it with `kscreen-doctor output.<name>.priority.<n>`, so
// Plasma, KWin and shmakk agree on which screen is the main one.
//
// Everything that plans a layout reads this file:
//   windows-reorder  puts the window you are working in on the main screen
//   windows-proactive puts a pair it suggests side by side on the main screen
//   the Plasma widget (desktop/plasma/org.shmakk.screenpriority) edits it

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

function configPath() {
  if (process.env.SHMAKK_SCREENS_FILE) return process.env.SHMAKK_SCREENS_FILE;
  return path.join(os.homedir(), '.config', 'shmakk', 'screens.json');
}

function defaultConfig() {
  return { order: [], kscreen: true, updatedAt: null };
}

/** Read the stored order. A missing or broken file reads as "no priority". */
function readConfig(file = configPath()) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return defaultConfig();
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaultConfig();
  }
  if (!parsed || typeof parsed !== 'object') return defaultConfig();
  const order = Array.isArray(parsed.order) ? parsed.order.map(String).filter(Boolean) : [];
  return {
    order: dedupe(order),
    kscreen: parsed.kscreen !== false,
    updatedAt: Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : null,
  };
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/** Merge `patch` into the stored config; writes atomically (tmp + rename). */
function writeConfig(patch = {}, file = configPath()) {
  const next = { ...readConfig(file), ...patch, updatedAt: Date.now() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return next;
}

// ── kscreen ─────────────────────────────────────────────────────────────────

/** Rotation numbers follow XRandR: 1 none, 2 left, 4 inverted, 8 right. */
function orientationOf(rotation) {
  return rotation === 2 || rotation === 8 ? 'portrait' : 'landscape';
}

/**
 * Normalize `kscreen-doctor -j` into plain screen records.
 * Accepts the parsed object or the raw JSON string. Returns [] on junk.
 */
function parseKscreen(raw) {
  let doc = raw;
  if (typeof raw === 'string') {
    try {
      doc = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  const outputs = doc && Array.isArray(doc.outputs) ? doc.outputs : [];
  const out = [];
  for (const o of outputs) {
    if (!o || !o.name) continue;
    const connected = o.connected !== false;
    const enabled = connected && o.enabled !== false;
    const pos = o.pos && Number.isFinite(o.pos.x) ? o.pos : { x: 0, y: 0 };
    const size = o.size && Number.isFinite(o.size.width) ? o.size : { width: 0, height: 0 };
    out.push({
      name: String(o.name),
      connected,
      enabled,
      priority: Number.isFinite(o.priority) ? o.priority : null,
      x: pos.x,
      y: pos.y,
      width: size.width,
      height: size.height,
      scale: Number.isFinite(o.scale) && o.scale > 0 ? o.scale : 1,
      rotation: Number.isFinite(o.rotation) ? o.rotation : 1,
      orientation: orientationOf(o.rotation),
      mode: String(o.currentModeId || ''),
    });
  }
  return out;
}

function kscreenDoctor(args, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    execFile('kscreen-doctor', args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message || '').trim();
        reject(new Error(err.code === 'ENOENT' ? 'kscreen-doctor not found (install kscreen)' : msg));
        return;
      }
      resolve(String(stdout || ''));
    });
  });
}

/** Ask KScreen for the current outputs. Throws when it cannot answer. */
async function queryScreens() {
  const out = await kscreenDoctor(['-j']);
  const screens = parseKscreen(out);
  if (!screens.length) throw new Error('kscreen-doctor returned no outputs');
  return screens;
}

async function queryScreensSafe() {
  try {
    return { ok: true, screens: await queryScreens() };
  } catch (e) {
    return { ok: false, screens: [], error: e.message };
  }
}

/** Ask KScreen to make `order` the priority order (1, 2, 3 ...). */
function applyKscreen(order, screens, runner = kscreenDoctor) {
  const known = new Set((screens || []).filter((s) => s.enabled).map((s) => s.name));
  const names = order.filter((n) => known.has(n));
  if (!names.length) return Promise.resolve({ ok: false, error: 'no enabled screens to prioritize' });
  const args = names.map((name, i) => `output.${name}.priority.${i + 1}`);
  return runner(args).then(
    () => ({ ok: true, applied: names }),
    (e) => ({ ok: false, error: e.message, applied: [] }),
  );
}

// ── ordering ────────────────────────────────────────────────────────────────

/** Enabled screens by KScreen priority (nulls last), then by name. */
function byKscreen(screens) {
  return screens.slice().sort((a, b) => {
    const pa = a.priority == null ? Number.MAX_SAFE_INTEGER : a.priority;
    const pb = b.priority == null ? Number.MAX_SAFE_INTEGER : b.priority;
    return pa - pb || String(a.name).localeCompare(String(b.name));
  });
}

/**
 * Screens in priority order: the stored order first, then whatever is left
 * (by KScreen priority). Disabled outputs are dropped when `enabledOnly`.
 */
function orderScreens(screens, order = [], { enabledOnly = true } = {}) {
  const list = (screens || []).filter((s) => s && s.name && (!enabledOnly || s.enabled));
  const rank = new Map();
  dedupe((order || []).map(String)).forEach((name, i) => rank.set(name, i));
  return list.slice().sort((a, b) => {
    const ra = rank.has(a.name) ? rank.get(a.name) : Number.MAX_SAFE_INTEGER;
    const rb = rank.has(b.name) ? rank.get(b.name) : Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    const pa = a.priority == null ? Number.MAX_SAFE_INTEGER : a.priority;
    const pb = b.priority == null ? Number.MAX_SAFE_INTEGER : b.priority;
    return pa - pb || String(a.name).localeCompare(String(b.name));
  });
}

const RANK_LABELS = ['Main', 'Secondary', 'Third', 'Fourth', 'Fifth', 'Sixth'];

function rankLabel(index) {
  return RANK_LABELS[index] || `Extra ${index - RANK_LABELS.length + 1}`;
}

function nameByRank(screens, order = []) {
  return orderScreens(screens, order).map((s) => s.name);
}

/** The screen that should hold the window you are working in, or null. */
function mainScreen(order = [], screens = []) {
  if (!order.length) return null;
  const ordered = orderScreens(screens, order);
  return ordered.length ? ordered[0].name : order[0];
}

// ── reporting ───────────────────────────────────────────────────────────────

function splitLabel(s) {
  const logicalW = s.width && s.scale ? Math.round(s.width / s.scale) : s.width;
  const logicalH = s.height && s.scale ? Math.round(s.height / s.scale) : s.height;
  const size = logicalW && logicalH ? `${logicalW}x${logicalH}` : 'unknown size';
  const scale = s.scale && s.scale !== 1 ? ` @${s.scale}` : '';
  return `${size}${scale} ${s.orientation}`;
}

/** One line per screen, in priority order, for the CLI. */
function describe(screens, order = []) {
  const ordered = orderScreens(screens, order);
  const width = Math.max(4, ...ordered.map((s) => s.name.length));
  return ordered.map((s, i) => {
    const badge = String(i + 1).padStart(2, ' ');
    const name = s.name.padEnd(width, ' ');
    const at = `at ${s.x},${s.y}`;
    return `${badge}  ${name}  ${splitLabel(s)}  ${rankLabel(i)}  ${at}`;
  });
}

/** JSON shape the Plasma widget and the tools consume. */
function snapshot(screens, order = [], extra = {}) {
  const ordered = orderScreens(screens, order);
  return {
    ...extra,
    order: ordered.map((s) => s.name),
    stored: (order || []).slice(),
    screens: ordered.map((s, i) => ({
      name: s.name,
      rank: i + 1,
      label: rankLabel(i),
      width: s.width,
      height: s.height,
      scale: s.scale,
      rotation: s.rotation,
      orientation: s.orientation,
      position: { x: s.x, y: s.y },
      kscreenPriority: s.priority,
      primary: i === 0,
    })),
  };
}

// ── mutation ────────────────────────────────────────────────────────────────

/**
 * Store `names` as the priority order and, unless `kscreen` is false, mirror
 * it into KScreen. Unknown names are dropped; known screens left out are
 * appended so the order stays complete.
 */
async function setPriorities(names, opts = {}) {
  const wanted = dedupe((names || []).map(String).filter(Boolean));
  if (!wanted.length) return { error: 'give at least one screen name' };
  const queried = opts.screens ? { ok: true, screens: opts.screens } : await queryScreensSafe();
  const screens = queried.screens || [];
  const known = new Set(screens.filter((s) => s.enabled).map((s) => s.name));
  const unknown = wanted.filter((n) => known.size && !known.has(n));
  if (known.size && unknown.length === wanted.length) {
    return { error: `no such screen: ${unknown.join(', ')} (connected: ${[...known].join(', ')})` };
  }
  const order = orderScreens(screens, wanted).map((s) => s.name);
  const resolved = order.length ? order : wanted;
  const useKscreen = opts.kscreen !== false;
  const stored = writeConfig({ order: resolved, kscreen: useKscreen }, opts.file);

  const result = { ok: true, order: resolved, stored: true, kscreen: null };
  if (!useKscreen) return result;
  if (!queried.ok) {
    result.kscreen = { ok: false, error: queried.error };
    return result;
  }
  const applied = await applyKscreen(resolved, screens, opts.runner);
  result.kscreen = applied;
  return result;
}

module.exports = {
  configPath,
  defaultConfig,
  readConfig,
  writeConfig,
  parseKscreen,
  queryScreens,
  queryScreensSafe,
  applyKscreen,
  orderScreens,
  rankLabel,
  nameByRank,
  mainScreen,
  describe,
  snapshot,
  setPriorities,
  byKscreen,
  orientationOf,
};

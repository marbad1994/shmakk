// Proactive window suggestions, run by `shmakk windows-daemon`.
//
// After you have stayed in a window for a while (dwell), the engine asks the
// predictor which app comes next. When the prediction is confident and that
// app has an open window that is not already visible next to yours, it acts:
//
//   suggest  a desktop notification with "Side by side" and "Switch" buttons
//   auto     arranges both windows side by side at once, with an Undo button
//            (only above the higher auto threshold; below it, it suggests)
//   off      nothing
//
// It backs off on its own: a global cooldown, a per-pair cooldown, and a
// mute for any pair whose last three suggestions you dismissed. It stays
// quiet while the current window is fullscreen or Do Not Disturb is on.
// Every suggestion and its outcome is logged in proactive_log.
//
// The mode can be changed at runtime by the window_proactive agent tool,
// which writes kv 'proactiveMode'; the engine reads it on every check.

const { execFile } = require('child_process');

const MODES = ['off', 'suggest', 'auto'];

function envNum(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

function defaultOptions(over = {}) {
  const mode = MODES.includes(process.env.SHMAKK_WINDOWS_PROACTIVE) ? process.env.SHMAKK_WINDOWS_PROACTIVE : 'suggest';
  return {
    mode,
    dwellMs: envNum('SHMAKK_WINDOWS_DWELL_SEC', 30) * 1000,
    minP: envNum('SHMAKK_WINDOWS_MIN_P', 0.6),
    autoP: envNum('SHMAKK_WINDOWS_AUTO_P', 0.8),
    minEvidence: envNum('SHMAKK_WINDOWS_MIN_EVIDENCE', 5),
    globalCooldownMs: envNum('SHMAKK_WINDOWS_COOLDOWN_SEC', 120) * 1000,
    pairCooldownMs: 15 * 60 * 1000,
    muteAfter: 3,
    split: envNum('SHMAKK_WINDOWS_SPLIT', 0.6),
    notifyMs: 10000,
    modelTtlMs: 10 * 60 * 1000,
    ...over,
  };
}

// ── pure helpers ────────────────────────────────────────────────────────────

/** "org.kde.konsole" -> "Konsole", "firefox" -> "Firefox". */
function prettyApp(app) {
  const s = String(app || '').split('.').filter(Boolean).pop() || String(app || '');
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'window';
}

/** Share of rectangle b covered by rectangle a (0..1). Rects are {x,y,w,h}. */
function overlapRatio(a, b) {
  if (!a || !b || !(b.w > 0 && b.h > 0)) return 0;
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return (ix * iy) / (b.w * b.h);
}

function rect(row) {
  return row && Number.isFinite(row.x) ? { x: row.x, y: row.y, w: row.w, h: row.h } : null;
}

/** The target already shows next to the current window: same screen, not minimized, mostly uncovered. */
function alreadyVisible(current, target) {
  if (!current || !target || target.minimized) return false;
  if (current.screen && target.screen && current.screen !== target.screen) return true;
  const a = rect(current);
  const b = rect(target);
  if (!a || !b) return false;
  return overlapRatio(a, b) < 0.3;
}

/**
 * Decide what to do with one prediction. Pure; all state is passed in.
 *   top        { app, p } or null
 *   state      { lastAt, pairLastAt, mutedPair }
 * Returns { action: 'none' | 'suggest' | 'auto', reason }.
 */
function decide({ mode, top, evidence, now, state, opts }) {
  if (mode === 'off') return { action: 'none', reason: 'off' };
  if (!top) return { action: 'none', reason: 'no prediction' };
  if (evidence < opts.minEvidence) return { action: 'none', reason: 'low evidence' };
  if (top.p < opts.minP) return { action: 'none', reason: 'low confidence' };
  if (state.lastAt && now - state.lastAt < opts.globalCooldownMs) return { action: 'none', reason: 'cooldown' };
  if (state.pairLastAt && now - state.pairLastAt < opts.pairCooldownMs) return { action: 'none', reason: 'pair cooldown' };
  if (state.mutedPair) return { action: 'none', reason: 'muted' };
  if (mode === 'auto' && top.p >= opts.autoP) return { action: 'auto', reason: 'confident' };
  return { action: 'suggest', reason: 'confident' };
}

/** Current window on the left taking `split`, target on the right. */
function splitLayout(currentId, targetId, split, focusTarget = false) {
  const s = Math.min(Math.max(split, 0.3), 0.7);
  return {
    placements: [
      { id: currentId, x: 0, y: 0, w: s, h: 1, focus: !focusTarget },
      { id: targetId, x: s, y: 0, w: 1 - s, h: 1, focus: focusTarget },
    ],
  };
}

/** Layout that puts windows back where the store last saw them. */
function restoreLayout(rows) {
  const placements = rows
    .filter((r) => r && Number.isFinite(r.x) && r.w > 0 && r.h > 0)
    .map((r) => ({ id: r.id, unit: 'px', x: r.x, y: r.y, w: r.w, h: r.h }));
  return placements.length ? { placements } : null;
}

// ── side effects ────────────────────────────────────────────────────────────

/**
 * notify-send with action buttons. Resolves { action } with the clicked
 * action key, or null when dismissed or timed out.
 */
function notifySend({ summary, body, actions = [], timeoutMs = 10000, icon = 'view-split-left-right', transient = false }) {
  return new Promise((resolve) => {
    const args = ['-a', 'shmakk', '-i', icon, '-t', String(timeoutMs)];
    if (transient) args.push('-h', 'boolean:transient:true');
    for (const [key, label] of actions) args.push('-A', `${key}=${label}`);
    if (actions.length) args.push('--wait');
    args.push('--', summary, body);
    execFile('notify-send', args, { timeout: timeoutMs + 5000 }, (err, stdout) => {
      if (err && err.code === 'ENOENT') { resolve({ action: null, error: 'notify-send not found (install libnotify)' }); return; }
      const out = String(stdout || '').trim().split('\n').pop() || '';
      resolve({ action: out || null });
    });
  });
}

async function notificationsInhibited(W) {
  try {
    const out = await W.gdbus(['--dest', 'org.freedesktop.Notifications', '--object-path', '/org/freedesktop/Notifications',
      '--method', 'org.freedesktop.DBus.Properties.Get', W.gstr('org.freedesktop.Notifications'), W.gstr('Inhibited')], 2000);
    return /true/.test(out);
  } catch {
    return false;
  }
}

// ── log ─────────────────────────────────────────────────────────────────────

function logSuggestion(db, row) {
  const r = db.prepare('INSERT INTO proactive_log (t, fromApp, toApp, p, mode, outcome) VALUES (?, ?, ?, ?, ?, ?)')
    .run(row.t, row.fromApp, row.toApp, row.p, row.mode, row.outcome || 'pending');
  return Number(r.lastInsertRowid);
}

function setOutcome(db, id, outcome) {
  db.prepare('UPDATE proactive_log SET outcome = ? WHERE id = ?').run(outcome, id);
}

function pairState(db, fromApp, toApp, muteAfter) {
  const last = db.prepare('SELECT outcome, t FROM proactive_log WHERE fromApp = ? AND toApp = ? ORDER BY t DESC, id DESC LIMIT ?')
    .all(fromApp, toApp, muteAfter);
  const mutedPair = last.length >= muteAfter && last.every((r) => r.outcome === 'dismissed' || r.outcome === 'undone');
  return { pairLastAt: last.length ? last[0].t : null, mutedPair };
}

function lastSuggestionAt(db) {
  const r = db.prepare('SELECT MAX(t) AS t FROM proactive_log').get();
  return r && r.t ? r.t : null;
}

function stats(db, since) {
  const rows = db.prepare('SELECT outcome, COUNT(*) AS n FROM proactive_log WHERE t >= ? GROUP BY outcome').all(since);
  const out = {};
  for (const r of rows) out[r.outcome] = r.n;
  return out;
}

function muted(db, muteAfter = 3) {
  const pairs = db.prepare('SELECT DISTINCT fromApp, toApp FROM proactive_log').all();
  return pairs.filter((p) => pairState(db, p.fromApp, p.toApp, muteAfter).mutedPair).map((p) => `${p.fromApp} -> ${p.toApp}`);
}

function unmuteAll(db) {
  db.prepare("UPDATE proactive_log SET outcome = 'unmuted' WHERE outcome IN ('dismissed', 'undone')").run();
}

// ── engine ──────────────────────────────────────────────────────────────────

/**
 * Create the engine. Dependencies are injectable for tests:
 *   W        src/services/windows.js
 *   notify   ({summary, body, actions, timeoutMs}) => Promise<{action}>
 *   inhibited () => Promise<boolean>
 */
function createProactive({ db, W, opts: over, notify = notifySend, inhibited, log = () => {}, now = () => Date.now() }) {
  const opts = defaultOptions(over);
  const isInhibited = inhibited || (() => notificationsInhibited(W));
  let timer = null;
  let model = null;
  let modelAt = 0;
  let busy = false;

  function mode() {
    const m = W.getKv(db, 'proactiveMode');
    return MODES.includes(m) ? m : opts.mode;
  }

  function getModel(t) {
    if (!model || t - modelAt > opts.modelTtlMs) {
      model = W.buildModel(W.loadSpans(db, t - 30 * 24 * 60 * 60 * 1000, t), { now: t });
      modelAt = t;
    }
    return model;
  }

  function onEvent(ev) {
    if (!ev || (ev.kind !== 'focus' && ev.kind !== 'snapshot')) return;
    if (timer) { clearTimeout(timer); timer = null; }
    const w = ev.kind === 'focus' ? ev.window : (ev.windows || []).find((x) => x && x.id === ev.active);
    if (!w || !w.id || w.fullScreen) return;
    timer = setTimeout(() => {
      timer = null;
      check(w).catch((e) => log(`proactive: ${e.message}`));
    }, opts.dwellMs);
    if (timer.unref) timer.unref();
  }

  /** Run one check for the focused window `w` (as sent by the watcher). */
  async function check(w) {
    if (busy) return { action: 'none', reason: 'busy' };
    const t = now();
    const m = mode();
    if (m === 'off') return { action: 'none', reason: 'off' };
    if (W.getKv(db, 'active') !== String(w.id)) return { action: 'none', reason: 'focus moved' };
    if (w.fullScreen) return { action: 'none', reason: 'fullscreen' };

    const { predictions, evidence } = W.predictNext(getModel(t), w.app, { when: t, k: 1 });
    const top = predictions[0] || null;
    if (!top) return { action: 'none', reason: 'no prediction' };

    const open = W.listOpenWindows(db);
    const current = open.find((o) => o.id === String(w.id));
    const target = open.find((o) => o.app === top.app && o.id !== String(w.id));
    if (!current || !target) return { action: 'none', reason: 'target not open' };
    if (alreadyVisible(current, target)) return { action: 'none', reason: 'already visible' };

    const state = { lastAt: lastSuggestionAt(db), ...pairState(db, w.app, top.app, opts.muteAfter) };
    const d = decide({ mode: m, top, evidence, now: t, state, opts });
    if (d.action === 'none') return d;
    if (await isInhibited()) return { action: 'none', reason: 'do not disturb' };

    busy = true;
    try {
      const pct = Math.round(top.p * 100);
      const from = prettyApp(w.app);
      const to = prettyApp(top.app);
      const id = logSuggestion(db, { t, fromApp: w.app, toApp: top.app, p: top.p, mode: d.action });

      if (d.action === 'auto') {
        const before = restoreLayout([current, target]);
        await W.applyLayout(splitLayout(current.id, target.id, opts.split));
        setOutcome(db, id, 'auto');
        log(`auto: ${w.app} + ${top.app} (${pct}%)`);
        const r = await notify({
          summary: `Arranged ${from} and ${to}`,
          body: `You usually open ${to} after ${from} (${pct}%).`,
          actions: [['undo', 'Undo']],
          timeoutMs: opts.notifyMs,
        });
        if (r.action === 'undo' && before) {
          await W.applyLayout(before);
          setOutcome(db, id, 'undone');
          return { action: 'auto', outcome: 'undone' };
        }
        return { action: 'auto', outcome: 'auto' };
      }

      const r = await notify({
        summary: `Next: ${to}?`,
        body: `You usually switch from ${from} to ${to} (${pct}%).`,
        actions: [['split', 'Side by side'], ['focus', 'Switch']],
        timeoutMs: opts.notifyMs,
      });
      if (r.action === 'split') {
        await W.applyLayout(splitLayout(current.id, target.id, opts.split, true));
        setOutcome(db, id, 'split');
      } else if (r.action === 'focus') {
        await W.applyLayout({ placements: [{ id: target.id, focus: true }] });
        setOutcome(db, id, 'focus');
      } else {
        setOutcome(db, id, 'dismissed');
      }
      log(`suggest: ${w.app} -> ${top.app} (${pct}%): ${r.action || 'dismissed'}`);
      return { action: 'suggest', outcome: r.action || 'dismissed' };
    } finally {
      busy = false;
    }
  }

  function stop() {
    if (timer) { clearTimeout(timer); timer = null; }
  }

  return { onEvent, check, stop, opts, mode };
}

module.exports = {
  MODES,
  defaultOptions,
  prettyApp,
  overlapRatio,
  alreadyVisible,
  decide,
  splitLayout,
  restoreLayout,
  notifySend,
  createProactive,
  stats,
  muted,
  unmuteAll,
};

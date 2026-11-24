// Reorder on demand (Ctrl+Alt+;), run by `shmakk windows-daemon`.
//
// The KWin watcher sends a fresh context (windows on the current desktop,
// screens with their work areas, the active window). This module:
//
//   1. ranks the windows by what you are working with now: the active
//      window first, then recent focus time (last hour, 15 minute half-life)
//      plus a bonus for the app the predictor expects next and for apps you
//      use together with the active one;
//   2. decides how many windows matter (1 to 4);
//   3. moves the active window's strongest companion up to second place, so
//      a pair you use together lands in the same two-window layout;
//   4. builds candidate layouts (portrait screens stack vertically) on the
//      screens in your priority order (screen 1 is main), and orders them by
//      fit and by what you kept before;
//   5. applies the best one that differs from the current arrangement.
//
// Pressing again within CYCLE_MS moves to the next candidate and counts the
// previous one as rejected. A layout you leave in place for CYCLE_MS counts
// as kept. Those scores live in reorder_prefs, per app set and per window
// count, so the first pick improves over time.

const Pairs = require('./windows-pairs');

const CYCLE_MS = 90 * 1000;
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

// Rects are [x, y, w, h] in fractions of a screen's work area.
const SINGLE = {
  focus: { label: 'Focus', rects: [[0, 0, 1, 1]] },
  split: { label: 'Main and side', rects: [[0, 0, 0.6, 1], [0.6, 0, 0.4, 1]] },
  halves: { label: 'Halves', rects: [[0, 0, 0.5, 1], [0.5, 0, 0.5, 1]] },
  'main-stack': { label: 'Main and stack', rects: [[0, 0, 0.6, 1], [0.6, 0, 0.4, 0.5], [0.6, 0.5, 0.4, 0.5]] },
  columns: { label: 'Three columns', rects: [[0, 0, 1 / 3, 1], [1 / 3, 0, 1 / 3, 1], [2 / 3, 0, 1 / 3, 1]] },
  grid: { label: 'Grid', rects: [[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]] },
};

// Two screens: each slot is [screenIndex, rect]; slot i holds ranked window i.
// Screen 0 is the active window's screen, screen 1 the next one.
const FULL = [0, 0, 1, 1];
const DUAL = {
  span: { label: 'One per screen', slots: [[0, FULL], [1, FULL]] },
  'span-split': { label: 'Split here, one there', slots: [[0, [0, 0, 0.6, 1]], [1, FULL], [0, [0.6, 0, 0.4, 1]]] },
  'span-stack': { label: 'One here, split there', slots: [[0, FULL], [1, [0, 0, 0.5, 1]], [1, [0.5, 0, 0.5, 1]]] },
  'span-quad': { label: 'Split on both', slots: [[0, [0, 0, 0.5, 1]], [1, [0, 0, 0.5, 1]], [0, [0.5, 0, 0.5, 1]], [1, [0.5, 0, 0.5, 1]]] },
};

// ── pure helpers ────────────────────────────────────────────────────────────

/** Portrait screens get the transposed layout: columns become rows. */
function orient(rect, screen) {
  if (!screen || !(screen.h > screen.w)) return rect;
  const [x, y, w, h] = rect;
  return [y, x, h, w];
}

/**
 * Rank context windows. Returns [{ win, score }] with the active window
 * first (score Infinity), then by score. Minimized windows can be ranked;
 * applying a layout restores them.
 *
 * `pairs` is optional pair statistics from windows-pairs.js; windows of apps
 * you use together with the active one get a bonus, so a companion beats a
 * window that merely had more focus time an hour ago.
 */
function rankWindows(ctx, spans, predictions, now, pairs) {
  const focus = new Map();
  for (const s of spans || []) {
    const end = Math.min(Number.isFinite(s.end) ? s.end : now, now);
    const dur = Math.max(0, end - s.start);
    const w = (dur / MIN) * Math.pow(0.5, Math.max(0, now - end) / (15 * MIN));
    focus.set(s.windowId, (focus.get(s.windowId) || 0) + w);
  }
  const wins = (ctx.windows || []).filter((w) => w && w.id && !w.fullScreen);
  const base = new Map(wins.map((w) => [w.id, focus.get(w.id) || 0]));
  const maxBase = Math.max(1, ...base.values());

  // Prediction bonus goes to the most-used window of each predicted app.
  const bonus = new Map();
  for (const p of predictions || []) {
    const cands = wins.filter((w) => w.app === p.app && w.id !== ctx.active);
    if (!cands.length) continue;
    cands.sort((a, b) => base.get(b.id) - base.get(a.id));
    bonus.set(cands[0].id, p.p * maxBase);
  }

  // Companion bonus: apps you alternate with the active one.
  const activeWin = wins.find((w) => w.id === ctx.active);
  if (pairs && activeWin) {
    for (const c of Pairs.companions(pairs, activeWin.app, { k: 3 })) {
      const cands = wins.filter((w) => w.app === c.app && w.id !== ctx.active);
      if (!cands.length) continue;
      cands.sort((a, b) => base.get(b.id) - base.get(a.id));
      const id = cands[0].id;
      bonus.set(id, (bonus.get(id) || 0) + c.share * maxBase);
    }
  }

  return wins
    .map((win) => ({ win, score: win.id === ctx.active ? Infinity : base.get(win.id) + (bonus.get(win.id) || 0) }))
    .sort((a, b) => b.score - a.score || (a.win.id < b.win.id ? -1 : 1));
}

/** How many windows the layout should hold (1..4). */
function relevantCount(ranked) {
  if (!ranked.length) return 0;
  const rest = ranked.filter((r) => r.score !== Infinity && r.score > 0);
  if (!rest.length) return Math.min(2, ranked.length);
  const top = rest[0].score;
  const strong = rest.filter((r) => r.score >= 0.25 * top).length;
  return Math.min(1 + Math.min(strong, 3), ranked.length, 4);
}

/**
 * The screens to lay out on, main first.
 *
 * With a stored priority order the order wins: the window you are working in
 * goes to the main screen even if you are on another one right now. Without
 * one, the active window's screen stays first and the next screen is the
 * fallback, as before.
 */
function pickScreens(ctx, ranked, order) {
  const screens = (ctx.screens || []).filter((s) => s && s.name);
  if (!screens.length) return [];
  const stored = (Array.isArray(order) ? order : []).map(String)
    .filter((n) => screens.some((s) => s.name === n));
  let list;
  if (stored.length) {
    list = screens.slice().sort((a, b) => {
      const ia = stored.indexOf(a.name);
      const ib = stored.indexOf(b.name);
      const ka = ia < 0 ? Infinity : ia;
      const kb = ib < 0 ? Infinity : ib;
      return ka === kb ? String(a.name).localeCompare(String(b.name)) : ka - kb;
    });
  } else {
    const first = ranked[0] && ranked[0].win.screen;
    let i = screens.findIndex((s) => s.name === first);
    if (i < 0) i = screens.findIndex((s) => s.name === ctx.activeScreen);
    if (i < 0) i = 0;
    list = [screens[i], ...screens.slice(i + 1), ...screens.slice(0, i)];
  }
  return list.slice(0, 2);
}

/**
 * Keep the active window's strongest companion in second place, so a pair you
 * use together gets the two-window layout instead of being split up by a
 * window that merely had more focus time.
 */
function partnerFirst(ranked, pairs, depth = 3) {
  if (!pairs || ranked.length < 2) return ranked;
  const head = ranked[0];
  const [top] = Pairs.companions(pairs, head.win.app, { k: 1, minShare: 0.2, minCount: 3 });
  if (!top) return ranked;
  const limit = Math.min(ranked.length, Math.max(2, depth));
  let idx = -1;
  for (let i = 1; i < limit; i++) {
    if (ranked[i].win.app === top.app) { idx = i; break; }
  }
  if (idx <= 1) return ranked;
  const out = ranked.slice();
  const [pick] = out.splice(idx, 1);
  out.splice(1, 0, pick);
  return out;
}

/**
 * Candidate layouts, best first by fit to `n` (the relevant count):
 * exact fit, then one fewer, one more, two fewer... Dual-screen layouts come
 * before single-screen ones at the same fit.
 */
function candidates(ranked, ctx, n, order) {
  const screens = pickScreens(ctx, ranked, order);
  if (!screens.length || !ranked.length) return [];
  const out = [];
  if (screens.length > 1) {
    for (const [kind, t] of Object.entries(DUAL)) {
      if (t.slots.length > ranked.length) continue;
      out.push({
        kind, label: t.label, need: t.slots.length, dual: true,
        placements: t.slots.map(([si, rect], i) => place(ranked[i].win, screens[si], orient(rect, screens[si]), i === 0)),
      });
    }
  }
  const here = screens[0];
  for (const [kind, t] of Object.entries(SINGLE)) {
    if (t.rects.length > ranked.length) continue;
    out.push({
      kind: screens.length > 1 ? `here-${kind}` : kind,
      label: screens.length > 1 ? `${t.label} on this screen` : t.label,
      need: t.rects.length, dual: false,
      placements: t.rects.map((rect, i) => place(ranked[i].win, here, orient(rect, here), i === 0)),
    });
  }
  const fit = (c) => {
    const d = c.need - n;
    return d === 0 ? 0 : d < 0 ? -2 * d - 1 : 2 * d;
  };
  return out
    .map((c, i) => ({ c, i }))
    .sort((a, b) => fit(a.c) - fit(b.c) || Number(b.c.dual) - Number(a.c.dual) || a.i - b.i)
    .map(({ c }) => c);
}

function place(win, screen, rect, focus) {
  const [x, y, w, h] = rect.map((v) => Math.round(v * 10000) / 10000);
  return { id: win.id, screen: screen.name, x, y, w: Math.min(w, 1 - x), h: Math.min(h, 1 - y), focus };
}

/** True when every placement already matches its window (within tolerance). */
function matchesCurrent(placements, ctx, tol = 12) {
  const byId = new Map((ctx.windows || []).map((w) => [w.id, w]));
  const byName = new Map((ctx.screens || []).map((s) => [s.name, s]));
  return placements.every((p) => {
    const w = byId.get(p.id);
    const s = byName.get(p.screen);
    if (!w || !s || !w.geo || w.minimized || w.screen !== p.screen) return false;
    const want = { x: s.x + p.x * s.w, y: s.y + p.y * s.h, w: p.w * s.w, h: p.h * s.h };
    return Math.abs(w.geo.x - want.x) <= tol && Math.abs(w.geo.y - want.y) <= tol &&
      Math.abs(w.geo.w - want.w) <= tol && Math.abs(w.geo.h - want.h) <= tol;
  });
}

function keysFor(ranked, n, screenCount) {
  const apps = ranked.slice(0, n).map((r) => r.win.app).sort().join('+');
  return { appKey: `${screenCount}s:${apps}`, genKey: `${screenCount}s:n${n}` };
}

/** Reorder candidates by learned preference; base order still counts. */
function applyPrefs(cands, prefs) {
  return cands
    .map((c, i) => ({ c, v: 2 * (prefs.app.get(c.kind) || 0) + (prefs.gen.get(c.kind) || 0) - 0.75 * i }))
    .sort((a, b) => b.v - a.v)
    .map(({ c }) => c);
}

// ── prefs store ─────────────────────────────────────────────────────────────

function loadPrefs(db, key) {
  const rows = db.prepare('SELECT kind, score FROM reorder_prefs WHERE key = ?').all(key);
  return new Map(rows.map((r) => [r.kind, r.score]));
}

function bumpPref(db, key, kind, delta) {
  db.prepare(`
    INSERT INTO reorder_prefs (key, kind, score) VALUES (?, ?, ?)
    ON CONFLICT(key, kind) DO UPDATE SET score = MAX(-5, MIN(5, score + excluded.score))
  `).run(key, kind, Math.max(-5, Math.min(5, delta)));
}

// ── engine ──────────────────────────────────────────────────────────────────

function createReorder({ db, W, notify, now = () => Date.now(), log = () => {}, cycleMs = CYCLE_MS, screens = null }) {
  let last = null; // { t, kind, appKey, genKey, tried: [kinds] }
  let keepTimer = null;
  let pairStats = null;
  let pairAt = 0;

  function settle(delta) {
    if (!last) return;
    bumpPref(db, last.appKey, last.kind, delta);
    bumpPref(db, last.genKey, last.kind, delta / 2);
  }

  function armKeep() {
    if (keepTimer) clearTimeout(keepTimer);
    keepTimer = setTimeout(() => {
      keepTimer = null;
      settle(+1);
      last = null;
    }, cycleMs);
    if (keepTimer.unref) keepTimer.unref();
  }

  /** Pair statistics for the last 45 days, rebuilt at most every 30 minutes. */
  function pairsAt(t) {
    if (pairStats && t - pairAt < 30 * MIN) return pairStats;
    pairStats = Pairs.buildPairStats(W.loadSpans(db, t - 45 * DAY, t), { now: t });
    pairAt = t;
    return pairStats;
  }

  /** The stored screen priority order, main screen first. */
  function screenOrder() {
    if (!screens || typeof screens.readConfig !== 'function') return [];
    try {
      return screens.readConfig().order;
    } catch {
      return [];
    }
  }

  async function reorder(ctx) {
    const t = now();
    const spans = W.loadSpans(db, t - 60 * MIN, t);
    const pairs = pairsAt(t);
    const activeWin = (ctx.windows || []).find((w) => w.id === ctx.active);
    let predictions = [];
    if (activeWin) {
      const model = W.buildModel(W.loadSpans(db, t - 30 * 24 * 60 * MIN, t), { now: t });
      predictions = W.predictNext(model, activeWin.app, { when: t, k: 3 }).predictions;
    }
    const ranked = rankWindows(ctx, spans, predictions, t, pairs);
    if (!ranked.length) return { action: 'none', reason: 'no windows' };
    const n = relevantCount(ranked);
    const screenCount = Math.min((ctx.screens || []).length, 2) || 1;
    const { appKey, genKey } = keysFor(ranked, n, screenCount);

    const cycling = !!(last && t - last.t < cycleMs);
    if (cycling) settle(-1);
    else if (last) settle(+1);
    if (keepTimer) { clearTimeout(keepTimer); keepTimer = null; }

    const order = screenOrder();
    const grouped = partnerFirst(ranked, pairs);
    const cands = applyPrefs(candidates(grouped, ctx, n, order), { app: loadPrefs(db, appKey), gen: loadPrefs(db, genKey) });
    if (!cands.length) return { action: 'none', reason: 'no layout fits' };

    let tried = cycling ? last.tried : [];
    let pool = cands.filter((c) => !tried.includes(c.kind));
    if (!pool.length) { tried = []; pool = cands; }
    let pick = pool.find((c) => !matchesCurrent(c.placements, ctx)) || pool[0];

    await W.applyLayout({ placements: pick.placements });
    last = { t, kind: pick.kind, appKey, genKey, tried: [...tried, pick.kind] };
    armKeep();

    const idx = cands.indexOf(pick) + 1;
    log(`reorder: ${pick.kind} (${idx}/${cands.length}) for ${grouped.slice(0, pick.need).map((r) => r.win.app).join(', ')}`);
    if (notify) {
      notify({
        summary: pick.label,
        body: `Layout ${idx} of ${cands.length}. Press again for another.`,
        actions: [], timeoutMs: 1500, transient: true,
      }).catch(() => {});
    }
    return { action: 'reorder', kind: pick.kind, index: idx, of: cands.length, windows: pick.placements.map((p) => p.id) };
  }

  async function handle(ev) {
    if (!ev || ev.kind !== 'command') return null;
    if (ev.command === 'reorder') return reorder(ev);
    if (ev.command === 'swap-screens') {
      if (ev.error) {
        log(`swap-screens: ${ev.error}`);
        if (notify) notify({ summary: 'Nothing to swap', body: 'Only one screen is connected.', actions: [], timeoutMs: 1500, transient: true }).catch(() => {});
        return { action: 'none', reason: ev.error };
      }
      log(`swap-screens: ${ev.a} <-> ${ev.b}, ${ev.moved} windows`);
      return { action: 'swap', moved: ev.moved };
    }
    return null;
  }

  function stop() {
    if (keepTimer) { clearTimeout(keepTimer); keepTimer = null; }
  }

  return { handle, reorder, stop };
}

module.exports = {
  CYCLE_MS,
  SINGLE,
  DUAL,
  orient,
  rankWindows,
  relevantCount,
  pickScreens,
  partnerFirst,
  candidates,
  matchesCurrent,
  applyPrefs,
  keysFor,
  loadPrefs,
  bumpPref,
  createReorder,
};

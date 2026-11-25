// Which apps you actually use together.
//
// A focus transition A -> B only says you left A for B once; it may be a
// detour through a terminal on the way somewhere else. What matters when
// arranging windows is whether two apps are used *together*: you alternate
// between them, repeatedly, with real dwell on both sides.
//
// This module turns focus spans into a symmetric pair strength:
//
//   strength(a,b)  weighted count of a<->b alternations, recency weighted
//                  (14 day half-life), with a boost when the switch is
//                  followed by a quick switch back
//   share(a,b)     how much of a's attention that pair accounts for, mutual:
//                  min(share of a, share of b), so a 1% app never looks like
//                  a companion just because it is always open in the background
//
// The proactive engine uses it to decide which window to put next to yours,
// and the reorder engine uses it to keep pairs on the same screen.

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;

function pairKey(a, b) {
  return String(a) <= String(b) ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

function unsplit(key) {
  const i = key.indexOf('\u0000');
  return i < 0 ? [key, ''] : [key.slice(0, i), key.slice(i + 1)];
}

function decay(ageMs, halfLifeMs) {
  if (!(halfLifeMs > 0)) return 1;
  return Math.pow(0.5, Math.max(0, ageMs) / halfLifeMs);
}

/**
 * Drop focus blips and merge consecutive spans of the same app. Same rule as
 * windows.js collapseSpans, kept here so this module stays dependency free.
 */
function collapse(spans, minDwellMs = 2000) {
  const out = [];
  for (const s of spans || []) {
    if (!s || !s.app) continue;
    const start = Number(s.start);
    if (!Number.isFinite(start)) continue;
    const end = Number.isFinite(s.end) ? s.end : start;
    if (end - start < minDwellMs) continue;
    const last = out[out.length - 1];
    if (last && last.app === s.app) {
      last.end = Math.max(last.end, end);
      continue;
    }
    out.push({ app: String(s.app), start, end: Math.max(start, end) });
  }
  return out;
}

/**
 * Build pair statistics from focus spans.
 *
 *   returns {
 *     pairs   Map<'a\0b', { strength, count, lastAt }>
 *     out     Map<app, strength>          total weighted attention per app
 *     apps    Set<app>
 *     spans   number of spans used
 *     since   oldest span considered
 *   }
 */
function buildPairStats(spans, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const halfLifeMs = opts.halfLifeMs || 14 * DAY;
  const returnMs = opts.returnMs || 5 * MIN;
  const capMinutes = opts.spanCapMin || 3;
  const backBoost = opts.returnBoost || 1.5;
  const seq = collapse(spans, opts.minDwellMs || 2000);

  const pairs = new Map();
  const out = new Map();
  const apps = new Set();

  const bump = (a, b, w, t) => {
    const key = pairKey(a, b);
    const cur = pairs.get(key);
    if (cur) {
      cur.strength += w;
      cur.count += 1;
      cur.lastAt = Math.max(cur.lastAt, t);
    } else {
      pairs.set(key, { strength: w, count: 1, lastAt: t });
    }
  };

  for (let i = 1; i < seq.length; i++) {
    const a = seq[i - 1];
    const b = seq[i];
    if (a.app === b.app) continue;
    // A switch that comes straight back is a real pairing, not a detour.
    const next = seq[i + 1];
    const back = next && next.app === a.app && next.start - b.start <= returnMs ? backBoost : 1;
    const dwell = Math.min(capMinutes, Math.max(0.2, (b.end - b.start) / MIN));
    const w = decay(now - b.start, halfLifeMs) * dwell * back;
    bump(a.app, b.app, w, b.start);
    out.set(a.app, (out.get(a.app) || 0) + w);
    apps.add(a.app);
    apps.add(b.app);
  }

  return { pairs, out, apps, spans: seq.length, since: seq.length ? seq[0].start : null };
}

function strengthOf(stats, a, b) {
  const p = stats && stats.pairs && stats.pairs.get(pairKey(a, b));
  return p ? p.strength : 0;
}

/** Mutual share of attention (0..1) that a and b spend on each other. */
function shareOf(stats, a, b) {
  if (!stats || !stats.pairs || a === b) return 0;
  const p = stats.pairs.get(pairKey(a, b));
  if (!p) return 0;
  const sa = (stats.out.get(a) || 0) > 0 ? p.strength / stats.out.get(a) : 0;
  const sb = (stats.out.get(b) || 0) > 0 ? p.strength / stats.out.get(b) : 0;
  return Math.min(sa, sb);
}

/**
 * Apps used alongside `app`, strongest first.
 *
 *   minShare  mutual share floor (0.18 keeps real companions, drops the
 *             browser you keep open all day)
 *   minCount  at least this many alternations observed
 */
function companions(stats, app, opts = {}) {
  if (!stats || !stats.pairs || !app) return [];
  const k = Math.max(1, opts.k || 3);
  const minShare = opts.minShare == null ? 0.18 : opts.minShare;
  const minCount = opts.minCount == null ? 3 : opts.minCount;
  const rows = [];
  for (const [key, p] of stats.pairs) {
    const [a, b] = unsplit(key);
    if (a !== app && b !== app) continue;
    const other = a === app ? b : a;
    const share = shareOf(stats, app, other);
    if (share < minShare || p.count < minCount) continue;
    rows.push({ app: other, score: p.strength, share, count: p.count, lastAt: p.lastAt });
  }
  return rows.sort((x, y) => y.share - x.share || y.count - x.count).slice(0, k);
}

/** Plain list for the window_pairs tool and `--pairs`. */
function report(stats, opts = {}) {
  const minShare = opts.minShare == null ? 0.15 : opts.minShare;
  const minCount = opts.minCount == null ? 3 : opts.minCount;
  const rows = [];
  for (const [key, p] of stats.pairs || []) {
    const [a, b] = unsplit(key);
    const share = shareOf(stats, a, b);
    if (share < minShare || p.count < minCount) continue;
    rows.push({ a, b, share: Math.round(share * 1000) / 1000, count: p.count, strength: Math.round(p.strength * 100) / 100 });
  }
  return rows.sort((x, y) => y.share - x.share || y.strength - x.strength);
}

module.exports = {
  pairKey,
  collapse,
  decay,
  buildPairStats,
  strengthOf,
  shareOf,
  companions,
  report,
};

// Replay engine for recorded automations.
//
// Two backends, chosen by the spec's surface:
//   browser  Playwright against a live page. Targets are resolved by ARIA role
//            plus accessible name, then by visible text, then by CSS when the
//            model supplied one. This is why the recording does not need
//            selectors: they do not survive a re-render, an accessible name
//            usually does.
//   desktop  kwin tools over MCP: element_query finds the AT-SPI element by
//            name and role, pointer_click takes its ref, keyboard tools type
//            and press. Nothing is clicked at a guessed coordinate.
//
// Every step reports what happened, and a failed step stops the run: replaying
// later steps on a screen that never reached the expected state would click
// blind. A run never throws for a step failure, it returns it.

const os = require('os');
const path = require('path');
const fs = require('fs');

const { bindInputs, describeStep, toDesktopCalls } = require('./automation');

const SETTLE_MS = Math.max(0, Number(process.env.SHMAKK_REPLAY_SETTLE_MS || 300));
const STEP_TIMEOUT = Math.max(500, Number(process.env.SHMAKK_REPLAY_STEP_TIMEOUT || 8000));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── browser: target resolution ──────────────────────────────────────────────

/**
 * Ordered ways to find one control on a page, best first. Pure, so the
 * resolution order is testable without a browser.
 */
function browserStrategies(step) {
  const s = step || {};
  const name = String(s.name || s.target || '').trim();
  const out = [];
  if (s.role && name) out.push({ kind: 'role', role: s.role, name, exact: true });
  if (s.role && name) out.push({ kind: 'role', role: s.role, name, exact: false });
  if (name) out.push({ kind: 'label', text: name });
  if (name) out.push({ kind: 'placeholder', text: name });
  if (name) out.push({ kind: 'text', text: name });
  if (s.selector) out.push({ kind: 'css', selector: s.selector });
  return out;
}

function buildLocator(page, strategy) {
  switch (strategy.kind) {
    case 'role': return page.getByRole(strategy.role, { name: strategy.name, exact: strategy.exact });
    case 'label': return page.getByLabel(strategy.text, { exact: false });
    case 'placeholder': return page.getByPlaceholder(strategy.text, { exact: false });
    case 'text': return page.getByText(strategy.text, { exact: false });
    case 'css': return page.locator(strategy.selector);
    default: return null;
  }
}

/** First locator that matches something on the page, with the strategy used. */
async function resolveOnPage(page, step) {
  for (const strategy of browserStrategies(step)) {
    let locator;
    try { locator = buildLocator(page, strategy); } catch { continue; }
    if (!locator) continue;
    const count = await locator.count().catch(() => 0);
    if (count > 0) return { locator: locator.first(), via: strategy.kind, matches: count };
  }
  return null;
}

// ── browser: one step ───────────────────────────────────────────────────────

async function runBrowserStep(page, step, ctx = {}) {
  const timeout = ctx.timeout || STEP_TIMEOUT;
  const val = step.value == null ? '' : String(step.value);
  const needsTarget = ['click', 'dblclick', 'rightclick', 'hover', 'select', 'scroll', 'drag', 'type', 'press'].includes(step.action);
  const resolved = needsTarget && (step.name || step.target || step.selector) ? await resolveOnPage(page, step) : null;

  switch (step.action) {
    case 'navigate': {
      if (!step.value) throw new Error('navigate needs a URL');
      await page.goto(val, { waitUntil: 'domcontentloaded', timeout });
      return { via: 'url' };
    }
    case 'wait': {
      const ms = Number(val) || 800;
      await page.waitForTimeout(Math.min(ms, 30000));
      return { via: 'timer' };
    }
    case 'click': case 'dblclick': case 'rightclick': {
      if (!resolved) throw new Error(`no control named "${step.name || step.target || '?'}" on the page`);
      const opts = { timeout };
      if (step.action === 'rightclick') opts.button = 'right';
      if (step.action === 'dblclick') opts.clickCount = 2;
      await resolved.locator.click(opts);
      return { via: resolved.via, matches: resolved.matches };
    }
    case 'hover': {
      if (!resolved) throw new Error(`no control named "${step.name || step.target || '?'}" on the page`);
      await resolved.locator.hover({ timeout });
      return { via: resolved.via };
    }
    case 'type': {
      if (resolved) await resolved.locator.fill(val, { timeout });
      else await page.keyboard.type(val);
      return { via: resolved ? resolved.via : 'keyboard' };
    }
    case 'press': {
      const key = step.key || 'Enter';
      if (resolved) await resolved.locator.press(key, { timeout });
      else await page.keyboard.press(key);
      return { via: resolved ? resolved.via : 'keyboard' };
    }
    case 'select': {
      if (!resolved) throw new Error(`no dropdown named "${step.name || step.target || '?'}" on the page`);
      await resolved.locator.selectOption(val, { timeout });
      return { via: resolved.via };
    }
    case 'scroll': {
      if (resolved) await resolved.locator.scrollIntoViewIfNeeded({ timeout });
      else await page.mouse.wheel(0, Number(val) || 600);
      return { via: resolved ? resolved.via : 'wheel' };
    }
    case 'drag': {
      if (!resolved) throw new Error(`no control named "${step.name || step.target || '?'}" to drag`);
      const target = await resolveOnPage(page, { name: val || step.target, role: null });
      if (!target) throw new Error(`no drop target named "${val}" on the page`);
      await resolved.locator.dragTo(target.locator, { timeout });
      return { via: resolved.via };
    }
    case 'manual': return { via: 'skipped', skipped: true };
    default: throw new Error(`${step.action} is not a browser action`);
  }
}

async function defaultBrowserPage() {
  const browser = require('../browser');
  return browser.ensurePage();
}

/**
 * Replay a browser spec.
 *
 * @param {object} spec
 * @param {object} [opts] { values, page, signal, artifacts, timeout, onStep }
 * @returns {Promise<object>} { ok, surface, steps, stoppedAt, error }
 */
async function replayBrowser(spec, opts = {}) {
  const bound = bindInputs(spec, opts.values || {});
  const page = opts.page || await defaultBrowserPage();
  const run = { ok: true, surface: 'browser', url: bound.url || null, steps: [], stoppedAt: null, error: null };
  if (bound.url) {
    try { await page.goto(bound.url, { waitUntil: 'domcontentloaded', timeout: opts.timeout || STEP_TIMEOUT }); }
    catch (e) { return { ...run, ok: false, error: `could not open ${bound.url}: ${e.message}` }; }
  }
  for (const step of bound.steps) {
    if (opts.signal && opts.signal.aborted) { run.ok = false; run.stoppedAt = step.index; run.error = 'cancelled'; break; }
    const started = Date.now();
    const entry = { index: step.index, action: step.action, note: describeStep(step), ok: true, error: null, via: null, ms: 0, artifact: null };
    try {
      const r = await runBrowserStep(page, step, { timeout: opts.timeout });
      entry.via = r && r.via;
      if (r && r.skipped) entry.skipped = true;
    } catch (e) {
      entry.ok = false;
      entry.error = String(e.message || e).split('\n')[0].slice(0, 300);
    }
    entry.ms = Date.now() - started;
    if (opts.artifacts) entry.artifact = await shot(page, opts.artifacts, step.index).catch(() => null);
    run.steps.push(entry);
    if (opts.onStep) { try { opts.onStep(entry); } catch {} }
    if (!entry.ok) { run.ok = false; run.stoppedAt = step.index; run.error = entry.error; break; }
    if (SETTLE_MS) await sleep(SETTLE_MS);
  }
  return run;
}

async function shot(page, dir, index) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const name = `${String(index).padStart(2, '0')}.png`;
    await page.screenshot({ path: path.join(dir, name) });
    return name;
  } catch { return null; }
}

// ── desktop: kwin tools over MCP ────────────────────────────────────────────

const KW = 'mcp__kwin-mcp__';
const KW_COM = 'mcp__kwin-mcp-com__';

/** Find the kwin tool behind a short name, on either configured server name. */
function kwinTool(mcp, name) {
  if (!mcp || typeof mcp.getToolDefinitions !== 'function') return null;
  for (const def of mcp.getToolDefinitions()) {
    const full = def && def.function && def.function.name;
    if (!full) continue;
    if (full === KW + name || full === KW_COM + name) return full;
  }
  for (const def of mcp.getToolDefinitions()) {
    const full = def && def.function && def.function.name;
    if (full && full.startsWith('mcp__') && full.endsWith(`__${name}`) && /kwin/i.test(full)) return full;
  }
  return null;
}

/**
 * Elements from an element_query result: the structured payload when the
 * server sent one, else the rendered text lines ("- [push button] "Save" ...
 * [ref=e3, app='kate']").
 */
function parseElements(result) {
  if (!result) return [];
  const structured = result.structured || result.structuredContent;
  if (structured && Array.isArray(structured.elements)) return structured.elements;
  const text = String(result.content || '');
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^\s*-?\s*\[([^\]]+)\]\s+"([^"]*)"([\s\S]*)$/.exec(line);
    if (!m) continue;
    const ref = /ref=([^,\]\s]+)/.exec(m[3]);
    if (!ref) continue;
    out.push({ role: m[1], name: m[2], ref: ref[1], states: /\(([^)]*)\)/.exec(m[3])?.[1] || '', app: /app='([^']*)'/.exec(m[3])?.[1] || null });
  }
  return out;
}

/** Pick the element that best matches a target description. */
function pickElement(elements, step) {
  const want = String(step.name || step.target || '').trim().toLowerCase();
  const role = String(step.role || '').trim().toLowerCase();
  const usable = (elements || []).filter((e) => e && e.ref && !/(disabled)/i.test(String(e.states || '')));
  const pool = usable.length ? usable : (elements || []).filter((e) => e && e.ref);
  if (!pool.length) return null;
  const score = (e) => {
    const name = String(e.name || '').toLowerCase();
    let n = 0;
    if (name && name === want) n += 4;
    else if (name && want && name.includes(want)) n += 3;
    else if (name && want && want.includes(name)) n += 1;
    if (role && String(e.role || '').toLowerCase() === role) n += 2;
    if (step.app && String(e.app || '').toLowerCase() === String(step.app).toLowerCase()) n += 1;
    return n;
  };
  return pool.map((e) => ({ e, s: score(e) })).sort((a, b) => b.s - a.s)[0].e;
}

function hasKwin(mcp) {
  return !!kwinTool(mcp, 'element_query');
}

/**
 * Replay a desktop spec through kwin tools.
 *
 * @param {object} spec
 * @param {object} opts { values, mcp, signal, artifacts, onStep, timeout }
 */
async function replayDesktop(spec, opts = {}) {
  const bound = bindInputs(spec, opts.values || {});
  const mcp = opts.mcp;
  const run = { ok: true, surface: 'desktop', app: bound.app || null, steps: [], stoppedAt: null, error: null };
  if (!mcp || !hasKwin(mcp)) {
    return { ...run, ok: false, error: 'the kwin tools are not available. Add the kwin-mcp server in Settings > MCP, then run again.' };
  }
  const call = async (short, args, signal) => {
    const full = kwinTool(mcp, short);
    if (!full) return { error: `kwin tool ${short} is not available` };
    const res = await mcp.dispatchTool(full, args, signal);
    if (res && res.error) throw new Error(res.error);
    return res || {};
  };

  const calls = toDesktopCalls(bound);
  for (const c of calls) {
    if (opts.signal && opts.signal.aborted) { run.ok = false; run.stoppedAt = c.step; run.error = 'cancelled'; break; }
    const step = bound.steps.find((s) => s.index === c.step) || {};
    const started = Date.now();
    const entry = { index: c.step, action: c.action, note: c.note, ok: true, error: null, via: c.tool || null, ms: 0, artifact: null };
    try {
      if (!c.tool) throw new Error('this step has no desktop action. Fix the step name in the review list.');
      if (c.resolve) {
        const wanted = c.resolve.locator;
        if (!wanted.query && !wanted.role) throw new Error('the step names no control, so there is nothing to find on screen');
        const found = await call('element_query', { locator: wanted }, opts.signal);
        const el = pickElement(parseElements(found), step);
        if (!el) throw new Error(`no accessible element matching "${wanted.query || wanted.role}". Check the label in the app, or make sure accessibility is on for it.`);
        entry.via = `${c.tool} on ${el.role} "${el.name}"`;
        c.args = { ...c.args, ref: el.ref };
      }
      if (c.tool === 'pointer_drag') {
        const to = step.value ? { query: step.value } : null;
        if (!to) throw new Error('drag needs a destination');
        const found = await call('element_query', { locator: to }, opts.signal);
        const el = pickElement(parseElements(found), { name: step.value });
        if (!el) throw new Error(`no drop target matching "${step.value}"`);
        c.args.to = { ref: el.ref };
      }
      const args = { ...c.args };
      delete args.step;
      await call(c.tool, args, opts.signal);
    } catch (e) {
      entry.ok = false;
      entry.error = String(e.message || e).split('\n')[0].slice(0, 300);
    }
    entry.ms = Date.now() - started;
    if (opts.artifacts && kwinTool(mcp, 'screen_capture')) {
      const saved = await captureDesktop(mcp, kwinTool, opts.artifacts, c.step).catch(() => null);
      entry.artifact = saved;
    }
    run.steps.push(entry);
    if (opts.onStep) { try { opts.onStep(entry); } catch {} }
    if (!entry.ok) { run.ok = false; run.stoppedAt = c.step; run.error = entry.error; break; }
    if (SETTLE_MS) await sleep(SETTLE_MS);
  }
  return run;
}

async function captureDesktop(mcp, find, dir, index) {
  const full = find(mcp, 'screen_capture');
  if (!full) return null;
  const res = await mcp.dispatchTool(full, {});
  const image = res && Array.isArray(res.images) && res.images[0];
  if (!image || !image.data) return null;
  fs.mkdirSync(dir, { recursive: true });
  const name = `${String(index).padStart(2, '0')}.png`;
  fs.writeFileSync(path.join(dir, name), Buffer.from(image.data, 'base64'));
  return name;
}

// ── dispatcher ──────────────────────────────────────────────────────────────

/**
 * Replay a spec on whichever surface it was recorded from.
 *
 * @param {object} spec  from normalizeAutomation
 * @param {object} opts  { values, mcp, page, signal, artifacts, onStep, timeout }
 */
async function replay(spec, opts = {}) {
  const started = Date.now();
  if (!spec || !Array.isArray(spec.steps) || !spec.steps.length) {
    return { ok: false, surface: (spec && spec.surface) || null, steps: [], error: 'this automation has no steps to replay', ms: 0 };
  }
  const result = spec.surface === 'browser'
    ? await replayBrowser(spec, opts)
    : await replayDesktop(spec, opts);
  result.ms = Date.now() - started;
  result.values = opts.values || {};
  return result;
}

/** Default artifact directory for a run. */
function runArtifactDir(runId) {
  const base = process.env.SHMAKK_AUTOMATION_ARTIFACTS || path.join(os.tmpdir(), 'shmakk-automation-runs');
  return path.join(base, String(runId || Date.now()).replace(/[^a-z0-9_-]/gi, '_'));
}

module.exports = {
  browserStrategies,
  resolveOnPage,
  runBrowserStep,
  replay,
  replayBrowser,
  replayDesktop,
  parseElements,
  pickElement,
  kwinTool,
  hasKwin,
  runArtifactDir,
};

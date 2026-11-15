// Show-and-tell output stage.
//
// Converts the vision model's structured understanding (src/services/vision.js)
// into one of two deliverables:
//   • notes     : a reference of what the user said needs changing, anchored to
//                  the page and element it is about. Screenshots are context.
//   • automation: executable automation steps, built from the spoken narration
//                  treated as instructions (semantic targets; selectors are
//                  resolved at replay time against the live DOM, never guessed
//                  from screenshots)
//
// Both mappings are deterministic and fully testable. The vision model does the
// hard multimodal work; this module only normalises and shapes its output, so no
// second LLM call (and no additional hallucination surface) is introduced.

// ── action vocabulary ───────────────────────────────────────────────────────
// Maps the analysis "action" enum (and common model synonyms) onto the action
// names understood by the browser automation executor (src/vibedit/prompts.js).

const ACTION_MAP = {
  click: 'click',
  tap: 'click',
  hit: 'click',
  push: 'click',
  press: 'press',
  key: 'press',
  type: 'type',
  enter: 'type',
  input: 'type',
  write: 'type',
  paste: 'type',
  fill: 'type',
  navigate: 'navigate',
  goto: 'navigate',
  'go to': 'navigate',
  open: 'navigate',
  launch: 'navigate',
  select: 'select',
  choose: 'select',
  pick: 'select',
  scroll: 'scroll',
  swipe: 'scroll',
  hover: 'hover',
  drag: 'drag',
  drop: 'drag',
  wait: 'wait',
  'wait for': 'waitSelector',
  submit: 'press',
  save: 'click',
  confirm: 'click',
  'double click': 'click',
  'right click': 'click',
};

const RECOGNIZED_ACTIONS = new Set(['click', 'type', 'press', 'select', 'scroll', 'hover', 'drag', 'navigate', 'wait', 'waitSelector']);

function normalizeAction(action) {
  const a = String(action || '').trim().toLowerCase();
  return ACTION_MAP[a] || 'other';
}

// ── analysis normalisation ──────────────────────────────────────────────────

// Vision models sometimes narrate in the third person ("The user opens the
// settings", "the user says the button is too small") even when asked for
// direct statements. Strip that framing so summaries and notes read as the
// point itself, not commentary about whoever recorded it.
const NARRATION_RE = /^(?:the|this)\s+user(?:'s)?\s+(?:opens?|opened|says?|said|shows?|showed|clicks?|clicked|navigates?|navigated|goes?|went|types?|typed|presses?|pressed|selects?|selected|scrolls?|scrolled|hovers?|hovered|drags?|dragged|waits?|waited|is|are|was|were|has|had|points?|pointed|wants?|wanted|needs?|needed|asks?|asked|mentions?|mentioned|notes?|noted|initiates?|initiated|records?|recorded|begins?|began|starts?|started|stops?|stopped|ends?|ended|finishes?|finished|captures?|captured|uses?|used|creates?|created|enters?|entered|describes?|described|demonstrates?|demonstrated|explains?|explained|reports?|reported|discusses?|discussed|taps?|tapped|looks?|looked|sees?|saw|speaks?|spoke|talks?|talked|tells?|told|walks?|walked|moves?|moved|resizes?|resized|changes?|changed|edits?|edited|saves?|saved|searches?|searched)\s+(?:to\s+|that\s+)?/i;

function cleanNarration(text) {
  let s = String(text || '').trim();
  const m = NARRATION_RE.exec(s);
  if (m) {
    s = s.slice(m[0].length);
    if (s) s = s.charAt(0).toUpperCase() + s.slice(1);
  }
  return s.trim();
}

function normalizeStep(s, i) {
  if (!s || typeof s !== 'object') return null;
  const action = normalizeAction(s.action);
  const target = String(s.target || s.element || s.label || '').trim();
  const value = s.value != null ? String(s.value) : null;
  const key = s.key != null ? String(s.key) : null;
  const detail = cleanNarration(String(s.detail || s.description || '').trim());
  // Drop a step only when it carries no actionable information at all.
  if (!target && !detail && !value && !key && action === 'other') return null;
  return {
    index: Number.isFinite(Number(s.index)) ? Number(s.index) : i + 1,
    action,
    target,
    value,
    key,
    detail,
    transcript: s.transcript ? String(s.transcript) : null,
    frames: Array.isArray(s.frames) ? s.frames.map((n) => Number(n)).filter((n) => Number.isFinite(n)) : [],
    confidence: Number.isFinite(Number(s.confidence)) ? Number(s.confidence) : null,
  };
}

function normalizeAnalysis(analysis) {
  const a = (analysis && typeof analysis === 'object') ? analysis : {};
  const steps = Array.isArray(a.steps) ? a.steps : [];
  const rawFindings = Array.isArray(a.findings)
    ? a.findings
    : Array.isArray(a.observations) ? a.observations : [];
  return {
    summary: cleanNarration(String(a.summary || '').trim()),
    goal: cleanNarration(String(a.goal || a.title || '').trim()),
    app: a.app ? String(a.app).trim() : null,
    page: a.page ? String(a.page).trim() : null,
    findings: rawFindings.map((f, i) => normalizeFinding(f, i)).filter(Boolean),
    steps: steps.map((s, i) => normalizeStep(s, i)).filter(Boolean),
    uncertain: Array.isArray(a.uncertain) ? a.uncertain.map((x) => cleanNarration(x)) : [],
    notes: Array.isArray(a.notes) ? a.notes.map((x) => cleanNarration(x)) : [],
  };
}

// A finding is what the user pointed at and said should change, not a step to
// execute. It is anchored to a page and element so it can be found again.
function normalizeFinding(f, i) {
  if (!f || typeof f !== 'object') return null;
  const page = String(f.page || '').trim();
  const element = String(f.element || f.target || f.label || '').trim();
  const note = cleanNarration(String(f.note || f.detail || f.description || '').trim());
  const quote = f.quote != null ? String(f.quote).trim() : null;
  // Drop a finding only when it says nothing at all.
  if (!note && !element && !quote) return null;
  return {
    index: Number.isFinite(Number(f.index)) ? Number(f.index) : i + 1,
    kind: ['bug', 'change', 'feature', 'chore'].includes(f.kind) ? f.kind : null,
    page: page || null,
    element: element || null,
    note,
    quote: quote || null,
    frames: Array.isArray(f.frames) ? f.frames.map((n) => Number(n)).filter((n) => Number.isFinite(n)) : [],
    confidence: Number.isFinite(Number(f.confidence)) ? Number(f.confidence) : null,
  };
}

// Fallback for older or non-compliant analyses that only returned action steps.
// Derive findings from them so a plan is never silently empty, while keeping
// the original wording rather than inventing new text.
function findingsFromSteps(steps) {
  return (Array.isArray(steps) ? steps : [])
    .map((s, i) => normalizeFinding({
      index: s.index ?? i + 1,
      page: null,
      element: s.target || null,
      note: s.detail || s.target || '',
      quote: s.transcript || null,
      frames: s.frames,
      confidence: s.confidence,
    }, i))
    .filter(Boolean);
}

// ── helpers ─────────────────────────────────────────────────────────────────

function actionVerb(action) {
  const v = {
    click: 'Click',
    type: 'Type into',
    press: 'Press',
    select: 'Select',
    scroll: 'Scroll',
    hover: 'Hover over',
    drag: 'Drag',
    navigate: 'Open',
    wait: 'Wait for',
    waitSelector: 'Wait for',
    other: 'Act on',
  };
  return v[action] || 'Act on';
}

function planTitle(s) {
  if (!s.target) return (s.detail || 'Next step').slice(0, 100);
  return `${actionVerb(s.action)} ${s.target}`.trim().slice(0, 100);
}

function findingLocation(f) {
  const where = [f.page, f.element].filter(Boolean).join(' > ');
  return (where || f.note || 'Finding').slice(0, 120);
}

function findingEvidence(f) {
  const out = {};
  if (f.frames && f.frames.length) out.frames = f.frames;
  if (f.quote) out.transcript = f.quote;
  if (f.confidence != null) out.confidence = f.confidence;
  return out;
}

// ── notes / plan output ─────────────────────────────────────────────────────

/**
 * Convert a vision understanding into a reference of what needs changing.
 * Each item is a finding: what the user said, where it is, plus context frames.
 * @returns {{kind:'plan', title:string, goal:string, summary:string,
 *            app:string|null, page:string|null, tasks:Array,
 *            uncertain:Array, notes:Array}}
 */
function toPlan(analysis) {
  const a = normalizeAnalysis(analysis);
  const findings = a.findings.length ? a.findings : findingsFromSteps(a.steps);
  const title = (a.summary || a.page || a.goal || 'Show and tell notes').slice(0, 100);
  const tasks = findings.map((f) => ({
    id: String(f.index),
    title: findingLocation(f),
    description: f.note,
    page: f.page,
    element: f.element,
    evidence: findingEvidence(f),
  }));
  return {
    kind: 'plan',
    title,
    goal: a.goal,
    summary: a.summary,
    app: a.app,
    page: a.page,
    status: 'pending_review',
    createdAt: new Date().toISOString(),
    tasks,
    uncertain: a.uncertain,
    notes: a.notes,
  };
}

// ── automation output ───────────────────────────────────────────────────────

function automationAction(s) {
  const out = {
    action: s.action,
    description: s.detail || planTitle(s),
  };
  // "target" is a semantic description ("the Save button"), NOT a CSS selector.
  // Selectors are resolved at replay time against the live DOM (see vibedit).
  if (s.target) out.target = s.target;
  if (s.value != null) out.value = s.value;
  if (s.key != null) out.key = s.key;
  if (s.confidence != null) out.confidence = s.confidence;
  if (s.frames && s.frames.length) out.frames = s.frames;
  return out;
}

/**
 * Convert a vision understanding into executable automation steps.
 * Steps the model could not map to a known action are surfaced as warnings for
 * human review rather than silently coerced into clicks.
 */
function toAutomation(analysis) {
  const a = normalizeAnalysis(analysis);
  const actions = [];
  const warnings = [];
  for (const s of a.steps) {
    if (s.action === 'other' || !RECOGNIZED_ACTIONS.has(s.action)) {
      warnings.push(`Skipped unrecognised action in step ${s.index}: ${s.detail || s.target || 'no description'}: needs manual review`);
      continue;
    }
    actions.push(automationAction(s));
  }
  return {
    kind: 'automation',
    summary: a.summary,
    goal: a.goal,
    app: a.app,
    status: 'pending_review',
    createdAt: new Date().toISOString(),
    actions,
    script: toPlaywrightScript({ app: a.app, actions }),
    warnings,
    uncertain: a.uncertain,
    notes: a.notes,
  };
}

// ── Playwright skeleton ─────────────────────────────────────────────────────

const PLAYWRIGHT_STEP = {
  click: (sel, a) => `  await page.click('${sel}');`,
  type: (sel, a) => `  await page.fill('${sel}', '${String(a.value || '').replace(/'/g, "\\'")}');`,
  press: (sel, a) => `  await page.press('${sel}', '${String(a.key || 'Enter').replace(/'/g, "\\'")}');`,
  select: (sel, a) => `  await page.selectOption('${sel}', '${String(a.value || '').replace(/'/g, "\\'")}');`,
  scroll: (sel, a) => `  await page.locator('${sel}').scrollIntoViewIfNeeded();`,
  hover: (sel, a) => `  await page.hover('${sel}');`,
  drag: (sel, a) => `  await page.locator('${sel}').dragTo(page.locator('${String(a.target || '').replace(/'/g, "\\'")}'));`,
  navigate: (sel, a) => `  await page.goto('${String(a.value || a.target || '').replace(/'/g, "\\'")}');`,
  wait: (sel, a) => `  await page.waitForTimeout(${Number(a.value || a.detail) || 1000});`,
  waitSelector: (sel, a) => `  await page.waitForSelector('${sel}');`,
};

/**
 * Produce a readable Playwright skeleton for the recorded automation. Because
 * the recording contains screenshots (not the DOM), selectors are emitted as
 * labelled placeholders for a human or the replay-time executor to fill in.
 */
function toPlaywrightScript({ app, actions }) {
  const lines = [
    "const { chromium } = require('playwright');",
    '(async () => {',
    "  const browser = await chromium.launch({ headless: false });",
    '  const page = await browser.newPage();',
  ];
  if (/^https?:\/\//i.test(String(app || ''))) {
    lines.push(`  await page.goto('${String(app).replace(/'/g, "\\'")}');`);
  } else {
    lines.push("  await page.goto('https://example.com'); // TODO: set the starting URL");
  }
  const list = Array.isArray(actions) ? actions : [];
  const legend = [];
  list.forEach((a, i) => {
    const sel = `SELECTOR_${i + 1}`;
    legend.push(`  // ${sel} = ${a.action}${a.target ? ` "${a.target}"` : ''}${a.description ? `: ${a.description}` : ''}`);
    const fn = PLAYWRIGHT_STEP[a.action] || PLAYWRIGHT_STEP.click;
    lines.push(fn(sel, a));
  });
  if (legend.length) {
    lines.push('');
    lines.push('  // Resolve these placeholders against the target page:');
    lines.push(...legend);
  }
  lines.push('  await browser.close();');
  lines.push('})();');
  return lines.join('\n');
}

// ── dispatcher ──────────────────────────────────────────────────────────────

/** Generate a plan (default) or automation from a vision understanding. */
function generate(analysis, opts = {}) {
  return opts.mode === 'automation' ? toAutomation(analysis, opts) : toPlan(analysis, opts);
}

module.exports = {
  ACTION_MAP,
  normalizeAction,
  normalizeStep,
  cleanNarration,
  normalizeAnalysis,
  toPlan,
  toAutomation,
  toPlaywrightScript,
  generate,
};

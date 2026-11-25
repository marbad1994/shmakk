// Recorded automations: a screen recording turned into a replayable spec.
//
// The vision model reads the frames in order (narration is optional) and
// reports, for each visible state change, the action that caused it. This
// module normalises that into one shape that the replay engine can execute:
//
//   surface  'browser' or 'desktop'
//   steps    one action each, with a semantic target (role + accessible name
//            for the web, accessible name + role for AT-SPI on the desktop)
//   inputs   the values that were typed, lifted out as variables so the same
//            recording can be replayed over a list, one run per item
//
// Targets stay semantic on purpose. A screenshot cannot tell you a CSS
// selector, and guessing one is what made earlier recordings unusable. The
// selector is resolved against the live page (automation-replay.js) or the
// live accessibility tree (kwin tools), at replay time.

const path = require('path');

// Action vocabulary shared by both surfaces. 'manual' is a step the model saw
// but could not name: it is kept and surfaced for a person, never guessed into
// a click.
const ACTIONS = new Set([
  'navigate', 'launch', 'focus', 'click', 'dblclick', 'rightclick',
  'type', 'press', 'select', 'scroll', 'hover', 'drag', 'wait', 'manual',
]);

const ACTION_MAP = {
  click: 'click', tap: 'click', hit: 'click', push: 'click', press_button: 'click', toggle: 'click', check: 'click',
  'double click': 'dblclick', dblclick: 'dblclick', doubleclick: 'dblclick',
  'right click': 'rightclick', rightclick: 'rightclick', contextmenu: 'rightclick',
  type: 'type', enter: 'type', input: 'type', write: 'type', paste: 'type', fill: 'type',
  press: 'press', key: 'press', hotkey: 'press', shortcut: 'press',
  select: 'select', choose: 'select', pick: 'select',
  navigate: 'navigate', goto: 'navigate', 'go to': 'navigate', open: 'navigate', visit: 'navigate',
  launch: 'launch', start: 'launch', run: 'launch',
  focus: 'focus', activate: 'focus', switch: 'focus', raise: 'focus',
  scroll: 'scroll', swipe: 'scroll', wheel: 'scroll',
  hover: 'hover',
  drag: 'drag', drop: 'drag', move: 'drag',
  wait: 'wait', pause: 'wait', sleep: 'wait', 'wait for': 'wait',
};

const KNOWN_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'option', 'checkbox', 'radio',
  'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'menu', 'dialog', 'slider',
  'spinbutton', 'treeitem', 'gridcell', 'listitem', 'cell', 'row', 'heading', 'label', 'img',
  'push button', 'check box', 'radio button', 'menu item', 'text', 'entry', 'combo box', 'page tab',
]);

// Applications whose window means "this is the web".
const BROWSERS = /(chrome|chromium|firefox|edge|safari|brave|vivaldi|opera|arc|librewolf|zen browser|thorium)/i;

const looksLikeUrl = (s) => /^(https?:\/\/|www\.)/i.test(String(s || '').trim());

/** Map a model action (or a synonym) onto the shared vocabulary. */
function normalizeAction(action) {
  const a = String(action || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (ACTIONS.has(a)) return a;
  return ACTION_MAP[a] || 'manual';
}

function normalizeRole(role) {
  const r = String(role || '').trim().toLowerCase();
  if (!r) return null;
  // "button Submit" and "role=button" both mean button.
  const head = r.replace(/^role\s*[:=]\s*/, '').split(/[\s,]/)[0];
  if (KNOWN_ROLES.has(r)) return r;
  if (KNOWN_ROLES.has(head)) return head;
  return r.slice(0, 30) || null;
}

// The widget nouns a person says out loud but a screen reader does not read:
// "the Save button" is the control named "Save".
const TRAILING_ROLE_NOUN = /\s+(button|link|field|input|tab|menu|checkbox|check box|radio|radio button|textbox|text box|search box|combo box|entry|menu item)\s*$/i;

/**
 * Turn a spoken control description into the accessible name.
 *
 * "the Save button" - "Save". The article is dropped when a role noun was
 * removed or when the caller already knows the role, so a name that merely
 * starts with "The" ("the Netherlands") survives when neither is true. A name
 * that is nothing but a role word ("Button") is never stripped to emptiness,
 * and URLs pass through untouched.
 */
function stripSpokenName(raw, opts = {}) {
  const t = cleanText(raw);
  if (!t || looksLikeUrl(t)) return t;
  const withoutNoun = t.replace(TRAILING_ROLE_NOUN, '').trim();
  const nounStripped = Boolean(withoutNoun) && withoutNoun !== t;
  if (!nounStripped && !opts.role) return t;
  const withoutArticle = (nounStripped ? withoutNoun : t).replace(/^(?:the|an?)\s+/i, '').trim();
  return withoutArticle || t;
}

/** The accessible name of a control: what a person reads on screen. */
function controlName(s) {
  const raw = s.name != null && String(s.name).trim() ? s.name : (s.label != null ? s.label : s.target);
  // "the Save button" reads better as "Save" when a role is also known.
  const n = stripSpokenName(raw == null ? '' : raw, { role: Boolean(s.role) });
  return n.replace(/^["'`]|["'`]$/g, '').trim();
}

/** A stable variable name for a value that a replay may want to change. */
function inputSlug(step, index) {
  const raw = String(step.inputName || step.input || step.name || step.target || '').trim();
  const base = raw.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
  if (base && /^[a-z]/.test(base)) return base;
  return `value_${index}`;
}

function cleanText(t, max = 300) {
  return String(t == null ? '' : t).replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Decide which surface the recording belongs to.
 *
 * The model states it when it can. Otherwise the browser wins on evidence:
 * a URL, a browser in the app name, or a navigation step. Everything else is a
 * desktop workflow, which is the safer default because desktop replay uses the
 * accessibility tree and never touches a network.
 */
function inferSurface(analysis) {
  const a = analysis && typeof analysis === 'object' ? analysis : {};
  const said = String(a.surface || a.platform || '').trim().toLowerCase();
  if (/^(browser|web|website|webapp|web app)$/.test(said)) return 'browser';
  if (/^(desktop|app|application|native|linux|window)$/.test(said)) return 'desktop';
  if (looksLikeUrl(a.url || a.startUrl)) return 'browser';
  if (a.app && BROWSERS.test(a.app)) return 'browser';
  const steps = Array.isArray(a.steps) ? a.steps : [];
  if (steps.some((s) => s && normalizeAction(s.action) === 'navigate' && looksLikeUrl(s.value || s.url || s.target))) return 'browser';
  if (steps.some((s) => String((s && (s.role || '')) || '').toLowerCase().match(/^(button|link|textbox|searchbox|combobox)$/))) return 'browser';
  return 'desktop';
}

/** The URL the recording started on, when the model could read one. */
function startUrlOf(analysis, surface) {
  const a = analysis && typeof analysis === 'object' ? analysis : {};
  const candidate = [a.url, a.startUrl, a.pageUrl, ...(Array.isArray(a.steps) ? a.steps.map((s) => s && (s.value || s.url)) : [])]
    .map((v) => String(v || '').trim())
    .filter((v) => looksLikeUrl(v));
  if (!surface || surface === 'browser') return candidate[0] || null;
  return null;
}

/**
 * Build the replayable spec from a vision analysis.
 *
 * @param {object} analysis  the model's structured understanding
 * @param {object} [opts]
 * @param {Array}  [opts.frames]  the frames that were shown, in vision order,
 *                                used to keep each step's evidence screenshot
 * @returns {object} { kind, surface, app, url, goal, summary, inputs, steps, warnings, uncertain, notes }
 */
function normalizeAutomation(analysis, opts = {}) {
  const a = analysis && typeof analysis === 'object' ? analysis : {};
  const frames = Array.isArray(opts.frames) ? opts.frames : [];
  const surface = inferSurface(a);
  const warnings = [];

  const rawSteps = (Array.isArray(a.steps) ? a.steps : [])
    .filter((s) => s && typeof s === 'object')
    .map((s, i) => {
      const action = normalizeAction(s.action);
      // The spoken description and the accessible name must not disagree: a
      // step recorded as "the Save button" replays against "Save".
      const target = stripSpokenName(cleanText(s.target || s.element || s.label || s.name || ''), { role: Boolean(s.role) });
      const name = controlName(s);
      const value = s.value != null && String(s.value).trim() !== '' ? String(s.value) : null;
      const key = s.key != null && String(s.key).trim() ? String(s.key) : null;
      const detail = cleanText(s.detail || s.description || '');
      const frameNums = (Array.isArray(s.frames) ? s.frames : []).map(Number).filter((n) => Number.isFinite(n) && n >= 1);
      const step = {
        index: 0,
        surface: /^(browser|web|desktop|app)$/i.test(String(s.surface || '')) ? (inferSurface({ surface: s.surface }) || surface) : surface,
        action,
        target: target || name || null,
        name: name || null,
        role: normalizeRole(s.role),
        value,
        key,
        detail: detail || null,
        expected: cleanText(s.expected || s.effect || '') || null,
        confidence: Number.isFinite(Number(s.confidence)) ? Number(s.confidence) : null,
        evidence: frameNums.map((n) => frames[n - 1] && frames[n - 1].file).filter(Boolean),
        transcript: s.transcript ? cleanText(s.transcript, 400) : null,
      };
      const inputName = s.input_name || s.inputName || s.variableName || null;
      if (inputName) step.inputName = String(inputName);
      if (s.variable === true) step.variable = true;
      if (action === 'manual') {
        warnings.push(`Step ${i + 1} could not be mapped to an action (${detail || target || 'no description'}). It stays in the list for a person to fix.`);
      }
      // A click with no target at all cannot be replayed; keep it visible.
      if (['click', 'dblclick', 'rightclick', 'hover', 'select', 'drag'].includes(action) && !step.target && !step.role) {
        warnings.push(`Step ${i + 1} names no control (${detail || action}). Name the element in the review list so replay can find it.`);
      }
      return step;
    });

  // Consecutive screenshots of the same state produce repeated steps; keep one.
  for (let i = rawSteps.length - 1; i > 0; i -= 1) {
    const s = rawSteps[i];
    const prev = rawSteps[i - 1];
    if (prev.action === s.action && prev.target === s.target && prev.value === s.value && prev.key === s.key) rawSteps.splice(i, 1);
  }
  rawSteps.forEach((s, i) => { s.index = i + 1; });

  // Values the model already called variables, plus every typed or selected
  // value: the point of the format is "do this for each item in that list", so
  // each recorded value becomes an input with the recorded text as the default.
  const inputs = [];
  const byName = new Map();
  const declared = new Map();
  for (const d of Array.isArray(a.inputs) ? a.inputs : []) {
    if (!d || typeof d !== 'object') continue;
    const name = inputSlug({ inputName: d.name || d.label }, declared.size + 1);
    declared.set(name, { label: cleanText(d.label || d.name, 60) || name, example: d.example != null ? String(d.example) : null });
  }
  for (const step of rawSteps) {
    if (!['type', 'select'].includes(step.action) || step.value == null) continue;
    const wanted = step.inputName || step.variableName || (declared.has(inputSlug(step, 0)) ? inputSlug(step, 0) : null);
    let name = wanted ? inputSlug({ inputName: wanted }, inputs.length + 1) : inputSlug(step, inputs.length + 1);
    if (byName.has(name)) {
      if (byName.get(name).example !== step.value) {
        // Same label, different value: two independent variables.
        name = `${name}_${inputs.length + 1}`;
      } else {
        step.input = name;
        continue;
      }
    }
    const input = { name, label: cleanText(step.name || step.target || declared.get(name)?.label || name, 60), example: step.value };
    byName.set(name, input);
    inputs.push(input);
    step.input = name;
  }

  const steps = rawSteps.map((s) => (s.surface === 'desktop' && s.action === 'navigate' ? { ...s, action: 'launch', value: s.value || s.target } : s));

  const hasTypeStep = steps.some((s) => s.action === 'type');
  if (!steps.length) {
    warnings.push('No actions were found in this recording. Show each click and each field being filled, and keep the screen still for a moment after each one.');
  }

  return {
    kind: 'automation',
    version: 1,
    surface,
    app: a.app ? cleanText(a.app, 120) : null,
    url: startUrlOf(a, surface),
    goal: cleanText(a.goal || a.summary || '', 200) || null,
    summary: cleanText(a.summary || '', 600) || null,
    inputs,
    steps,
    typingSteps: hasTypeStep,
    warnings,
    uncertain: (Array.isArray(a.uncertain) ? a.uncertain : []).map((x) => cleanText(x, 300)).filter(Boolean),
    notes: (Array.isArray(a.notes) ? a.notes : []).map((x) => cleanText(x, 300)).filter(Boolean),
    createdAt: new Date().toISOString(),
  };
}

/**
 * Replace each step's recorded value with the value supplied for its input.
 * Missing values fall back to the recorded example, so a run with no overrides
 * replays exactly what was recorded.
 */
function bindInputs(spec, values = {}) {
  const inputs = Array.isArray(spec && spec.inputs) ? spec.inputs : [];
  const fallback = new Map(inputs.map((i) => [i.name, i.example]));
  const steps = (Array.isArray(spec && spec.steps) ? spec.steps : []).map((s) => {
    if (!s.input) return { ...s };
    const v = values[s.input] != null ? values[s.input] : fallback.get(s.input);
    return v == null ? { ...s } : { ...s, value: String(v) };
  });
  return { ...spec, steps };
}

/** Names of the inputs a spec needs before it can run. */
function requiredInputs(spec) {
  return (Array.isArray(spec && spec.inputs) ? spec.inputs : []).map((i) => i.name);
}

/** One line describing a step, for logs and review lists. */
function describeStep(step) {
  if (!step) return '';
  const at = step.name || step.target || '';
  switch (step.action) {
    case 'navigate': return `Open ${step.value || at}`;
    case 'launch': return `Launch ${step.value || at}`;
    case 'focus': return `Focus the window ${at || step.value || ''}`.trim();
    case 'click': return at ? `Click ${at}` : 'Click';
    case 'dblclick': return at ? `Double click ${at}` : 'Double click';
    case 'rightclick': return at ? `Right click ${at}` : 'Right click';
    case 'type': return step.value != null ? `Type "${step.value}"${at ? ` into ${at}` : ''}` : `Type into ${at || 'the focused field'}`;
    case 'press': return `Press ${step.key || 'Enter'}${at ? ` in ${at}` : ''}`;
    case 'select': return `Select "${step.value || ''}"${at ? ` in ${at}` : ''}`;
    case 'scroll': return `Scroll${at ? ` over ${at}` : ''}`;
    case 'hover': return at ? `Hover ${at}` : 'Hover';
    case 'drag': return at ? `Drag ${at} to ${step.value || 'the target'}` : 'Drag';
    case 'wait': return step.value ? `Wait ${step.value}` : 'Wait';
    default: return step.detail || at || step.action;
  }
}

/** A short human title for the recording, when the model gave no goal. */
function specTitle(spec) {
  if (!spec) return 'Recorded automation';
  if (spec.goal) return spec.goal;
  const first = spec.steps && spec.steps[0];
  const what = first ? describeStep(first) : null;
  return what ? `${spec.surface === 'browser' ? 'Web' : 'Desktop'}: ${what}`.slice(0, 90) : 'Recorded automation';
}

// ── script output (for reading and for copy-out) ─────────────────────────────

const quote = (s) => `'${String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

function locatorLine(step, i) {
  if (step.role && step.name) return `  const step${i + 1} = page.getByRole(${quote(step.role)}, { name: ${quote(step.name)} });`;
  if (step.name) return `  const step${i + 1} = page.getByText(${quote(step.name)}, { exact: false }).first();`;
  return null;
}

/**
 * A Playwright script that uses the same target resolution as the replay
 * engine: role plus accessible name first, visible text second. Values come
 * from a `values` object so the script can loop over a list.
 */
function toPlaywrightScript(spec) {
  const steps = Array.isArray(spec && spec.steps) ? spec.steps : [];
  const inputs = Array.isArray(spec && spec.inputs) ? spec.inputs : [];
  const lines = [
    "const { chromium } = require('playwright');",
    '',
    '// Values for this run. The recorded text is the default.',
    `const values = ${JSON.stringify(Object.fromEntries(inputs.map((i) => [i.name, i.example])))};`,
    '',
    '(async () => {',
    "  const browser = await chromium.launch({ headless: false });",
    '  const page = await browser.newPage();',
  ];
  if (spec && spec.url) lines.push(`  await page.goto(${quote(spec.url)});`);
  steps.forEach((s, i) => {
    const val = s.input ? `values.${s.input}` : quote(s.value);
    const decl = locatorLine(s, i);
    if (decl) lines.push(decl);
    const loc = decl ? `step${i + 1}` : null;
    switch (s.action) {
      case 'navigate': lines.push(`  await page.goto(${quote(s.value || '')});`); break;
      case 'click': lines.push(loc ? `  await ${loc}.click();` : '  // click: no target named'); break;
      case 'dblclick': lines.push(loc ? `  await ${loc}.dblclick();` : '  // double click: no target named'); break;
      case 'rightclick': lines.push(loc ? `  await ${loc}.click({ button: 'right' });` : '  // right click: no target named'); break;
      case 'hover': lines.push(loc ? `  await ${loc}.hover();` : '  // hover: no target named'); break;
      case 'type': lines.push(loc ? `  await ${loc}.fill(String(${val}));` : `  await page.keyboard.type(String(${val}));`); break;
      case 'press': lines.push(loc ? `  await ${loc}.press(${quote(s.key || 'Enter')});` : `  await page.keyboard.press(${quote(s.key || 'Enter')});`); break;
      case 'select': lines.push(loc ? `  await ${loc}.selectOption(String(${val}));` : '  // select: no target named'); break;
      case 'scroll': lines.push(loc ? `  await ${loc}.scrollIntoViewIfNeeded();` : "  await page.mouse.wheel(0, 600);"); break;
      case 'wait': lines.push(`  await page.waitForTimeout(${Number(s.value) || 800});`); break;
      default: lines.push(`  // ${s.action}: ${describeStep(s)}`);
    }
  });
  lines.push('  await browser.close();', '})();');
  return lines.join('\n');
}

/**
 * The desktop side as a list of kwin tool calls. Kept as data (not code) so it
 * can be shown in the UI and executed by automation-replay.js.
 */
function toDesktopCalls(spec) {
  const steps = Array.isArray(spec && spec.steps) ? spec.steps : [];
  return steps.map((s) => {
    const base = { step: s.index, action: s.action, note: describeStep(s) };
    const locator = { query: s.name || s.target || undefined, role: s.role || undefined, app: spec.app || undefined };
    for (const k of Object.keys(locator)) if (!locator[k]) delete locator[k];
    switch (s.action) {
      case 'launch': return { ...base, tool: 'app_launch', args: { command: s.value || s.name || '' } };
      case 'focus': return { ...base, tool: 'window_focus', args: { window: { caption: s.name || s.target || '' } } };
      case 'type': return { ...base, tool: 'keyboard_type', args: { text: s.value || '', method: 'unicode' } };
      case 'press': return { ...base, tool: 'keyboard_press', args: { keys: s.key || 'Return' } };
      case 'click': case 'dblclick': case 'rightclick':
        return {
          ...base,
          tool: 'pointer_click',
          resolve: { locator },
          args: { ref: '$ref', button: s.action === 'rightclick' ? 'right' : 'left', count: s.action === 'dblclick' ? 2 : 1 },
        };
      case 'hover': return { ...base, tool: 'pointer_move', resolve: { locator }, args: { ref: '$ref' } };
      case 'scroll': return { ...base, tool: 'pointer_scroll', resolve: { locator }, args: { ref: '$ref', delta: Number(s.value) || 5 } };
      case 'drag': return { ...base, tool: 'pointer_drag', resolve: { locator }, args: { from: { ref: '$ref' }, to: null } };
      default: return { ...base, tool: null, args: {} };
    }
  });
}

/** The frames a spec cites, so a reviewer can see what each step was based on. */
function evidenceFiles(spec) {
  const out = [];
  for (const s of (spec && spec.steps) || []) for (const f of s.evidence || []) if (f && !out.includes(f)) out.push(f);
  return out;
}

/** Where a replay writes its step artifacts. */
function artifactDir(base, runId) {
  return path.join(base, String(runId || 'run').replace(/[^a-z0-9_-]/gi, '_'));
}

module.exports = {
  ACTIONS,
  ACTION_MAP,
  normalizeAction,
  normalizeRole,
  controlName,
  inferSurface,
  normalizeAutomation,
  bindInputs,
  requiredInputs,
  describeStep,
  specTitle,
  toPlaywrightScript,
  toDesktopCalls,
  evidenceFiles,
  artifactDir,
  looksLikeUrl,
};

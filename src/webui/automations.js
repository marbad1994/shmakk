// Cowork automations: saved multi-step tasks that run by hand, on a schedule,
// or when a webhook is called. Each run becomes its own Cowork conversation,
// so you can read exactly what happened and continue it by chatting.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

const MAX_RUNS = 40;
const MAX_STEPS = 12;
const ASK_TIMEOUT_MS = 60 * 60e3;

// ── cron ────────────────────────────────────────────────────────────────────
// Standard 5 fields: minute hour day-of-month month day-of-week (0 or 7 = Sunday).
// Supports * , - / and names for months and weekdays.

const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const NAMES = [null, null, null,
  { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 },
  { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }];

function parseField(text, idx) {
  const [lo, hi] = RANGES[idx];
  const set = new Set();
  for (const part of String(text).toLowerCase().split(',')) {
    const m = /^(\*|[a-z0-9]+(?:-[a-z0-9]+)?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`bad cron field "${text}"`);
    const step = m[2] ? Number(m[2]) : 1;
    if (!step) throw new Error(`bad step in "${text}"`);
    let a = lo; let b = hi;
    if (m[1] !== '*') {
      const num = (s) => { const v = NAMES[idx] && s in NAMES[idx] ? NAMES[idx][s] : Number(s); if (!Number.isInteger(v)) throw new Error(`bad value "${s}"`); return v; };
      const [x, y] = m[1].split('-');
      a = num(x); b = y === undefined ? (m[2] ? hi : a) : num(y);
    }
    if (a < lo || b > hi || a > b) throw new Error(`"${text}" is out of range ${lo}-${hi}`);
    for (let v = a; v <= b; v += step) set.add(idx === 4 && v === 7 ? 0 : v);
  }
  return set;
}

function parseCron(expr) {
  const fields = String(expr || '').trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('cron needs 5 fields: minute hour day month weekday');
  const [minute, hour, dom, month, dow] = fields.map(parseField);
  return { minute, hour, dom, month, dow, domStar: fields[2] === '*', dowStar: fields[4] === '*' };
}

const fmtCache = new Map();
function partsIn(date, timeZone) {
  let f = fmtCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' });
    fmtCache.set(timeZone, f);
  }
  const o = {};
  for (const p of f.formatToParts(date)) o[p.type] = p.value;
  return { minute: +o.minute, hour: +o.hour, dom: +o.day, month: +o.month, dow: NAMES[4][o.weekday.toLowerCase()] };
}

function validTimeZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

function matches(c, p) {
  if (!c.minute.has(p.minute) || !c.hour.has(p.hour) || !c.month.has(p.month)) return false;
  // cron rule: when both day fields are restricted, either may match
  if (c.domStar || c.dowStar) return c.dom.has(p.dom) && c.dow.has(p.dow);
  return c.dom.has(p.dom) || c.dow.has(p.dow);
}

// First matching minute strictly after `from` (ms), or null within ~4 years.
function nextRun(expr, from = Date.now(), timeZone = 'UTC') {
  const c = parseCron(expr);
  let t = Math.floor(from / 60000) * 60000 + 60000;
  const limit = t + 4 * 366 * 86400e3;
  while (t < limit) {
    const p = partsIn(new Date(t), timeZone);
    if (matches(c, p)) return t;
    // Skip ahead in big steps when the month/day/hour can't match.
    const dayOk = c.month.has(p.month) && ((c.domStar || c.dowStar) ? c.dom.has(p.dom) && c.dow.has(p.dow) : c.dom.has(p.dom) || c.dow.has(p.dow));
    if (!dayOk) t += (60 - p.minute) * 60000 + (23 - p.hour) * 3600e3;
    else if (!c.hour.has(p.hour)) t += (60 - p.minute) * 60000;
    else t += 60000;
  }
  return null;
}

function describeCron(expr) {
  const f = String(expr || '').trim().split(/\s+/);
  if (f.length !== 5) return expr;
  const [mi, h, dom, mon, dow] = f;
  const time = /^\d+$/.test(mi) && /^\d+$/.test(h) ? `${h.padStart(2, '0')}:${mi.padStart(2, '0')}` : null;
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  if (dom === '*' && mon === '*') {
    const every = /^\*\/(\d+)$/.exec(mi);
    if (every && h === '*' && dow === '*') return `Every ${every[1]} minutes`;
    if (/^\d+$/.test(mi) && h === '*' && dow === '*') return mi === '0' ? 'Every hour' : `Every hour at :${mi.padStart(2, '0')}`;
    const everyH = /^\*\/(\d+)$/.exec(h);
    if (everyH && /^\d+$/.test(mi) && dow === '*') return `Every ${everyH[1]} hours`;
    if (time && dow === '*') return `Every day at ${time}`;
    if (time && dow === '1-5') return `Weekdays at ${time}`;
    if (time && /^[0-7](,[0-7])*$/.test(dow)) return `${dow.split(',').map((d) => DAYS[+d]).join(', ')} at ${time}`;
  }
  if (time && /^\d+$/.test(dom) && mon === '*' && dow === '*') return `Day ${dom} of every month at ${time}`;
  return `cron ${expr}`;
}

// ── store ───────────────────────────────────────────────────────────────────

function filePath() { return path.join(store.stateDir(), 'automations.json'); }
function load() { try { const l = JSON.parse(fs.readFileSync(filePath(), 'utf8')); return Array.isArray(l) ? l : []; } catch { return []; } }
function save(list) {
  try {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    const tmp = `${filePath()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, filePath());
  } catch {}
}

class AutomationError extends Error {}

// A recorded spec: surface, steps with semantic targets, inputs. Kept small
// and explicit so a malformed one is rejected at save time instead of failing
// halfway through a run.
function cleanPlayback(spec) {
  if (!spec || typeof spec !== 'object') return null;
  const surface = spec.surface === 'browser' ? 'browser' : spec.surface === 'desktop' ? 'desktop' : null;
  if (!surface) throw new AutomationError('A recorded automation needs a surface: browser or desktop.');
  const steps = (Array.isArray(spec.steps) ? spec.steps : []).map((s, i) => ({
    index: i + 1,
    surface,
    action: String((s && s.action) || 'manual'),
    target: s && s.target ? String(s.target).slice(0, 200) : null,
    name: s && s.name ? String(s.name).slice(0, 200) : null,
    role: s && s.role ? String(s.role).slice(0, 40) : null,
    value: s && s.value != null ? String(s.value).slice(0, 2000) : null,
    key: s && s.key ? String(s.key).slice(0, 40) : null,
    input: s && s.input ? String(s.input).slice(0, 60) : null,
    selector: s && s.selector ? String(s.selector).slice(0, 400) : null,
    expected: s && s.expected ? String(s.expected).slice(0, 300) : null,
    evidence: Array.isArray(s && s.evidence) ? s.evidence.slice(0, 6).map(String) : [],
  }));
  if (!steps.length) throw new AutomationError('A recorded automation needs at least one step.');
  if (steps.length > 80) throw new AutomationError('A recorded automation is limited to 80 steps.');
  return {
    kind: 'automation',
    version: 1,
    surface,
    url: spec.url ? String(spec.url).slice(0, 2000) : null,
    app: spec.app ? String(spec.app).slice(0, 120) : null,
    goal: spec.goal ? String(spec.goal).slice(0, 200) : null,
    inputs: (Array.isArray(spec.inputs) ? spec.inputs : []).slice(0, 20).map((i, n) => ({
      name: String((i && i.name) || `value_${n + 1}`).replace(/[^a-z0-9_]/gi, '_').slice(0, 60),
      label: i && i.label ? String(i.label).slice(0, 60) : null,
      example: i && i.example != null ? String(i.example).slice(0, 2000) : null,
    })),
    steps,
    recordedAt: spec.recordedAt || spec.createdAt || new Date().toISOString(),
  };
}

function normalize(patch, base) {
  const a = { ...base };
  if (typeof patch.name === 'string' && patch.name.trim()) a.name = patch.name.trim().slice(0, 80);
  if (typeof patch.description === 'string') a.description = patch.description.trim().slice(0, 300);
  if (Array.isArray(patch.steps)) {
    a.steps = patch.steps.map((s) => (typeof s === 'string' ? { title: '', prompt: s } : s))
      .map((s) => ({ title: String(s.title || '').trim().slice(0, 80), prompt: String(s.prompt || '').trim().slice(0, 6000) }))
      .filter((s) => s.prompt).slice(0, MAX_STEPS);
  }
  if ('playback' in patch) a.playback = cleanPlayback(patch.playback);
  // A recorded automation carries its own steps; the prompt list is only the
  // readable form of them, so derive it when the caller sent none.
  if ((!a.steps || !a.steps.length) && a.playback) {
    const { describeStep } = require('../services/automation');
    a.steps = a.playback.steps.map((s) => ({ title: describeStep(s).slice(0, 80), prompt: describeStep(s) }));
  }
  if (patch.trigger && typeof patch.trigger === 'object') {
    const t = patch.trigger;
    if (t.type === 'schedule') {
      try { parseCron(t.cron); } catch (e) { throw new AutomationError(`Invalid schedule: ${e.message}`); }
      const timezone = t.timezone && validTimeZone(t.timezone) ? t.timezone : (a.trigger && a.trigger.timezone) || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      a.trigger = { type: 'schedule', cron: String(t.cron).trim().replace(/\s+/g, ' '), timezone };
    } else if (t.type === 'webhook') {
      a.trigger = { type: 'webhook', secret: (a.trigger && a.trigger.secret) || crypto.randomBytes(18).toString('base64url') };
    } else {
      a.trigger = { type: 'manual' };
    }
  }
  if (typeof patch.enabled === 'boolean') a.enabled = patch.enabled;
  if (['auto', 'ask', 'full'].includes(patch.approval)) a.approval = patch.approval;
  if ('workspace' in patch) a.workspace = patch.workspace ? String(patch.workspace) : null;
  if ('projectId' in patch) a.projectId = patch.projectId ? String(patch.projectId) : null;
  if (!a.steps || !a.steps.length) throw new AutomationError('An automation needs at least one step.');
  return a;
}

// ctx: { chat, getWorkspace, broadcast, projects }
function createAutomations(ctx) {
  let list = load();
  const running = new Map(); // automation id → run id
  let timer = null;

  const view = (a) => ({
    ...a,
    trigger: a.trigger.type === 'webhook' ? { type: 'webhook' } : a.trigger, // secret only via webhookPath()
    schedule: a.trigger.type === 'schedule' ? describeCron(a.trigger.cron) : null,
    nextRunAt: a.enabled && a.trigger.type === 'schedule' ? a.nextRunAt || null : null,
    running: running.has(a.id),
  });
  const changed = () => { save(list); ctx.broadcast({ t: 'automations.changed' }); };
  const find = (id) => list.find((a) => a.id === id) || null;
  const reschedule = (a, from = Date.now()) => {
    a.nextRunAt = a.enabled && a.trigger.type === 'schedule' ? nextRun(a.trigger.cron, from, a.trigger.timezone) : null;
  };

  function create(patch) {
    const now = Date.now();
    const a = normalize({ trigger: { type: 'manual' }, ...patch }, {
      id: store.newId('a'), name: 'Untitled automation', description: '', steps: [], trigger: { type: 'manual' }, enabled: true,
      approval: 'auto', workspace: null, projectId: null, createdAt: now, updatedAt: now, runs: [], nextRunAt: null,
    });
    reschedule(a);
    list.push(a);
    changed();
    return view(a);
  }

  function update(id, patch) {
    const i = list.findIndex((a) => a.id === id);
    if (i === -1) return null;
    const a = normalize(patch, list[i]);
    a.updatedAt = Date.now();
    reschedule(a);
    list[i] = a;
    changed();
    return view(a);
  }

  function remove(id) {
    const before = list.length;
    list = list.filter((a) => a.id !== id);
    if (list.length !== before) changed();
    return list.length !== before;
  }

  // Run every step in order inside one fresh Cowork conversation.
  //
  // A recorded automation (one saved from a screen recording) replays through
  // the replay engine instead: the steps are deterministic actions with
  // semantic targets, so replaying them is both faster and repeatable. Steps
  // typed as prompts are unchanged, and stay with the agent.
  async function run(id, { trigger = 'manual', payload = null, values = null } = {}) {
    const a = find(id);
    if (!a) throw new AutomationError('automation not found');
    if (running.has(id)) throw new AutomationError('this automation is already running');
    if (a.playback && Array.isArray(a.playback.steps) && a.playback.steps.length) {
      return runPlayback(a, { trigger, payload, values });
    }
    const started = Date.now();
    const project = a.projectId && ctx.projects ? ctx.projects.get(a.projectId) : null;
    const conv = ctx.chat.create({
      title: `${a.name} · ${new Date(started).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}`,
      mode: 'cowork', workspace: a.workspace || (project && project.workspace) || undefined, projectId: project ? project.id : null, automationId: a.id,
    });
    const rec = { id: store.newId('r'), at: started, trigger, status: 'running', convId: conv.id, durationMs: 0, summary: '', step: 0, steps: a.steps.length };
    a.runs = [rec, ...(a.runs || [])].slice(0, MAX_RUNS);
    running.set(id, rec.id);
    changed();

    const finish = (status, summary) => {
      rec.status = status; rec.summary = String(summary || '').replace(/\s+/g, ' ').slice(0, 280); rec.durationMs = Date.now() - started;
      running.delete(id);
      a.lastRunAt = started; a.lastStatus = status;
      changed();
      ctx.broadcast({ t: 'automation.finished', id: a.id, name: a.name, status, convId: conv.id });
    };

    (async () => {
      try {
        for (let i = 0; i < a.steps.length; i++) {
          rec.step = i + 1;
          changed();
          const s = a.steps[i];
          let prompt = a.steps.length > 1 ? `[Automation “${a.name}” — step ${i + 1} of ${a.steps.length}${s.title ? `: ${s.title}` : ''}]\n${s.prompt}` : s.prompt;
          if (i === 0 && payload) prompt += `\n\n[Webhook payload]\n${String(payload).slice(0, 16000)}`;
          const outcome = await ctx.chat.sendAndWait(conv.id, prompt, { unattended: a.approval, askTimeoutMs: ASK_TIMEOUT_MS });
          if (outcome.status !== 'ok') return finish(outcome.status, outcome.error || outcome.summary || `stopped at step ${i + 1}`);
          if (i === a.steps.length - 1) return finish('ok', outcome.summary);
        }
      } catch (e) {
        finish('error', e.message);
      }
    })();
    return { runId: rec.id, convId: conv.id };
  }

  // Flatten a webhook body into replay values: {"email": "a@b"} feeds the
  // input named "email", so one webhook can drive the recording over many
  // items. Explicit values win over the payload.
  function valuesFor(a, { payload, values }) {
    const out = {};
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      for (const [k, v] of Object.entries(payload)) if (v != null && typeof v !== 'object') out[k] = String(v);
    }
    if (values && typeof values === 'object') for (const [k, v] of Object.entries(values)) if (v != null) out[k] = String(v);
    return out;
  }

  // Replay a recorded spec. No conversation: the actions are not a prompt, and
  // the run record holds exactly what happened step by step.
  function runPlayback(a, { trigger, payload, values }) {
    const { replay, runArtifactDir } = require('../services/automation-replay');
    const started = Date.now();
    const vals = valuesFor(a, { payload, values });
    const rec = {
      id: store.newId('r'), at: started, trigger, status: 'running', durationMs: 0, summary: '',
      step: 0, steps: a.playback.steps.length, values: vals, via: a.playback.surface, results: [], artifacts: [],
    };
    a.runs = [rec, ...(a.runs || [])].slice(0, MAX_RUNS);
    running.set(a.id, rec.id);
    changed();

    const finish = (status, summary) => {
      rec.status = status;
      rec.summary = String(summary || '').replace(/\s+/g, ' ').slice(0, 280);
      rec.durationMs = Date.now() - started;
      running.delete(a.id);
      a.lastRunAt = started; a.lastStatus = status;
      changed();
      ctx.broadcast({ t: 'automation.finished', id: a.id, name: a.name, status, runId: rec.id });
    };

    const dir = runArtifactDir(rec.id);
    (async () => {
      try {
        const result = await replay(a.playback, {
          values: vals,
          mcp: ctx.getMcp ? ctx.getMcp() : null,
          artifacts: dir,
          onStep: (e) => {
            rec.step = e.index;
            rec.results.push({ index: e.index, action: e.action, note: e.note, ok: e.ok, error: e.error, ms: e.ms, via: e.via });
            if (e.artifact) rec.artifacts.push(e.artifact);
            changed();
            ctx.broadcast({ t: 'automation.progress', id: a.id, runId: rec.id, step: e.index, total: rec.steps, note: e.note, ok: e.ok });
          },
        });
        rec.error = result.error || null;
        rec.stoppedAt = result.stoppedAt || null;
        rec.ok = result.steps.filter((s) => s.ok).length;
        const done = result.steps.filter((s) => s.ok).length;
        finish(result.ok ? 'ok' : 'error', result.ok ? `${done} of ${rec.steps} steps replayed` : `stopped at step ${result.stoppedAt || '?'}: ${result.error || 'failed'}`);
      } catch (e) {
        finish('error', e.message);
      }
    })();
    return { runId: rec.id, convId: null };
  }

  // Try a spec without saving it, so the review UI can prove a recording
  // replays before it becomes an automation.
  async function testPlayback(spec, { values = null } = {}) {
    const clean = cleanPlayback(spec);
    const { replay } = require('../services/automation-replay');
    const id = store.newId('t');
    return replay(clean, { values: values || {}, mcp: ctx.getMcp ? ctx.getMcp() : null, artifacts: require('../services/automation-replay').runArtifactDir(id) });
  }

  function tick(now = Date.now()) {    for (const a of list) {
      if (!a.enabled || a.trigger.type !== 'schedule') continue;
      if (!a.nextRunAt) { reschedule(a, now); continue; }
      if (a.nextRunAt > now) continue;
      reschedule(a, now); // schedule the following run first, so a slow run can't double-fire
      if (running.has(a.id)) continue;
      run(a.id, { trigger: 'schedule' }).catch(() => {});
    }
  }

  return {
    list: () => list.slice().sort((a, b) => b.updatedAt - a.updatedAt).map(view),
    get: (id) => { const a = find(id); return a ? view(a) : null; },
    create, update, remove, run, tick, testPlayback,
    webhookPath(id) { const a = find(id); return a && a.trigger.type === 'webhook' ? `/hooks/${a.id}/${a.trigger.secret}` : null; },
    // Webhook entry: constant-time secret check; disabled automations ignore calls.
    async trigger(id, secret, payload) {
      const a = find(id);
      if (!a || a.trigger.type !== 'webhook') return { status: 404 };
      const x = Buffer.from(String(secret || '')); const y = Buffer.from(a.trigger.secret);
      if (x.length !== y.length || !crypto.timingSafeEqual(x, y)) return { status: 404 };
      if (!a.enabled) return { status: 409, error: 'automation is disabled' };
      if (running.has(id)) return { status: 409, error: 'already running' };
      const r = await run(id, { trigger: 'webhook', payload });
      return { status: 202, ...r };
    },
    start() {
      // Runs missed while the server was down are not replayed; pick up from now.
      for (const a of list) { reschedule(a); for (const r of a.runs || []) if (r.status === 'running') r.status = 'interrupted'; }
      save(list);
      timer = setInterval(() => { try { tick(); } catch {} }, 20000);
      timer.unref();
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
}

// Tools that let the Cowork assistant manage automations from the chat. They
// ride on the MCP tool interface, so the agent core needs no changes.
function coworkTools(base, automations, { projectId = null, workspace = null } = {}) {
  const P = 'mcp__cowork__';
  const defs = [
    { name: 'list_automations', description: 'List saved automations with their schedule, status and last run.', parameters: { type: 'object', properties: {} } },
    { name: 'create_automation', description: 'Save a task to run later: on a schedule (5-field cron), by webhook, or by hand. Use when the user wants something done regularly or automatically.',
      parameters: { type: 'object', required: ['name', 'steps'], properties: {
        name: { type: 'string' }, description: { type: 'string' },
        steps: { type: 'array', items: { type: 'string' }, description: 'Ordered instructions; each is a self-contained prompt for an agent run.' },
        cron: { type: 'string', description: 'Cron schedule like "0 9 * * 1-5". Omit for a manual automation.' },
        timezone: { type: 'string', description: 'IANA time zone for the schedule, e.g. Europe/Stockholm.' },
        webhook: { type: 'boolean', description: 'Trigger by HTTP webhook instead of a schedule.' },
      } } },
    { name: 'update_automation', description: 'Change an automation: enable/disable it, rename it, or replace its steps or schedule.',
      parameters: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, name: { type: 'string' }, enabled: { type: 'boolean' }, steps: { type: 'array', items: { type: 'string' } }, cron: { type: 'string' }, timezone: { type: 'string' } } } },
    { name: 'run_automation', description: 'Start an automation now.', parameters: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
    { name: 'delete_automation', description: 'Delete an automation permanently.', parameters: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  ];
  const brief = (a) => ({ id: a.id, name: a.name, enabled: a.enabled, trigger: a.trigger.type, schedule: a.schedule, timezone: a.trigger.timezone, next_run: a.nextRunAt ? new Date(a.nextRunAt).toISOString() : null, last_status: a.lastStatus || null, steps: a.steps.length });
  const triggerOf = (args) => (args.cron ? { type: 'schedule', cron: args.cron, timezone: args.timezone } : args.webhook ? { type: 'webhook' } : undefined);

  return {
    getToolDefinitions: () => [
      ...(base ? base.getToolDefinitions() : []),
      ...defs.map((d) => ({ type: 'function', function: { name: P + d.name, description: d.description, parameters: d.parameters } })),
    ],
    classifyTool: (name) => (name.startsWith(P) ? (name === `${P}list_automations` ? 'safe' : name === `${P}delete_automation` ? 'unsafe' : 'uncertain') : base ? base.classifyTool(name) : 'uncertain'),
    describeTool: (name, args) => {
      if (!name.startsWith(P)) return base ? base.describeTool(name, args) : name;
      const n = name.slice(P.length);
      if (n === 'create_automation') return `create automation “${args.name}”${args.cron ? ` — ${describeCron(args.cron)}` : args.webhook ? ' — webhook' : ' — manual'} (${(args.steps || []).length} step${(args.steps || []).length === 1 ? '' : 's'})`;
      return `${n.replace(/_/g, ' ')}${args.id ? ` ${args.id}` : ''}`;
    },
    async dispatchTool(name, args, signal) {
      if (!name.startsWith(P)) return base ? base.dispatchTool(name, args, signal) : { error: `unknown tool: ${name}` };
      try {
        switch (name.slice(P.length)) {
          case 'list_automations': return { automations: automations.list().map(brief) };
          case 'create_automation': {
            const a = automations.create({ name: args.name, description: args.description, steps: args.steps, trigger: triggerOf(args), projectId, workspace });
            return { ok: true, automation: brief(a), webhook_path: automations.webhookPath(a.id) || undefined };
          }
          case 'update_automation': {
            const patch = {};
            for (const k of ['name', 'enabled', 'steps']) if (args[k] !== undefined) patch[k] = args[k];
            if (args.cron) patch.trigger = triggerOf(args);
            const a = automations.update(args.id, patch);
            return a ? { ok: true, automation: brief(a) } : { error: 'automation not found' };
          }
          case 'run_automation': return { ok: true, ...(await automations.run(args.id)) };
          case 'delete_automation': return automations.remove(args.id) ? { ok: true } : { error: 'automation not found' };
          default: return { error: `unknown tool: ${name}` };
        }
      } catch (e) { return { error: e.message }; }
    },
  };
}

const COWORK_HINT = `
Mode: Cowork — you are a capable colleague who gets work done and can set work up to happen on its own.
- Do the task with your tools, then report what you did in plain language: outcome first, details after.
- When the user wants something to happen regularly, later, or in response to an event, create an automation with create_automation instead of only doing it once. Write each step as a complete, self-contained instruction — a future run will not see this conversation.
- Confirm schedules back in words ("weekdays at 09:00, Europe/Stockholm"). Use list_automations before changing or deleting one.
- Prefer several small, verifiable steps over one sprawling instruction.`;

module.exports = { createAutomations, coworkTools, parseCron, nextRun, describeCron, AutomationError, COWORK_HINT };

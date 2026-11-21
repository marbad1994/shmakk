// Plans: review-gated task execution for the web UI.
//
// The old plan-first path marked a task "completed" the moment the agent
// returned, wrote it to TASKS.md as done, and only reviewed the whole plan at
// the end, and then only commits (so uncommitted work, the normal case, was
// never reviewed at all). Here a task can only become done by passing review:
//
//   todo ──run──▶ running ──▶ reviewing ──pass──▶ awaiting_approval ──you──▶ done
//                   ▲             │                 (or done directly when
//                   │            fail                sign-off is turned off)
//                   └── rework ◀──┘   after MAX_ATTEMPTS fails ─▶ blocked
//
//   awaiting_approval / done / blocked ──request changes──▶ rework (with your note)
//
// • The diff a task is reviewed on is measured, not trusted: a git tree is
//   snapshotted (via a temporary index, so the user's index is untouched)
//   before and after the agent runs, and the reviewer sees exactly that diff,
//   uncommitted edits included. Outside git the session edit log is used.
// • The reviewer returns a structured verdict. A "pass" with an unmet
//   acceptance criterion or a critical/major issue is overridden to "fail" in
//   code: the model cannot wave a task through.
// • Tasks can depend on others; a dependency is satisfied once it has passed
//   automated review, so the runner does not stall waiting on a human.
//
// Plans live in <workspace>/.shmakk/plans/<id>.json, assets (screenshots,
// per-attempt diffs) in <workspace>/.shmakk/plans/<id>/.
//
// Why files and not a sqlite table: a plan has to travel with the workspace it
// describes. The CLI runner reads and writes the same files, bundles export
// them, and plans move between machines with the repo. shmakk's only database
// (src/session-search.js) is a global, derived search index — putting the
// authoritative plan record there would make plans unportable and split the
// source of truth between the web UI and the CLI. So the store is the file set:
// the record schema below is the table definition, the file name is the primary
// key, and migratePlans() is the migration.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const MAX_ATTEMPTS = 3;
// Plan record schema. There is no SQL table for plans: a plan is one JSON file
// in <workspace>/.shmakk/plans/ and the file name is its primary key.
// Bump SCHEMA_VERSION when the record shape changes, and migratePlans() will
// upgrade older files in place the next time the store is opened.
const SCHEMA_VERSION = 2;
const PLAN_STATUSES = ['draft', 'running', 'queued', 'paused', 'awaiting_review', 'needs_attention', 'done'];
// The table definition. Equivalent DDL:
//   CREATE TABLE plans (
//     id            TEXT PRIMARY KEY,   -- the file name, <workspace>/.shmakk/plans/<id>.json
//     title         TEXT NOT NULL,
//     owner         TEXT NOT NULL,      -- no accounts: $SHMAKK_OWNER, else the OS user
//     status        TEXT NOT NULL,
//     createdAt     INTEGER NOT NULL,   -- epoch ms
//     updatedAt     INTEGER NOT NULL,   -- epoch ms, bumped on write
//     schemaVersion INTEGER NOT NULL
//   );
// validatePlan() enforces exactly this on every read and write, newPlan() is the
// INSERT, normalizePlan()+migratePlans() are the migration, and the file name is
// the primary key.
const PLAN_SCHEMA = {
  table: 'plans',
  primaryKey: 'id',
  columns: {
    id: { type: 'text', nullable: false, primaryKey: true },
    title: { type: 'text', nullable: false },
    owner: { type: 'text', nullable: false },
    status: { type: 'text', nullable: false },
    createdAt: { type: 'integer', nullable: false },
    updatedAt: { type: 'integer', nullable: false },
    schemaVersion: { type: 'integer', nullable: false },
  },
};
const REQUIRED_FIELDS = Object.entries(PLAN_SCHEMA.columns).filter(([, c]) => !c.nullable).map(([name]) => name);
const MAX_DIFF_FOR_REVIEW = 60 * 1024;
const MAX_DIFF_STORED = 400 * 1024;

const TASK_STATUSES = ['todo', 'running', 'reviewing', 'rework', 'awaiting_approval', 'done', 'blocked', 'skipped'];
const LAYERS = ['database', 'backend', 'frontend', 'infra', 'tests', 'unknown'];
const KINDS = ['bug', 'change', 'feature', 'chore'];

// ── store ───────────────────────────────────────────────────────────────────

function plansDir(root) { return path.join(path.resolve(root), '.shmakk', 'plans'); }
function planFile(root, id) { return path.join(plansDir(root), `${id}.json`); }
function assetsDir(root, id) { return path.join(plansDir(root), id); }
function newId(prefix) { return `${prefix}${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`; }
const validId = (id) => /^[a-z0-9_-]{4,64}$/i.test(String(id || ''));

/** Who a plan belongs to. shmakk has no accounts: env override, else the OS user. */
function defaultOwner() {
  if (process.env.SHMAKK_OWNER) return str(process.env.SHMAKK_OWNER, 120) || 'local';
  try { return str(os.userInfo().username, 120) || 'local'; } catch { return 'local'; }
}

/**
 * A new plan record in the current schema. Both create paths (the web UI's plan
 * manager and the CLI runner) go through this, so every row that gets written
 * carries the same required fields.
 */
function newPlan({
  title = '', summary = '', source = 'manual', origin = null, workspace = '',
  tasks = [], requireSignoff = true, convId = null, owner = null,
} = {}) {
  const now = Date.now();
  const list = Array.isArray(tasks) ? tasks : [];
  return {
    schemaVersion: SCHEMA_VERSION,
    id: newId('p'),
    title: str(title, 160) || str(list[0] && list[0].title, 160) || 'Untitled plan',
    summary: str(summary, 2000),
    owner: str(owner, 120) || defaultOwner(),
    source: str(source, 40) || 'manual',
    origin: origin && typeof origin === 'object' ? origin : null,
    workspace: workspace ? path.resolve(workspace) : '',
    requireSignoff: requireSignoff !== false,
    status: 'draft',
    started: false,
    paused: false,
    convId: convId || null,
    createdAt: now,
    updatedAt: now,
    tasks: list,
  };
}

/**
 * Coerce a stored record to the current schema. Pure: it never writes, so
 * reading an old file still yields a complete plan. `changed` reports that the
 * on-disk copy is behind the schema (i.e. migratePlans should rewrite it).
 */
function normalizePlan(raw, id = null, root = null) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const tasks = (Array.isArray(src.tasks) ? src.tasks : []).filter((t) => t && typeof t === 'object');
  const createdAt = Number.isFinite(src.createdAt) ? src.createdAt : Date.now();
  const plan = {
    ...src,
    schemaVersion: SCHEMA_VERSION,
    // The file name is the primary key, so an explicit id wins over the payload.
    id: validId(id) ? String(id) : validId(src.id) ? String(src.id) : null,
    title: str(src.title, 160) || str(tasks[0] && tasks[0].title, 160) || 'Untitled plan',
    owner: str(src.owner, 120) || defaultOwner(),
    status: PLAN_STATUSES.includes(src.status) ? src.status : 'draft',
    summary: str(src.summary, 2000),
    source: str(src.source, 40) || 'manual',
    workspace: str(src.workspace, 1000) || (root ? path.resolve(root) : null),
    requireSignoff: src.requireSignoff !== false,
    started: src.started === true,
    paused: src.paused === true,
    createdAt,
    updatedAt: Number.isFinite(src.updatedAt) ? src.updatedAt : createdAt,
    tasks,
  };
  const changed = Number(src.schemaVersion || 0) < SCHEMA_VERSION
    || !validId(src.id)
    || (validId(id) && String(src.id) !== String(id))
    || !str(src.title, 160)
    || !str(src.owner, 120)
    || !PLAN_STATUSES.includes(src.status)
    || !Number.isFinite(src.createdAt)
    || !Number.isFinite(src.updatedAt);
  return { plan, changed };
}

/** Required fields must be present and not null; there are no columns to enforce it. */
/**
 * The NOT NULL half of PLAN_SCHEMA, checked on every read and write. An empty
 * string counts as missing: '' is not a value a plan column may hold.
 */
function validatePlan(plan) {
  const problems = [];
  if (plan == null || typeof plan !== 'object') problems.push('record is not an object');
  else {
    for (const [col, spec] of Object.entries(PLAN_SCHEMA.columns)) {
      const v = plan[col];
      if (v === undefined || v === null || v === '') {
        if (!spec.nullable) problems.push(`${col} is required`);
        continue;
      }
      if (spec.type === 'integer' && !Number.isFinite(v)) problems.push(`${col} must be an integer`);
      if (spec.type === 'text' && typeof v !== 'string') problems.push(`${col} must be text`);
    }
  }
  if (problems.length) {
    const e = new Error(`plan violates the ${PLAN_SCHEMA.table} schema: ${problems.join(', ')}`);
    e.status = 500;
    throw e;
  }
  return plan;
}

// ── create-request validation ──────────────────────────────────────────────

const MAX_TASKS_PER_PLAN = 50;
// Known sources, for the comment and for callers' benefit. Only the shape is
// enforced: adding a source must not require editing a whitelist here.
const KNOWN_SOURCES = ['manual', 'chat', 'browser', 'show2plan', 'cli', 'automation'];

const badRequest = (message) => {
  const e = new Error(message);
  e.status = 400;
  return e;
};

/**
 * Validate a create-plan request from the HTTP boundary. Pure: it reads nothing
 * and writes nothing, so a rejected request cannot leave a plan behind.
 * Throws a 400 naming the bad field, and returns the normalized payload
 * create() takes: { title, summary, source, tasks, requireSignoff, origin }.
 *
 * create() stays lenient on purpose: in-process callers (chat, the CLI runner)
 * pass model-generated tasks that makeTask() coerces. The row-level invariants
 * are enforced on every write by validatePlan(), so a coerced task still lands
 * with a title.
 */
function validateCreate(payload) {
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw badRequest('expected a JSON object');
  }
  const title = typeof payload.title === 'string' ? payload.title.trim() : '';
  if (!title) throw badRequest('title is required');
  if (title.length > 200) throw badRequest('title must be 200 characters or fewer');

  if (payload.summary != null && typeof payload.summary !== 'string') throw badRequest('summary must be a string');
  if (typeof payload.summary === 'string' && payload.summary.length > 4000) throw badRequest('summary must be 4000 characters or fewer');

  if (payload.source != null && (typeof payload.source !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(payload.source))) {
    throw badRequest(`source must be a short lowercase token (${KNOWN_SOURCES.join(', ')})`);
  }
  if (payload.requireSignoff != null && typeof payload.requireSignoff !== 'boolean') throw badRequest('requireSignoff must be true or false');
  if (payload.origin != null && (typeof payload.origin !== 'object' || Array.isArray(payload.origin))) throw badRequest('origin must be an object');

  const tasks = payload.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) throw badRequest('tasks must be a non-empty array');
  if (tasks.length > MAX_TASKS_PER_PLAN) throw badRequest(`tasks must be ${MAX_TASKS_PER_PLAN} items or fewer`);
  tasks.forEach((t, i) => {
    if (t == null || typeof t !== 'object' || Array.isArray(t)) throw badRequest(`tasks[${i}] must be an object`);
    if (typeof t.title !== 'string' || !t.title.trim()) throw badRequest(`tasks[${i}].title is required`);
    if (t.title.trim().length > 200) throw badRequest(`tasks[${i}].title must be 200 characters or fewer`);
    if (t.acceptance != null && !Array.isArray(t.acceptance)) throw badRequest(`tasks[${i}].acceptance must be an array`);
  });

  return {
    title,
    summary: typeof payload.summary === 'string' ? payload.summary : '',
    source: payload.source || 'manual',
    tasks,
    requireSignoff: payload.requireSignoff !== false,
    origin: payload.origin || null,
  };
}

function readPlan(root, id) {
  if (!validId(id)) return null;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(planFile(root, id), 'utf8')); } catch { return null; }
  return validatePlan(normalizePlan(raw, id, root).plan);
}

/**
 * Upsert by primary key (plan.id). `touch: false` keeps updatedAt as it is,
 * which the migration needs so upgrading a file does not reshuffle the list.
 */
function writePlan(root, plan, { touch = true } = {}) {
  fs.mkdirSync(plansDir(root), { recursive: true });
  plan.workspace = plan.workspace || path.resolve(root);
  plan.schemaVersion = SCHEMA_VERSION;
  if (touch) plan.updatedAt = Date.now();
  validatePlan(plan);
  const tmp = `${planFile(root, plan.id)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(plan, null, 2));
  fs.renameSync(tmp, planFile(root, plan.id));
  return plan;
}

/**
 * Upgrade every plan file under <root>/.shmakk/plans to the current schema:
 * fills in the required fields that older versions did not write (owner,
 * schemaVersion) and takes the primary key from the file name. Idempotent: a
 * second run migrates 0. Unparseable files are counted and left untouched.
 */
function migratePlans(root) {
  const dir = plansDir(root);
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return { scanned: 0, migrated: 0, corrupt: 0 }; }
  const out = { scanned: names.length, migrated: 0, corrupt: 0 };
  for (const name of names) {
    const id = name.slice(0, -5);
    if (!validId(id)) continue;
    let raw;
    try { raw = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { out.corrupt++; continue; }
    const { plan, changed } = normalizePlan(raw, id, root);
    if (!changed) continue;
    try { writePlan(root, plan, { touch: false }); out.migrated++; } catch { out.corrupt++; }
  }
  return out;
}

function listPlans(root) {
  let names = [];
  try { names = fs.readdirSync(plansDir(root)).filter((n) => n.endsWith('.json')); } catch {}
  return names.map((n) => readPlan(root, n.slice(0, -5))).filter(Boolean).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

// ── task shape ──────────────────────────────────────────────────────────────

function str(v, max = 4000) { return v == null ? '' : String(v).trim().slice(0, max); }

function makeTask(t, i) {
  const now = Date.now();
  const files = (Array.isArray(t.files) ? t.files : []).map((f) => (typeof f === 'string' ? { path: f } : f)).filter((f) => f && f.path)
    .map((f) => ({ path: str(f.path, 300), why: str(f.why, 200) || null })).slice(0, 10);
  const ev = t.evidence && typeof t.evidence === 'object' ? t.evidence : {};
  return {
    id: str(t.id, 40) && validId(t.id) ? String(t.id) : newId('t'),
    key: str(t.key, 20) || `t${i + 1}`,
    title: str(t.title, 160) || `Task ${i + 1}`,
    kind: KINDS.includes(t.kind) ? t.kind : 'change',
    layer: LAYERS.includes(t.layer) ? t.layer : 'unknown',
    priority: ['high', 'normal', 'low'].includes(t.priority) ? t.priority : 'normal',
    instructions: str(t.instructions || t.description, 12000),
    acceptance: (Array.isArray(t.acceptance) ? t.acceptance : []).map((a) => str(a, 400)).filter(Boolean).slice(0, 10),
    files,
    dependsOn: (Array.isArray(t.dependsOn) ? t.dependsOn : []).map((d) => str(d, 40)).filter(Boolean),
    questions: (Array.isArray(t.questions) ? t.questions : []).map((q) => str(q, 400)).filter(Boolean),
    evidence: {
      frames: (Array.isArray(ev.frames) ? ev.frames : []).map((f) => path.basename(str(f, 160))).filter((f) => /^[\w.-]+\.(png|jpe?g|webp)$/i.test(f)).slice(0, 6),
      quote: str(ev.quote, 1000) || null,
      page: str(ev.page, 400) || null,
      element: str(ev.element, 400) || null,
      selector: str(ev.selector, 400) || null,
      source: str(ev.source, 400) || null,
      url: str(ev.url, 500) || null,
    },
    status: 'todo',
    attempts: 0,
    roundAttempts: 0,
    feedback: [],
    reviews: [],
    report: null,
    noChanges: false,
    startedAt: null,
    finishedAt: null,
    approvedAt: null,
    createdAt: now,
    history: [{ at: now, status: 'todo', note: 'created' }],
  };
}

/** Resolve dependsOn entries given as task keys into task ids. */
function linkDependencies(tasks) {
  const byKey = new Map(tasks.map((t) => [t.key, t.id]));
  const ids = new Set(tasks.map((t) => t.id));
  for (const t of tasks) {
    t.dependsOn = [...new Set(t.dependsOn.map((d) => (ids.has(d) ? d : byKey.get(d))).filter((d) => d && d !== t.id))];
  }
  return tasks;
}

function setStatus(task, status, note = null) {
  if (!TASK_STATUSES.includes(status)) throw new Error(`unknown task status ${status}`);
  task.status = status;
  task.history = [...(task.history || []), { at: Date.now(), status, note }].slice(-60);
  return task;
}

// ── lifecycle rules (pure) ──────────────────────────────────────────────────

/** A dependency counts as met once it has passed automated review. */
function depsMet(plan, task) {
  return task.dependsOn.every((id) => {
    const d = plan.tasks.find((t) => t.id === id);
    return !d || d.status === 'done' || d.status === 'skipped' || d.status === 'awaiting_approval';
  });
}

/** Next task the runner may start, or null. Rework first, then plan order. */
function nextRunnable(plan) {
  const ready = plan.tasks.filter((t) => (t.status === 'todo' || t.status === 'rework') && depsMet(plan, t));
  return ready.find((t) => t.status === 'rework') || ready[0] || null;
}

/**
 * Plan status, derived from its tasks, whether it was ever started, whether
 * the person paused it, and whether the runner is active right now:
 * draft · running · queued · paused · awaiting_review · needs_attention · done
 */
function derivePlanStatus(plan, { running = false } = {}) {
  const tasks = plan.tasks || [];
  if (!plan.started || !tasks.length) return 'draft';
  if (running) return 'running';
  if (tasks.every((t) => t.status === 'done' || t.status === 'skipped')) return 'done';
  if (tasks.some((t) => t.status === 'blocked')) return 'needs_attention';
  const runnable = !!nextRunnable(plan);
  if (runnable) return plan.paused ? 'paused' : 'queued';
  if (tasks.some((t) => t.status === 'awaiting_approval')) return 'awaiting_review';
  // Tasks left whose dependencies can never be met.
  return 'needs_attention';
}

/**
 * Normalise a reviewer response and enforce the gate: any unmet criterion or a
 * critical/major issue makes it a fail, whatever the model said.
 */
function normalizeVerdict(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const criteria = (Array.isArray(r.criteria) ? r.criteria : []).map((c) => ({
    text: str(c && (c.text || c.criterion), 400),
    met: !!(c && (c.met === true || c.met === 'true' || c.status === 'met')),
    note: str(c && c.note, 600) || null,
  })).filter((c) => c.text);
  const issues = (Array.isArray(r.issues) ? r.issues : []).map((i) => ({
    severity: ['critical', 'major', 'minor'].includes(i && i.severity) ? i.severity : 'minor',
    file: str(i && i.file, 300) || null,
    detail: str(i && (i.detail || i.description || i.issue), 1200),
    fix: str(i && i.fix, 1200) || null,
  })).filter((i) => i.detail);
  const said = String(r.verdict || '').toLowerCase();
  const blocking = issues.some((i) => i.severity !== 'minor');
  const unmet = criteria.some((c) => !c.met);
  const pass = (said === 'pass' || said === 'approve' || said === 'approved') && !blocking && !unmet;
  let overridden = null;
  if ((said === 'pass' || said === 'approve' || said === 'approved') && !pass) overridden = unmet ? 'an acceptance criterion is not met' : 'a critical or major issue was found';
  return { verdict: pass ? 'pass' : 'fail', summary: str(r.summary, 1200), criteria, issues, overridden };
}

/**
 * Apply a review to a task. Returns the new status.
 * pass → awaiting_approval (or done without sign-off); fail → rework, or
 * blocked once the round has used MAX_ATTEMPTS attempts.
 */
function applyVerdict(task, verdict, { requireSignoff = true, maxAttempts = MAX_ATTEMPTS } = {}) {
  if (verdict.verdict === 'pass') {
    if (requireSignoff) setStatus(task, 'awaiting_approval', 'review passed');
    else { setStatus(task, 'done', 'review passed'); task.approvedAt = Date.now(); }
  } else if (task.roundAttempts >= maxAttempts) {
    setStatus(task, 'blocked', `review failed ${task.roundAttempts} times`);
  } else {
    setStatus(task, 'rework', 'review requested changes');
  }
  return task.status;
}

// ── measuring what a task changed ───────────────────────────────────────────

// Why the last snapshotTree returned null, for the runner's log. Null on success.
let lastSnapshotError = null;
function snapshotFailure() { return lastSnapshotError; }

/**
 * Files the agent itself wrote, as workspace-relative paths. The edit tracker is
 * the one source that attributes a change to the agent rather than to the person
 * working beside it, so an empty attempt diff can still be widened to the
 * agent's own files without dragging the person's uncommitted work into review.
 */
function editedFiles(root, edits) {
  const out = new Set();
  for (const e of edits || []) {
    const rel = path.relative(root, e && e.filePath ? e.filePath : '');
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) out.add(rel);
  }
  return [...out].sort();
}

function git(root, args, env) {
  return execFileSync('git', args, {
    cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...(env || {}) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// Paths the review snapshot leaves out: shmakk's own runtime state and the
// generated task list. They are not part of the work being reviewed.
const EXCLUDES = ['.shmakk', 'TASKS.md'];

/**
 * Tree id of the working tree as it is now (tracked + untracked, honouring
 * .gitignore), written through a throwaway index. Null outside git.
 *
 * The excluded paths cannot be filtered with `:(exclude)` pathspecs: git add
 * refuses a pathspec that names a path .gitignore already ignores ("The
 * following paths are ignored..."), which killed the snapshot in every repo
 * that gitignores .shmakk — including shmakk itself. So everything is added
 * first and the excluded paths are then forced back to their HEAD copy (or
 * dropped from the index when they are not tracked).
 */
function snapshotTree(root) {
  lastSnapshotError = null;
  try { git(root, ['rev-parse', '--is-inside-work-tree']); } catch (e) { lastSnapshotError = (e && e.message) || String(e); return null; }
  const idx = path.join(os.tmpdir(), `shmakk-plan-idx-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  try {
    const env = { GIT_INDEX_FILE: idx };
    let hasHead = true;
    try { git(root, ['read-tree', 'HEAD'], env); } catch { hasHead = false; /* no commits yet: empty index */ }
    git(root, ['add', '-A', '--', '.'], env);
    for (const p of EXCLUDES) {
      if (hasHead) {
        try { git(root, ['reset', '-q', 'HEAD', '--', p], env); continue; } catch { /* not tracked in HEAD */ }
      }
      try { git(root, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', p], env); } catch {}
    }
    return git(root, ['write-tree'], env).trim();
  } catch (e) {
    // A silent null here costs a whole review cycle: the reviewer is handed an
    // empty diff for work that exists. Keep the reason reachable.
    lastSnapshotError = (e && e.message) || String(e);
    return null;
  } finally {
    try { fs.rmSync(idx, { force: true }); } catch {}
  }
}

function diffTrees(root, a, b, paths) {
  if (!a || !b) return null;
  if (a === b) return { files: [], stat: '', patch: '', added: 0, removed: 0 };
  const only = paths && paths.length ? ['--', ...paths] : [];
  try {
    const numstat = git(root, ['diff', '--numstat', a, b, ...only]).trim();
    const files = numstat ? numstat.split('\n').map((l) => { const [ad, rm, ...p] = l.split('\t'); return { path: p.join('\t'), added: Number(ad) || 0, removed: Number(rm) || 0 }; }) : [];
    let patch = git(root, ['diff', '--no-color', '-M', a, b, ...only]);
    if (patch.length > MAX_DIFF_STORED) patch = `${patch.slice(0, MAX_DIFF_STORED)}\n\n[diff truncated]\n`;
    const stat = git(root, ['diff', '--stat', a, b, ...only]).trim();
    return { files, stat, patch, added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0) };
  } catch {
    return null;
  }
}

/**
 * Diff handed to the review gate.
 *
 * The task's change is cumulative: attempt 2 of a task must show the work of
 * attempt 1 as well, otherwise a reviewer re-checks a diff that no longer
 * contains the code it is judging. Two things used to break that: a failed
 * snapshot nulled the baseline (so the next attempt re-baselined after the work
 * was already on disk), and a resumed run starts with an empty edit log. So the
 * file set the task has touched is remembered on the task record, and the diff
 * is taken from HEAD for exactly those files. Unrelated uncommitted work stays
 * out, and files are never dropped from the window. When the remembered set is
 * empty (a resumed run whose baseline was lost) the files the edit tracker saw
 * the agent write are used instead — those are attributable to the agent, so the
 * person's own uncommitted work still stays out of the review.
 */
function reviewDiff(root, task, attemptDiff, after, editFiles = []) {
  // The `after` snapshot can be lost (a failed snapshot, a resumed run). Retry it
  // before giving up: it is one cheap git call, and skipping it hands the
  // reviewer an empty diff for work that is on disk.
  const tree = after || snapshotTree(root);
  if (!tree) return attemptDiff;
  const attempted = attemptDiff && Array.isArray(attemptDiff.files) ? attemptDiff.files.map((f) => f.path) : [];
  const declared = (Array.isArray(task.files) ? task.files : []).map((f) => (f && f.path) || (typeof f === 'string' ? f : null));
  const paths = [...new Set([...(task.touched || []), ...attempted, ...declared, ...editFiles])].filter(Boolean).sort();
  if (paths.length) {
    const scoped = diffTrees(root, 'HEAD', tree, paths);
    if (scoped && scoped.files.length) {
      task.touched = [...new Set([...(task.touched || []), ...scoped.files.map((f) => f.path)])].sort();
      return scoped;
    }
    // The scoped diff can legitimately come back empty (the files are already
    // at HEAD, or the throwaway index disagreed). Still remember what the task
    // is responsible for, so the next attempt does not start from a blank
    // window and hand the reviewer an empty diff again.
    if (!(task.touched || []).length) task.touched = paths;
  }
  return attemptDiff;
}

/** Diff from the session edit log (no git): edits recorded since `from`. */
function diffFromEdits(edits, from, root) {
  const { unifiedDiff, newFileDiff } = require('../edit-viewer');
  const byFile = new Map();
  for (const e of edits.slice(from)) {
    const prev = byFile.get(e.filePath);
    byFile.set(e.filePath, { oldContent: prev ? prev.oldContent : e.oldContent, newContent: e.newContent });
  }
  const parts = [];
  const files = [];
  for (const [file, e] of byFile) {
    const rel = path.relative(root, file) || file;
    const d = e.oldContent == null ? newFileDiff(e.newContent || '', rel) : unifiedDiff(e.oldContent, e.newContent || '', rel);
    parts.push(d);
    const added = (d.match(/^\+(?!\+\+)/gm) || []).length;
    const removed = (d.match(/^-(?!--)/gm) || []).length;
    files.push({ path: rel, added, removed });
  }
  const patch = parts.join('\n');
  return { files, stat: files.map((f) => `${f.path} | +${f.added} -${f.removed}`).join('\n'), patch, added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0) };
}

// ── prompts ─────────────────────────────────────────────────────────────────

function taskPrompt(plan, task) {
  const n = plan.tasks.indexOf(task) + 1;
  const lines = [`[shmakk plan "${plan.title}": task ${n} of ${plan.tasks.length} · ${task.layer} · ${task.kind}]`, `# ${task.title}`, '', '## Instructions', task.instructions || task.title];
  if (task.acceptance.length) lines.push('', '## Acceptance criteria (a reviewer checks your diff against these)', ...task.acceptance.map((a) => `- ${a}`));
  if (task.files.length) lines.push('', '## Files likely involved', ...task.files.map((f) => `- ${f.path}${f.why ? ` (${f.why})` : ''}`));
  const ev = task.evidence || {};
  const where = [ev.page && `page: ${ev.page}`, ev.url && `url: ${ev.url}`, ev.element && `element: ${ev.element}`, ev.selector && `selector: ${ev.selector}`, ev.source && `source: ${ev.source}`].filter(Boolean);
  if (where.length || ev.quote || ev.frames.length) {
    lines.push('', '## Where this came from');
    for (const w of where) lines.push(`- ${w}`);
    if (ev.quote) lines.push(`- in the person's words: "${ev.quote}"`);
    if (ev.frames.length) lines.push(`- ${ev.frames.length} screenshot(s) from the recording are attached for context`);
  }
  if (task.questions.length) lines.push('', '## Open questions (resolve from the code; if you cannot, say so in your report)', ...task.questions.map((q) => `- ${q}`));
  const others = plan.tasks.filter((t) => t !== task);
  if (others.length) lines.push('', '## Other tasks in this plan (do not do them now)', ...others.map((t) => `- [${t.status.replace('_', ' ')}] ${t.title} (${t.layer})`));
  const fb = task.feedback.slice(-4);
  if (fb.length) {
    lines.push('', `## Changes requested (attempt ${task.attempts + 1}). Address every point:`);
    for (const f of fb) {
      lines.push(`From ${f.by === 'you' ? 'the person who owns this plan' : 'the reviewer'}:`);
      lines.push(f.text);
    }
  }
  lines.push('', 'Work only on this task. When you are finished, reply with a short report: what you changed (files), how you verified it (commands you ran), and anything left open. Do not claim it is done; it is accepted only after review.');
  return lines.join('\n');
}

const REVIEW_SYSTEM = `You are the review gate of shmakk, an AI coding agent. A coding agent just worked on one task. You decide whether the task is actually done, based on the diff it produced, not on what the agent claims.

Check, in order:
1. Every acceptance criterion: is it met by the diff? Mark each one. If you cannot tell from the diff, it is not met.
2. Correctness: logic errors, broken imports, wrong file, missing wiring (a component created but never rendered, a column added but never migrated, an endpoint added but never called), type errors.
3. Safety: secrets, destructive changes, security problems.
4. Scope: changes unrelated to the task.

Severity: "critical" = broken build, data loss, security hole; "major" = the task is not achieved or something visibly broke; "minor" = style or nice-to-have. An empty diff means nothing was changed: only pass it if the task truly needed no change and the agent's report shows it verified that.

Respond with ONLY one JSON object:
{"verdict":"pass"|"fail","summary":"one or two sentences","criteria":[{"text":"criterion","met":true,"note":"evidence"}],"issues":[{"severity":"critical|major|minor","file":"path or null","detail":"what is wrong","fix":"how to fix it"}]}`;

function reviewPrompt(task, diff, report) {
  const criteria = task.acceptance.length ? task.acceptance : [`The task "${task.title}" is implemented as instructed`];
  const lines = [`TASK: ${task.title} (${task.layer}, ${task.kind})`, '', 'INSTRUCTIONS', task.instructions || task.title, '', 'ACCEPTANCE CRITERIA', ...criteria.map((c, i) => `${i + 1}. ${c}`)];
  if (task.feedback.length) lines.push('', 'EARLIER FEEDBACK THAT MUST BE ADDRESSED', ...task.feedback.slice(-3).map((f) => `- ${f.text.slice(0, 1500)}`));
  lines.push('', "AGENT'S REPORT", str(report, 4000) || '(no report)');
  lines.push('', 'FILES CHANGED', (diff && diff.stat) || '(none)');
  let patch = (diff && diff.patch) || '';
  if (patch.length > MAX_DIFF_FOR_REVIEW) patch = `${patch.slice(0, MAX_DIFF_FOR_REVIEW)}\n[diff truncated for review]`;
  lines.push('', 'DIFF', patch ? `\`\`\`diff\n${patch}\n\`\`\`` : '(empty: no files were changed)');
  return lines.join('\n');
}

async function reviewTask({ task, diff, report, client, model, signal }) {
  const params = {
    model,
    messages: [{ role: 'system', content: REVIEW_SYSTEM }, { role: 'user', content: reviewPrompt(task, diff, report) }],
    temperature: 0,
    max_tokens: 3000,
    stream: false,
  };
  if (/deepseek/i.test(String(model))) params.thinking = { type: 'disabled' };
  const resp = await client.chat.completions.create(params, { signal });
  const raw = String(resp && resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content || '');
  const { extractJson } = require('../services/vision');
  let parsed;
  try { parsed = extractJson(raw); } catch { parsed = { verdict: 'fail', summary: 'The reviewer returned an unreadable response.', issues: [{ severity: 'major', detail: `Unparseable review: ${raw.slice(0, 300)}` }] }; }
  // Make sure every acceptance criterion is accounted for.
  const v = normalizeVerdict(parsed);
  const expected = task.acceptance.length ? task.acceptance : [];
  if (expected.length && v.criteria.length < expected.length) {
    for (const c of expected.slice(v.criteria.length)) v.criteria.push({ text: c, met: false, note: 'not assessed by the reviewer' });
    if (v.verdict === 'pass') { v.verdict = 'fail'; v.overridden = 'not every acceptance criterion was assessed'; }
  }
  return v;
}

/** Text fed back to the agent after a failed review. */
function feedbackFromVerdict(v) {
  const lines = [];
  if (v.summary) lines.push(v.summary);
  for (const c of v.criteria.filter((x) => !x.met)) lines.push(`- Not met: ${c.text}${c.note ? ` (${c.note})` : ''}`);
  for (const i of v.issues.filter((x) => x.severity !== 'minor')) lines.push(`- ${i.severity}: ${i.file ? `${i.file}: ` : ''}${i.detail}${i.fix ? ` Fix: ${i.fix}` : ''}`);
  if (v.overridden) lines.push(`(Review gate: ${v.overridden}.)`);
  return lines.join('\n') || 'The review did not pass. Re-check the acceptance criteria.';
}

// ── TASKS.md: a managed block mirroring plan state ──────────────────────────

const BLOCK_START = '<!-- shmakk:plans:start (managed by shmakk, edits here are overwritten) -->';
const BLOCK_END = '<!-- shmakk:plans:end -->';
const MARK = { todo: ' ', running: ' ', reviewing: ' ', rework: ' ', awaiting_approval: ' ', blocked: ' ', skipped: '-', done: 'x' };
const NOTE = { running: 'in progress', reviewing: 'in review', rework: 'changes requested', awaiting_approval: 'awaiting your sign-off', blocked: 'blocked', skipped: 'skipped' };

function renderTaskBlock(plans) {
  const lines = [BLOCK_START];
  for (const p of plans) {
    lines.push('', `### ${p.title}`);
    for (const t of p.tasks) lines.push(`- [${MARK[t.status] || ' '}] ${t.title} (${t.layer})${NOTE[t.status] ? ` _${NOTE[t.status]}_` : ''}`);
  }
  lines.push(BLOCK_END);
  return lines.join('\n');
}

function syncTaskFile(root, plans) {
  const file = path.join(root, 'TASKS.md');
  const active = plans.filter((p) => p.started && p.syncTasksFile !== false);
  let content = '';
  try { content = fs.readFileSync(file, 'utf8'); } catch {}
  if (!content && !active.length) return;
  const block = renderTaskBlock(active);
  const re = new RegExp(`${BLOCK_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${BLOCK_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  let next;
  if (re.test(content)) next = content.replace(re, active.length ? block : '').replace(/\n{3,}/g, '\n\n');
  else if (!active.length) return;
  else next = `${content || '# Tasks\n'}${content.endsWith('\n') || !content ? '' : '\n'}\n## shmakk plans\n\n${block}\n`;
  if (next !== content) { try { fs.writeFileSync(file, next); } catch {} }
}

// ── manager ─────────────────────────────────────────────────────────────────

/**
 * ctx: { chat, getWorkspace, broadcast, settings }
 *  chat must offer: create({title, mode, workspace}), get(id), sendAndWait(id, text, opts), stop(id)
 */
function createPlanManager(ctx) {
  const runners = new Map(); // planId → { stop: bool, convId, current }
  const ws = () => path.resolve(ctx.getWorkspace());
  const migrated = new Set(); // roots already upgraded to the current schema
  const ensureMigrated = (root) => {
    if (migrated.has(root)) return;
    migrated.add(root);
    try { migratePlans(root); } catch {}
  };
  const changed = (plan) => {
    try { syncTaskFile(plan.workspace || ws(), listPlans(plan.workspace || ws())); } catch {}
    ctx.broadcast({ t: 'plans.changed', planId: plan.id });
  };
  const view = (plan) => ({ ...plan, running: runners.has(plan.id) });
  const llmClient = (model) => {
    if (ctx.reviewClient) return ctx.reviewClient;
    const llm = require('../llm');
    if (!llm.isConfigured()) return null;
    return llm.makeClientForModel(model);
  };

  function load(id, root = ws()) {
    ensureMigrated(root);
    const p = readPlan(root, id);
    if (!p) { const e = new Error('plan not found'); e.status = 404; throw e; }
    return p;
  }
  function save(plan) {
    plan.status = derivePlanStatus(plan, { running: runners.has(plan.id) });
    writePlan(plan.workspace, plan);
    changed(plan);
    return plan;
  }

  function list() {
    ensureMigrated(ws());
    return listPlans(ws()).map((p) => {
      const counts = {};
      for (const t of p.tasks) counts[t.status] = (counts[t.status] || 0) + 1;
      const { tasks: _t, ...meta } = p;
      return { ...meta, running: runners.has(p.id), taskCount: p.tasks.length, counts };
    });
  }

  function get(id) { return view(load(id)); }

  /**
   * Create a plan from proposed tasks. assets: { frames: { file: absPath } }
   * copies screenshots into the plan so evidence survives the recording.
   */
  function create({ title, summary = '', source = 'manual', tasks = [], requireSignoff = true, assets = null, origin = null, convId = null } = {}) {
    const root = ws();
    const made = linkDependencies((Array.isArray(tasks) ? tasks : []).map(makeTask));
    if (!made.length) { const e = new Error('a plan needs at least one task'); e.status = 400; throw e; }
    const plan = newPlan({
      title, summary, source, origin, workspace: root, tasks: made, requireSignoff, convId,
      owner: typeof ctx.getOwner === 'function' ? ctx.getOwner() : null,
    });
    if (assets && assets.frames && typeof assets.frames === 'object') {
      const dir = assetsDir(root, plan.id);
      fs.mkdirSync(dir, { recursive: true });
      for (const [name, abs] of Object.entries(assets.frames)) {
        const base = path.basename(name);
        if (!/^[\w.-]+\.(png|jpe?g|webp)$/i.test(base)) continue;
        try { fs.copyFileSync(abs, path.join(dir, base)); } catch {}
      }
    }
    writePlan(root, plan);
    changed(plan);
    return view(plan);
  }

  function update(id, patch = {}) {
    const plan = load(id);
    if (typeof patch.title === 'string' && patch.title.trim()) plan.title = str(patch.title, 160);
    if (typeof patch.summary === 'string') plan.summary = str(patch.summary, 2000);
    if (typeof patch.requireSignoff === 'boolean') plan.requireSignoff = patch.requireSignoff;
    return view(save(plan));
  }

  function remove(id) {
    if (runners.has(id)) { const e = new Error('pause the plan before deleting it'); e.status = 409; throw e; }
    const root = ws();
    load(id, root);
    fs.rmSync(planFile(root, id), { force: true });
    fs.rmSync(assetsDir(root, id), { recursive: true, force: true });
    try { syncTaskFile(root, listPlans(root)); } catch {}
    ctx.broadcast({ t: 'plans.changed', planId: id });
    return true;
  }

  const EDITABLE = new Set(['todo', 'rework', 'blocked', 'awaiting_approval', 'skipped']);
  function editTask(id, taskId, patch = {}) {
    const plan = load(id);
    const t = plan.tasks.find((x) => x.id === taskId);
    if (!t) { const e = new Error('task not found'); e.status = 404; throw e; }
    if (!EDITABLE.has(t.status)) { const e = new Error(`a ${t.status.replace('_', ' ')} task cannot be edited`); e.status = 409; throw e; }
    const fresh = makeTask({ ...t, ...patch, id: t.id, key: t.key }, 0);
    for (const k of ['title', 'kind', 'layer', 'priority', 'instructions', 'acceptance', 'files', 'questions']) if (k in patch) t[k] = fresh[k];
    if (Array.isArray(patch.dependsOn)) t.dependsOn = patch.dependsOn.filter((d) => d !== t.id && plan.tasks.some((x) => x.id === d));
    return view(save(plan));
  }

  function addTask(id, task) {
    const plan = load(id);
    const t = makeTask(task || {}, plan.tasks.length);
    plan.tasks.push(t);
    linkDependencies(plan.tasks);
    return view(save(plan));
  }

  function deleteTask(id, taskId) {
    const plan = load(id);
    const t = plan.tasks.find((x) => x.id === taskId);
    if (!t) { const e = new Error('task not found'); e.status = 404; throw e; }
    if (t.status === 'running' || t.status === 'reviewing') { const e = new Error('wait for the task to finish'); e.status = 409; throw e; }
    plan.tasks = plan.tasks.filter((x) => x !== t);
    for (const o of plan.tasks) o.dependsOn = o.dependsOn.filter((d) => d !== taskId);
    return view(save(plan));
  }

  function moveTask(id, taskId, delta) {
    const plan = load(id);
    const i = plan.tasks.findIndex((x) => x.id === taskId);
    const j = i + (delta < 0 ? -1 : 1);
    if (i === -1 || j < 0 || j >= plan.tasks.length) return view(plan);
    [plan.tasks[i], plan.tasks[j]] = [plan.tasks[j], plan.tasks[i]];
    return view(save(plan));
  }

  // ── human decisions ──

  function approve(id, taskId, { note = '' } = {}) {
    const plan = load(id);
    const t = plan.tasks.find((x) => x.id === taskId);
    if (!t) { const e = new Error('task not found'); e.status = 404; throw e; }
    if (t.status !== 'awaiting_approval' && t.status !== 'blocked') { const e = new Error('only reviewed tasks can be approved'); e.status = 409; throw e; }
    const overriding = t.status === 'blocked';
    setStatus(t, 'done', overriding ? `accepted by you despite the review${note ? `: ${note}` : ''}` : (note ? `approved: ${note}` : 'approved by you'));
    t.approvedAt = Date.now();
    t.overridden = overriding;
    save(plan);
    kick(plan.id);
    return view(plan);
  }

  function requestChanges(id, taskId, { comment } = {}) {
    const text = str(comment, 4000);
    if (!text) { const e = new Error('say what should change'); e.status = 400; throw e; }
    const plan = load(id);
    const t = plan.tasks.find((x) => x.id === taskId);
    if (!t) { const e = new Error('task not found'); e.status = 404; throw e; }
    if (!['awaiting_approval', 'done', 'blocked', 'skipped'].includes(t.status)) { const e = new Error('changes can be requested once the task has been reviewed'); e.status = 409; throw e; }
    t.feedback.push({ at: Date.now(), by: 'you', text });
    t.roundAttempts = 0;
    t.approvedAt = null;
    setStatus(t, 'rework', 'you requested changes');
    save(plan);
    if (plan.started) run(plan.id).catch(() => {});
    return view(plan);
  }

  function skip(id, taskId) {
    const plan = load(id);
    const t = plan.tasks.find((x) => x.id === taskId);
    if (!t) { const e = new Error('task not found'); e.status = 404; throw e; }
    if (t.status === 'running' || t.status === 'reviewing') { const e = new Error('wait for the task to finish'); e.status = 409; throw e; }
    setStatus(t, 'skipped', 'skipped by you');
    save(plan);
    kick(plan.id);
    return view(plan);
  }

  function retry(id, taskId) {
    const plan = load(id);
    const t = plan.tasks.find((x) => x.id === taskId);
    if (!t) { const e = new Error('task not found'); e.status = 404; throw e; }
    if (!['blocked', 'skipped'].includes(t.status)) { const e = new Error('only blocked or skipped tasks can be retried'); e.status = 409; throw e; }
    t.roundAttempts = 0;
    setStatus(t, t.attempts ? 'rework' : 'todo', 'retry');
    save(plan);
    if (plan.started) run(plan.id).catch(() => {});
    return view(plan);
  }

  // If the plan is live (started, not paused), keep the runner going.
  function kick(id) {
    const plan = readPlan(ws(), id);
    if (plan && !runners.has(id) && plan.started && !plan.paused && nextRunnable(plan)) run(id).catch(() => {});
  }

  // ── runner ──

  function ensureConv(plan) {
    const existing = plan.convId && ctx.chat.get(plan.convId);
    if (existing) return existing.id;
    const conv = ctx.chat.create({ title: `Plan: ${plan.title}`.slice(0, 110), mode: 'code', workspace: plan.workspace });
    plan.convId = conv.id;
    return conv.id;
  }

  function pause(id) {
    const r = runners.get(id);
    const plan = load(id);
    plan.paused = true;
    save(plan);
    if (!r) return view(plan);
    r.stop = true;
    if (r.convId) ctx.chat.stop(r.convId);
    return view(plan);
  }

  function frameAttachments(plan, task) {
    const dir = assetsDir(plan.workspace, plan.id);
    return task.evidence.frames.map((f) => {
      const abs = path.join(dir, f);
      try {
        const data = fs.readFileSync(abs);
        return { name: f, mimeType: /\.png$/i.test(f) ? 'image/png' : /\.webp$/i.test(f) ? 'image/webp' : 'image/jpeg', data: data.toString('base64'), size: data.length };
      } catch { return null; }
    }).filter(Boolean);
  }

  async function runTask(plan, task, r) {
    const root = plan.workspace;
    const { getEdits } = require('../edit-tracker');
    // Plan tasks run inside the conversation `r.convId`; the edit tracker is
    // scoped per conversation so concurrent sessions don't leak edits into
    // each other's review diffs.
    const edits = () => getEdits(r.convId);
    task.attempts += 1;
    task.roundAttempts += 1;
    task.startedAt = Date.now();
    task.noChanges = false;
    setStatus(task, 'running', `attempt ${task.attempts}`);
    save(plan);

    // Review the task's whole change, not just this attempt's increment, as
    // long as no other task has touched the tree since this one started. The
    // baseline is taken once per task: a failed snapshot must not be replaced
    // later, because a later baseline starts after work already on disk.
    const now = snapshotTree(root);
    if (!now) console.error('[shmakk plan] git snapshot failed, falling back to the edit log:', snapshotFailure());
    if (!task.baseCaptured || plan.lastTaskId !== task.id) { task.baseTree = now; task.baseEdits = edits().length; task.baseCaptured = true; }
    // A rework starts with the earlier attempt's files already on disk, so the
    // baseline cannot tell them apart from the person's own edits. The edit
    // tracker can, so seed the remembered window from it when nothing is known.
    if (task.attempts > 1 && !(task.touched || []).length) task.touched = editedFiles(root, edits());
    plan.lastTaskId = task.id;
    save(plan);
    const before = task.baseTree;
    const editsFrom = Math.min(task.baseEdits || 0, edits().length);
    const out = await ctx.chat.sendAndWait(r.convId, taskPrompt(plan, task), {
      direct: true,
      attachments: frameAttachments(plan, task),
    });
    // Re-read: the user may have edited other tasks while this one ran.
    const fresh = readPlan(root, plan.id) || plan;
    const t = fresh.tasks.find((x) => x.id === task.id) || task;
    Object.assign(plan, fresh);
    task = t;

    if (out.status === 'stopped' || r.stop) {
      setStatus(task, task.attempts > 1 ? 'rework' : 'todo', 'stopped');
      task.attempts -= 1;
      task.roundAttempts = Math.max(0, task.roundAttempts - 1);
      save(plan);
      return 'stopped';
    }
    task.report = str(out.summary, 6000) || null;

    const after = snapshotTree(root);
    const attempt = before && after ? diffTrees(root, before, after) : diffFromEdits(edits(), editsFrom, root);
    const diff = reviewDiff(root, task, attempt, after, editedFiles(root, edits()));
    const diffName = `${task.id}-${task.attempts}.diff`;
    if (diff && diff.patch) {
      fs.mkdirSync(assetsDir(root, plan.id), { recursive: true });
      fs.writeFileSync(path.join(assetsDir(root, plan.id), diffName), diff.patch);
    }

    if (out.status === 'error') {
      const v = { verdict: 'fail', summary: `The agent run failed: ${out.error || 'unknown error'}`, criteria: [], issues: [{ severity: 'major', file: null, detail: out.error || 'agent error', fix: null }], overridden: null };
      task.reviews.push({ at: Date.now(), attempt: task.attempts, ...v, diff: diff && diff.patch ? diffName : null, files: diff ? diff.files : [] });
      task.feedback.push({ at: Date.now(), by: 'reviewer', text: feedbackFromVerdict(v) });
      applyVerdict(task, v, { requireSignoff: plan.requireSignoff });
      save(plan);
      return task.status;
    }

    setStatus(task, 'reviewing');
    save(plan);
    const c = llmClient(ctx.settings && ctx.settings.modelByMode && ctx.settings.modelByMode.code);
    let verdict;
    try {
      if (!c) throw new Error('no AI provider configured for the reviewer');
      verdict = await reviewTask({ task, diff, report: task.report, client: c.client, model: c.model });
    } catch (e) {
      verdict = { verdict: 'fail', summary: `Review could not run: ${e.message}`, criteria: [], issues: [{ severity: 'major', file: null, detail: `Review could not run: ${e.message}`, fix: null }], overridden: null };
    }
    task.noChanges = !diff || !diff.files.length;
    task.reviews.push({ at: Date.now(), attempt: task.attempts, ...verdict, diff: diff && diff.patch ? diffName : null, files: diff ? diff.files : [], added: diff ? diff.added : 0, removed: diff ? diff.removed : 0 });
    if (verdict.verdict !== 'pass') task.feedback.push({ at: Date.now(), by: 'reviewer', text: feedbackFromVerdict(verdict) });
    task.finishedAt = Date.now();
    applyVerdict(task, verdict, { requireSignoff: plan.requireSignoff });
    save(plan);
    return task.status;
  }

  async function run(id) {
    if (runners.has(id)) return view(load(id));
    const plan = load(id);
    if (!plan.tasks.length) { const e = new Error('the plan has no tasks'); e.status = 400; throw e; }
    if (!ctx.reviewClient && !require('../llm').isConfigured()) { const e = new Error('no AI provider configured'); e.status = 400; throw e; }
    const r = { stop: false, convId: null };
    runners.set(id, r);
    r.convId = ensureConv(plan);
    plan.started = true;
    plan.paused = false;
    save(plan);
    (async () => {
      try {
        for (;;) {
          if (r.stop) break;
          const cur = load(id);
          const task = nextRunnable(cur);
          if (!task) break;
          const conv = ctx.chat.get(r.convId);
          if (conv && conv.run) {
            // Someone is typing in the plan's conversation; wait for that run.
            await new Promise((res) => setTimeout(res, 1500));
            continue;
          }
          const outcome = await runTask(cur, task, r);
          if (outcome === 'stopped') break;
        }
      } catch (e) {
        try { const p = load(id); ctx.broadcast({ t: 'toast', level: 'error', text: `Plan "${p.title}": ${e.message}` }); } catch {}
      } finally {
        runners.delete(id);
        try {
          const p = load(id);
          if (r.stop) p.paused = true;
          save(p);
          const done = p.status === 'done';
          ctx.broadcast({ t: 'toast', level: done ? 'ok' : 'info', text: done ? `Plan "${p.title}" is done.` : p.status === 'awaiting_review' ? `Plan "${p.title}": tasks are waiting for your review.` : p.status === 'needs_attention' ? `Plan "${p.title}" needs your attention.` : `Plan "${p.title}" paused.` });
        } catch {}
      }
    })();
    return view(plan);
  }

  function diffFor(id, file) {
    const plan = load(id);
    const base = path.basename(String(file || ''));
    if (!/^[\w-]+-\d+\.diff$/.test(base)) { const e = new Error('not found'); e.status = 404; throw e; }
    try { return fs.readFileSync(path.join(assetsDir(plan.workspace, plan.id), base), 'utf8'); } catch { const e = new Error('not found'); e.status = 404; throw e; }
  }

  function assetFor(id, file) {
    const plan = load(id);
    const base = path.basename(String(file || ''));
    if (!/^[\w.-]+\.(png|jpe?g|webp)$/i.test(base)) { const e = new Error('not found'); e.status = 404; throw e; }
    const abs = path.join(assetsDir(plan.workspace, plan.id), base);
    if (!fs.existsSync(abs)) { const e = new Error('not found'); e.status = 404; throw e; }
    return { data: fs.readFileSync(abs), contentType: /\.png$/i.test(base) ? 'image/png' : /\.webp$/i.test(base) ? 'image/webp' : 'image/jpeg' };
  }

  function shutdown() {
    for (const r of runners.values()) { r.stop = true; if (r.convId) ctx.chat.stop(r.convId); }
  }

  // A restart interrupts whatever was running: put those tasks back in line.
  function recover() {
    for (const p of listPlans(ws())) {
      let touched = false;
      for (const t of p.tasks) if (t.status === 'running' || t.status === 'reviewing') { setStatus(t, t.attempts > 1 ? 'rework' : 'todo', 'interrupted by a restart'); touched = true; }
      if (touched || p.status === 'running') { p.paused = true; p.status = derivePlanStatus(p); writePlan(p.workspace, p); }
    }
  }

  return { list, get, create, validateCreate, update, remove, editTask, addTask, deleteTask, moveTask, approve, requestChanges, skip, retry, run, pause, diffFor, assetFor, shutdown, recover, isRunning: (id) => runners.has(id) };
}

module.exports = {
  MAX_ATTEMPTS,
  SCHEMA_VERSION,
  PLAN_STATUSES,
  REQUIRED_FIELDS,
  TASK_STATUSES,
  makeTask,
  linkDependencies,
  setStatus,
  depsMet,
  nextRunnable,
  derivePlanStatus,
  normalizeVerdict,
  applyVerdict,
  PLAN_SCHEMA,
  snapshotTree,
  snapshotFailure,
  editedFiles,
  diffTrees,
  reviewDiff,
  diffFromEdits,
  taskPrompt,
  reviewPrompt,
  reviewTask,
  feedbackFromVerdict,
  renderTaskBlock,
  syncTaskFile,
  createPlanManager,
  defaultOwner,
  newPlan,
  normalizePlan,
  validatePlan,
  validateCreate,
  MAX_TASKS_PER_PLAN,
  KNOWN_SOURCES,
  migratePlans,
  readPlan,
  writePlan,
  listPlans,
  newId,
  assetsDir,
};

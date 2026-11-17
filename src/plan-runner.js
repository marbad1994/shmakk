// Review-gated plan execution for the CLI/PTY session.
//
// Same lifecycle as the web UI's plan manager (src/webui/plans.js), built
// from the same pure helpers and persisted to the same store
// (<workspace>/.shmakk/plans/<id>.json), so a plan started in the terminal
// also shows up in the web UI's Plans view:
//
//   todo ──run──▶ running ──▶ reviewing ──pass──▶ awaiting_approval ──y──▶ done
//                   ▲             │                 (done directly when
//                   │            fail                sign-off is off)
//                   └── rework ◀──┘   after MAX_ATTEMPTS fails ─▶ blocked
//
// A task is never marked done because the agent returned. Its diff is
// measured (git tree snapshots before/after, uncommitted edits included;
// the session edit log outside git), reviewed against its acceptance
// criteria, and a failed review is fed back to the agent as the next
// attempt's prompt. TASKS.md mirrors the plan through syncTaskFile, so a task
// only shows as done there once it has been accepted.
//
// Everything that talks to the outside world (agent, reviewer, prompts) is
// injected, which keeps this module testable without an LLM or a PTY.

const fs = require('fs');
const path = require('path');
const P = require('./webui/plans');

const isAbortDefault = (e) => !!e && (e.name === 'AbortError' || /aborted/i.test(String(e.message || '')));

/** Build a store-shaped plan from the planner's draft ({title, tasks:[{id,title,description,layer,acceptance}]}). */
function createCliPlan(root, draft, { request = '', requireSignoff = true } = {}) {
  const ws = path.resolve(root);
  const tasks = P.linkDependencies((draft && Array.isArray(draft.tasks) ? draft.tasks : []).map((t, i) => P.makeTask({
    key: t.id != null ? String(t.id) : undefined,
    title: t.title,
    instructions: t.instructions || t.description,
    layer: t.layer,
    kind: t.kind,
    acceptance: t.acceptance,
    files: t.files,
    dependsOn: t.dependsOn,
  }, i)));
  if (!tasks.length) throw new Error('a plan needs at least one task');
  const now = Date.now();
  return {
    id: P.newId('p'),
    title: String((draft && draft.title) || tasks[0].title).slice(0, 160),
    summary: '',
    source: 'cli',
    origin: request ? { request: String(request).slice(0, 2000) } : null,
    workspace: ws,
    requireSignoff: requireSignoff !== false,
    status: 'draft',
    started: false,
    paused: false,
    convId: null,
    createdAt: now,
    updatedAt: now,
    tasks,
  };
}

/** Persist a plan to the shared store and mirror every plan into TASKS.md. */
function savePlanState(plan, { running = false } = {}) {
  plan.status = P.derivePlanStatus(plan, { running });
  P.writePlan(plan.workspace, plan);
  try { P.syncTaskFile(plan.workspace, P.listPlans(plan.workspace)); } catch {}
  return plan;
}

/** Shape for the legacy .shmakk/state/active-plan.json (--show-plan, /api/plan). */
const LEGACY = { done: 'completed', skipped: 'skipped', blocked: 'failed', running: 'in_progress', reviewing: 'in_progress' };
function legacyPlanView(plan) {
  return {
    id: plan.id,
    title: plan.title,
    status: plan.status === 'done' ? 'completed' : plan.status === 'running' ? 'executing' : plan.status,
    currentTaskIndex: Math.max(0, plan.tasks.findIndex((t) => t.status === 'running' || t.status === 'reviewing')),
    createdAt: new Date(plan.createdAt).toISOString(),
    originalRequest: plan.origin && plan.origin.request,
    tasks: plan.tasks.map((t, i) => ({
      id: String(i + 1),
      title: t.title,
      description: t.instructions,
      status: LEGACY[t.status] || 'pending',
      completedAt: t.approvedAt ? new Date(t.approvedAt).toISOString() : null,
    })),
  };
}

/** Text of the last assistant message in an agent history (the agent's report). */
function lastAssistantText(history) {
  const m = [...(Array.isArray(history) ? history : [])].reverse().find((x) => x && x.role === 'assistant' && x.content);
  if (!m) return '';
  return typeof m.content === 'string' ? m.content : m.content.map((c) => (c && c.text) || '').join(' ');
}

const failVerdict = (summary, detail) => ({ verdict: 'fail', summary, criteria: [], issues: [{ severity: 'major', file: null, detail: detail || summary, fix: null }], overridden: null });

/**
 * Run a plan task by task until nothing is runnable.
 *
 * deps:
 *   runAgentTask(prompt, task) → report string     (throws on failure)
 *   reviewer({ task, diff, report, signal }) → normalized verdict
 *   confirm(question, defaultYes) → boolean         (y/n prompt)
 *   askText(question) → string | null               (optional free-text prompt)
 *   write(text), signal, getEdits(), isAbort(err), onChange(plan)
 *
 * Returns the final plan. Abort errors are rethrown after the running task
 * has been put back in line and the plan marked paused.
 */
async function runCliPlan(plan, deps) {
  const {
    runAgentTask, reviewer, confirm, askText = null,
    write = () => {}, signal = null, getEdits = () => [],
    isAbort = isAbortDefault, onChange = () => {}, maxAttempts = P.MAX_ATTEMPTS,
    color = (code, s) => `\x1b[${code}m${s}\x1b[0m`,
  } = deps;
  const root = plan.workspace;
  let running = true;
  const save = () => { savePlanState(plan, { running }); try { onChange(plan); } catch {} };
  const label = (task) => `[${plan.tasks.indexOf(task) + 1}/${plan.tasks.length}] ${task.title}`;

  plan.started = true;
  plan.paused = false;
  save();

  const runOne = async (task) => {
    task.attempts += 1;
    task.roundAttempts += 1;
    task.startedAt = Date.now();
    task.noChanges = false;
    P.setStatus(task, 'running', `attempt ${task.attempts}`);
    // Review the task's whole change across attempts, as long as no other
    // task has touched the tree since this one started.
    if (!task.baseTree || plan.lastTaskId !== task.id) {
      task.baseTree = P.snapshotTree(root);
      task.baseEdits = getEdits().length;
    }
    plan.lastTaskId = task.id;
    save();

    write(color('36', `${label(task)}${task.attempts > 1 ? ` (attempt ${task.attempts})` : ''}`) + '\r\n');

    const before = task.baseTree;
    const editsFrom = Math.min(task.baseEdits || 0, getEdits().length);
    let report = '';
    let agentError = null;
    try {
      report = await runAgentTask(P.taskPrompt(plan, task), task);
    } catch (e) {
      if (isAbort(e)) {
        P.setStatus(task, task.attempts > 1 ? 'rework' : 'todo', 'stopped');
        task.attempts -= 1;
        task.roundAttempts = Math.max(0, task.roundAttempts - 1);
        throw e;
      }
      agentError = e;
    }
    task.report = String(report || '').slice(0, 6000) || null;

    const after = before ? P.snapshotTree(root) : null;
    const diff = before && after ? P.diffTrees(root, before, after) : P.diffFromEdits(getEdits(), editsFrom, root);
    const diffName = `${task.id}-${task.attempts}.diff`;
    if (diff && diff.patch) {
      try {
        fs.mkdirSync(P.assetsDir(root, plan.id), { recursive: true });
        fs.writeFileSync(path.join(P.assetsDir(root, plan.id), diffName), diff.patch);
      } catch {}
    }

    let verdict;
    if (agentError) {
      verdict = failVerdict(`The agent run failed: ${agentError.message || 'unknown error'}`, agentError.message || 'agent error');
    } else {
      P.setStatus(task, 'reviewing');
      save();
      write(color('2', `    reviewing ${diff && diff.files.length ? `${diff.files.length} changed file(s)` : 'an empty diff'} against ${task.acceptance.length || 1} criteria…`) + '\r\n');
      try {
        verdict = await reviewer({ task, diff, report: task.report, signal });
      } catch (e) {
        if (isAbort(e)) {
          P.setStatus(task, task.attempts > 1 ? 'rework' : 'todo', 'stopped');
          task.attempts -= 1;
          task.roundAttempts = Math.max(0, task.roundAttempts - 1);
          throw e;
        }
        verdict = failVerdict(`Review could not run: ${e.message}`);
      }
    }
    task.noChanges = !diff || !diff.files.length;
    task.reviews.push({ at: Date.now(), attempt: task.attempts, ...verdict, diff: diff && diff.patch ? diffName : null, files: diff ? diff.files : [], added: diff ? diff.added : 0, removed: diff ? diff.removed : 0 });
    if (verdict.verdict !== 'pass') task.feedback.push({ at: Date.now(), by: 'reviewer', text: P.feedbackFromVerdict(verdict) });
    task.finishedAt = Date.now();
    P.applyVerdict(task, verdict, { requireSignoff: plan.requireSignoff, maxAttempts });
    save();

    if (verdict.verdict === 'pass') {
      write(color('32', `    review passed${verdict.summary ? `: ${verdict.summary}` : ''}`) + '\r\n');
    } else {
      write(color('33', `    review failed (${task.roundAttempts}/${maxAttempts}):`) + '\r\n');
      for (const line of P.feedbackFromVerdict(verdict).split('\n')) write(color('2', `      ${line}`) + '\r\n');
    }
  };

  const signoff = async (task) => {
    const last = task.reviews[task.reviews.length - 1];
    const files = last && last.files && last.files.length ? last.files.map((f) => `${f.path} +${f.added} -${f.removed}`).join(', ') : 'no files changed';
    write(color('2', `    changes: ${files}`) + '\r\n');
    const ok = await confirm(`Accept "${task.title}" as done?`, true);
    if (ok) {
      P.setStatus(task, 'done', 'approved by you');
      task.approvedAt = Date.now();
      save();
      return;
    }
    const note = askText ? String((await askText('What should change? (Enter to leave it for later): ')) || '').trim() : '';
    if (note) {
      task.feedback.push({ at: Date.now(), by: 'you', text: note.slice(0, 4000) });
      task.roundAttempts = 0;
      task.approvedAt = null;
      P.setStatus(task, 'rework', 'you requested changes');
    } else {
      write(color('2', '    left awaiting your sign-off (approve it later in the web UI Plans view)') + '\r\n');
    }
    save();
  };

  try {
    for (;;) {
      if (signal && signal.aborted) break;
      const task = P.nextRunnable(plan);
      if (!task) break;
      await runOne(task);
      if (task.status === 'awaiting_approval') await signoff(task);
      if (task.status === 'blocked') {
        const skip = await confirm(`"${task.title}" failed review ${task.roundAttempts} times. Skip it and continue?`, false);
        if (skip) {
          P.setStatus(task, 'skipped', 'skipped by you');
          save();
        } else {
          plan.paused = true;
          break;
        }
      }
    }
  } catch (e) {
    plan.paused = true;
    throw e;
  } finally {
    running = false;
    if (signal && signal.aborted) plan.paused = true;
    save();
  }
  return plan;
}

function summarizePlan(plan) {
  const counts = {};
  for (const t of plan.tasks) counts[t.status] = (counts[t.status] || 0) + 1;
  const parts = [`${counts.done || 0}/${plan.tasks.length} done`];
  for (const [k, label] of [['awaiting_approval', 'awaiting sign-off'], ['blocked', 'blocked'], ['skipped', 'skipped'], ['rework', 'needing rework'], ['todo', 'not started']]) {
    if (counts[k]) parts.push(`${counts[k]} ${label}`);
  }
  return parts.join(', ');
}

module.exports = { createCliPlan, runCliPlan, savePlanState, legacyPlanView, lastAssistantText, summarizePlan };

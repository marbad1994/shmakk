// Wire types for the work pipeline (src/webui/plans.js, src/services/intake.js,
// src/services/show2plan.js, src/webui/preview.js).

export type Layer = 'database' | 'backend' | 'frontend' | 'infra' | 'tests' | 'unknown';
export type TaskKind = 'bug' | 'change' | 'feature' | 'chore';
export type Priority = 'high' | 'normal' | 'low';

export interface TaskFile { path: string; why?: string | null }

export interface Evidence {
  frames?: string[];
  quote?: string | null;
  page?: string | null;
  element?: string | null;
  selector?: string | null;
  source?: string | null;
  url?: string | null;
}

/** A task proposed by intake, before it is part of a plan. */
export interface ProposedTask {
  key: string;
  title: string;
  kind: TaskKind;
  layer: Layer;
  priority: Priority;
  instructions: string;
  acceptance: string[];
  files: TaskFile[];
  dependsOn: string[];
  questions: string[];
  requestIds?: string[];
  evidence?: Evidence;
}

export interface TranslateResult {
  tasks: ProposedTask[];
  summary: string;
  via: 'model' | 'fallback';
  error: string | null;
  stack: { frontend: string[]; backend: string[]; database: string[]; languages: string[] };
}

export type TaskStatus = 'todo' | 'running' | 'reviewing' | 'rework' | 'awaiting_approval' | 'done' | 'blocked' | 'skipped';
export type PlanStatus = 'draft' | 'running' | 'queued' | 'paused' | 'awaiting_review' | 'needs_attention' | 'done';

export interface Review {
  at: number;
  attempt: number;
  verdict: 'pass' | 'fail';
  summary: string;
  criteria: { text: string; met: boolean; note: string | null }[];
  issues: { severity: 'critical' | 'major' | 'minor'; file: string | null; detail: string; fix: string | null }[];
  overridden: string | null;
  diff: string | null;
  files: { path: string; added: number; removed: number }[];
  added?: number;
  removed?: number;
}

export interface PlanTaskFull extends Omit<ProposedTask, 'evidence' | 'requestIds'> {
  id: string;
  status: TaskStatus;
  attempts: number;
  roundAttempts: number;
  feedback: { at: number; by: 'you' | 'reviewer'; text: string }[];
  reviews: Review[];
  report: string | null;
  noChanges: boolean;
  overridden?: boolean;
  evidence: Evidence & { frames: string[] };
  startedAt: number | null;
  finishedAt: number | null;
  approvedAt: number | null;
  history: { at: number; status: TaskStatus; note: string | null }[];
}

export interface PlanFull {
  id: string;
  title: string;
  summary: string;
  source: string;
  workspace: string;
  requireSignoff: boolean;
  status: PlanStatus;
  started: boolean;
  paused: boolean;
  running: boolean;
  convId: string | null;
  createdAt: number;
  updatedAt: number;
  tasks: PlanTaskFull[];
}

export interface PlanMeta extends Omit<PlanFull, 'tasks'> {
  taskCount: number;
  counts: Partial<Record<TaskStatus, number>>;
}

export const LAYER_LABEL: Record<Layer, string> = {
  database: 'Database', backend: 'Backend', frontend: 'Frontend', infra: 'Infra', tests: 'Tests', unknown: 'Unsorted',
};

export const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: 'To do', running: 'Working', reviewing: 'In review', rework: 'Changes requested',
  awaiting_approval: 'Needs your sign-off', done: 'Done', blocked: 'Blocked', skipped: 'Skipped',
};

export const PLAN_STATUS_LABEL: Record<PlanStatus, string> = {
  draft: 'Draft', running: 'Running', queued: 'Queued', paused: 'Paused', awaiting_review: 'Waiting for review',
  needs_attention: 'Needs attention', done: 'Done',
};

/** Tailwind classes for the small pills used across the pipeline (sans, not mono). */
export const LAYER_TONE: Record<Layer, string> = {
  database: 'border-warn/40 bg-warn/10 text-warn',
  backend: 'border-info/40 bg-info/10 text-info',
  frontend: 'border-violet/40 bg-violet/10 text-violet',
  infra: 'border-line-strong text-dim',
  tests: 'border-accent/35 bg-accent/10 text-accent',
  unknown: 'border-line-strong text-faint',
};

export const STATUS_TONE: Record<TaskStatus, string> = {
  todo: 'border-line-strong text-dim',
  running: 'border-info/40 bg-info/10 text-info',
  reviewing: 'border-info/40 bg-info/10 text-info',
  rework: 'border-warn/40 bg-warn/10 text-warn',
  awaiting_approval: 'border-violet/40 bg-violet/10 text-violet',
  done: 'border-accent/35 bg-accent/10 text-accent',
  blocked: 'border-danger/40 bg-danger/10 text-danger',
  skipped: 'border-line-strong text-faint',
};

export const pill = 'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 text-[11px] font-semibold leading-[18px]';

/** How many tasks sit in each status. */
export function countsOf(tasks: { status: TaskStatus }[]): Partial<Record<TaskStatus, number>> {
  const counts: Partial<Record<TaskStatus, number>> = {};
  for (const t of tasks) counts[t.status] = (counts[t.status] || 0) + 1;
  return counts;
}

/** A plan record reduced to what the plan list shows. */
export function planToMeta(plan: PlanFull): PlanMeta {
  return {
    id: plan.id, title: plan.title, summary: plan.summary, source: plan.source, workspace: plan.workspace,
    requireSignoff: plan.requireSignoff, status: plan.status, started: plan.started, paused: plan.paused,
    running: plan.running, convId: plan.convId, createdAt: plan.createdAt, updatedAt: plan.updatedAt,
    taskCount: plan.tasks.length, counts: countsOf(plan.tasks),
  };
}

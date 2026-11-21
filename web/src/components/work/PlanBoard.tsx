import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, ArrowDown, ArrowUp, Ban, Check, CheckCircle2, ChevronDown, ChevronRight, Circle, CircleDashed, CircleSlash, Eye,
  FileCode2, Loader2, MessageSquare, MessageSquareWarning, Pause, Pencil, Play, Plus, RotateCcw, ShieldCheck, Trash2, X, XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { cn, relTime } from '@/lib/utils';
import { useApp } from '@/store/app';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Empty, Spinner } from '@/components/ui/misc';
import { Switch } from '@/components/ui/switch';
import { Markdown } from '@/components/chat/Markdown';
import { Diff } from '@/components/chat/Diff';
import { LayerPill } from './TaskDrafts';
import {
  PLAN_STATUS_LABEL, STATUS_LABEL, STATUS_TONE, pill,
  type PlanFull, type PlanMeta, type PlanStatus, type PlanTaskFull, type Review, type TaskStatus,
} from '@/lib/work';

const field = 'w-full rounded-[10px] border border-line-strong bg-sunken px-3 py-2 font-sans text-[13px] leading-relaxed text-fg outline-none placeholder:text-faint focus:border-accent/45 focus:ring-[3px] focus:ring-accent/15';

const STATUS_ICON: Record<TaskStatus, React.ReactNode> = {
  todo: <CircleDashed />,
  running: <Loader2 className="animate-spin" />,
  reviewing: <Eye />,
  rework: <RotateCcw />,
  awaiting_approval: <ShieldCheck />,
  done: <CheckCircle2 />,
  blocked: <XCircle />,
  skipped: <CircleSlash />,
};
const ICON_TONE: Record<TaskStatus, string> = {
  todo: 'text-faint', running: 'text-info', reviewing: 'text-info', rework: 'text-warn', awaiting_approval: 'text-violet', done: 'text-accent', blocked: 'text-danger', skipped: 'text-faint',
};
const PLAN_TONE: Record<PlanStatus, string> = {
  draft: 'border-line-strong text-dim', running: 'border-info/40 bg-info/10 text-info', queued: 'border-info/40 text-info', paused: 'border-line-strong text-dim',
  awaiting_review: 'border-violet/40 bg-violet/10 text-violet', needs_attention: 'border-danger/40 bg-danger/10 text-danger', done: 'border-accent/35 bg-accent/10 text-accent',
};

export function StatusPill({ status }: { status: TaskStatus }) {
  return <span className={cn(pill, STATUS_TONE[status])}>{STATUS_LABEL[status]}</span>;
}
export function PlanStatusPill({ status }: { status: PlanStatus }) {
  return <span className={cn(pill, PLAN_TONE[status] || PLAN_TONE.draft)}>{PLAN_STATUS_LABEL[status] || status}</span>;
}

/** Thin bar showing every task's state, in plan order. */
export function ProgressStrip({ counts, total }: { counts: Partial<Record<TaskStatus, number>>; total: number }) {
  const order: TaskStatus[] = ['done', 'awaiting_approval', 'reviewing', 'running', 'rework', 'blocked', 'skipped', 'todo'];
  const color: Record<TaskStatus, string> = { done: 'bg-accent', awaiting_approval: 'bg-violet', reviewing: 'bg-info', running: 'bg-info', rework: 'bg-warn', blocked: 'bg-danger', skipped: 'bg-line-strong', todo: 'bg-line' };
  return (
    <div className="flex h-1.5 overflow-hidden rounded-full bg-line" role="img" aria-label={`${counts.done || 0} of ${total} done`}>
      {order.map((s) => (counts[s] ? <div key={s} className={color[s]} style={{ width: `${((counts[s] || 0) / Math.max(1, total)) * 100}%` }} /> : null))}
    </div>
  );
}

function countsOf(tasks: PlanTaskFull[]) {
  const c: Partial<Record<TaskStatus, number>> = {};
  for (const t of tasks) c[t.status] = (c[t.status] || 0) + 1;
  return c;
}

function usePlanActions(planId: string) {
  const qc = useQueryClient();
  const done = () => { void qc.invalidateQueries({ queryKey: ['plan-full', planId] }); void qc.invalidateQueries({ queryKey: ['plans'] }); };
  const m = useMutation({
    mutationFn: ({ path, body, method = 'post' }: { path: string; body?: unknown; method?: 'post' | 'patch' | 'del' }) =>
      method === 'del' ? api.del(`/api/plans/${planId}${path}`) : method === 'patch' ? api.patch(`/api/plans/${planId}${path}`, body ?? {}) : api.post(`/api/plans/${planId}${path}`, body ?? {}),
    onSuccess: done,
    onError: (e: Error) => toast.error(e.message),
  });
  return m;
}

// ── task detail ─────────────────────────────────────────────────────────────

function ReviewBlock({ review, planId }: { review: Review; planId: string }) {
  const [showDiff, setShowDiff] = useState(false);
  const diff = useQuery({
    queryKey: ['plan-diff', planId, review.diff],
    queryFn: () => api.get<{ diff: string }>(`/api/plans/${planId}/diff/${review.diff}`),
    enabled: showDiff && !!review.diff,
  });
  // One <Diff> per file, without git's extended header lines (the viewer
  // only understands ---/+++ and hunks).
  const files = useMemo(() => (diff.data?.diff || '').split(/^(?=diff --git )/m).filter((x) => x.trim())
    .map((f) => f.split('\n').filter((l) => !/^(diff --git |index [0-9a-f]+\.\.|(new|deleted) file mode |old mode |new mode |similarity index |rename (from|to) )/.test(l)).join('\n')), [diff.data]);
  return (
    <div className={cn('grid gap-2 rounded-lg border px-3 py-2.5', review.verdict === 'pass' ? 'border-accent/30 bg-accent/5' : 'border-warn/40 bg-warn/5')}>
      <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
        <span className={cn('inline-flex items-center gap-1 font-semibold', review.verdict === 'pass' ? 'text-accent' : 'text-warn')}>
          {review.verdict === 'pass' ? <Check className="size-3.5" /> : <AlertTriangle className="size-3.5" />}
          Review {review.verdict === 'pass' ? 'passed' : 'failed'}
        </span>
        <span className="text-faint">attempt {review.attempt} · {relTime(review.at)}</span>
        {review.files.length ? <span className="text-faint">· {review.files.length} file{review.files.length === 1 ? '' : 's'} <span className="text-accent">+{review.added ?? 0}</span> <span className="text-danger">-{review.removed ?? 0}</span></span> : <span className="text-warn">· no files changed</span>}
      </div>
      {review.summary ? <p className="m-0 text-[13px] text-fg">{review.summary}</p> : null}
      {review.overridden ? <p className="m-0 text-[12px] text-warn">The reviewer said pass, but the gate failed it: {review.overridden}.</p> : null}
      {review.criteria.length ? (
        <ul className="m-0 grid list-none gap-1 p-0">
          {review.criteria.map((c, i) => (
            <li key={i} className="flex items-start gap-2 text-[12.5px]">
              {c.met ? <Check className="mt-0.5 size-3.5 shrink-0 text-accent" /> : <X className="mt-0.5 size-3.5 shrink-0 text-danger" />}
              <span className={c.met ? 'text-dim' : 'text-fg'}>{c.text}{c.note ? <span className="text-faint"> ({c.note})</span> : null}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {review.issues.length ? (
        <ul className="m-0 grid list-none gap-1.5 p-0">
          {review.issues.map((i, k) => (
            <li key={k} className="text-[12.5px]">
              <span className={cn(pill, i.severity === 'minor' ? 'border-line-strong text-dim' : 'border-danger/40 text-danger')}>{i.severity}</span>{' '}
              {i.file ? <span className="text-dim">{i.file}: </span> : null}<span className="text-fg">{i.detail}</span>
              {i.fix ? <div className="mt-0.5 pl-1 text-faint">Fix: {i.fix}</div> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {review.files.length ? (
        <div className="grid gap-1.5">
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {review.files.map((f) => <span key={f.path} className="inline-flex items-center gap-1 text-[12px] text-dim"><FileCode2 className="size-3 text-faint" />{f.path}</span>)}
          </div>
          {review.diff ? <div><Button variant="ghost" size="sm" onClick={() => setShowDiff((v) => !v)}>{showDiff ? <ChevronDown /> : <ChevronRight />}{showDiff ? 'Hide diff' : 'Show diff'}</Button></div> : null}
          {showDiff ? (diff.isLoading ? <Spinner /> : files.map((d, i) => <Diff key={i} diff={d} maxHeight={360} />)) : null}
        </div>
      ) : null}
    </div>
  );
}

function TaskEditor({ task, onSave, onCancel, saving }: { task: PlanTaskFull; onSave: (patch: Partial<PlanTaskFull>) => void; onCancel: () => void; saving: boolean }) {
  const [title, setTitle] = useState(task.title);
  const [instructions, setInstructions] = useState(task.instructions);
  const [acceptance, setAcceptance] = useState(task.acceptance.join('\n'));
  return (
    <div className="grid gap-2.5">
      <Input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Task title" />
      <textarea className={cn(field, 'min-h-32 resize-y')} value={instructions} onChange={(e) => setInstructions(e.target.value)} aria-label="Instructions" />
      <label className="text-[12px] font-medium text-dim" htmlFor={`acc-${task.id}`}>Acceptance criteria, one per line</label>
      <textarea id={`acc-${task.id}`} className={cn(field, 'min-h-20 resize-y')} value={acceptance} onChange={(e) => setAcceptance(e.target.value)} />
      <div className="flex gap-2">
        <Button size="sm" variant="primary" disabled={saving} onClick={() => onSave({ title, instructions, acceptance: acceptance.split('\n').map((x) => x.trim()).filter(Boolean) })}><Check />Save</Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function TaskRow({ plan, task, index, act, busy }: {
  plan: PlanFull; task: PlanTaskFull; index: number;
  act: (path: string, body?: unknown, method?: 'post' | 'patch' | 'del') => void; busy: boolean;
}) {
  const needsYou = task.status === 'awaiting_approval' || task.status === 'blocked';
  const [open, setOpen] = useState(needsYou);
  const [editing, setEditing] = useState(false);
  const [asking, setAsking] = useState(false);
  const [comment, setComment] = useState('');
  useEffect(() => { if (needsYou) setOpen(true); }, [needsYou]);
  const last = task.reviews[task.reviews.length - 1];
  const editable = ['todo', 'rework', 'blocked', 'awaiting_approval', 'skipped'].includes(task.status);
  const deps = task.dependsOn.map((d) => plan.tasks.find((t) => t.id === d)).filter(Boolean) as PlanTaskFull[];
  const base = `/tasks/${task.id}`;

  return (
    <li className={cn('overflow-hidden rounded-xl border bg-raised', needsYou ? 'border-violet/40' : 'border-line')}>
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <span className={cn('mt-0.5 shrink-0 [&_svg]:size-4', ICON_TONE[task.status])} aria-hidden>{STATUS_ICON[task.status] || <Circle />}</span>
        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11.5px] tabular-nums text-faint">{index + 1}</span>
            <LayerPill layer={task.layer} />
            <StatusPill status={task.status} />
            {task.attempts > 1 ? <span className="text-[11.5px] text-faint">attempt {task.attempts}</span> : null}
            {task.overridden ? <span className="text-[11.5px] text-warn">accepted despite review</span> : null}
          </div>
          <div className={cn('mt-1 text-[13.5px] font-medium', task.status === 'done' || task.status === 'skipped' ? 'text-dim' : 'text-fg')}>{task.title}</div>
          {deps.length ? <div className="mt-0.5 text-[11.5px] text-faint">after {deps.map((d) => d.title).join(', ')}</div> : null}
        </button>
        <span className="shrink-0 text-faint">{open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}</span>
      </div>

      {open ? (
        <div className="grid gap-3 border-t border-line bg-panel px-3 py-3">
          {editing ? (
            <TaskEditor task={task} saving={busy} onCancel={() => setEditing(false)} onSave={(patch) => { act(base, patch, 'patch'); setEditing(false); }} />
          ) : (
            <>
              {task.instructions ? <Markdown text={task.instructions} className="text-[13px]" /> : null}
              {task.acceptance.length && !last ? (
                <div className="grid gap-1">
                  <span className="text-[12px] font-medium text-dim">Acceptance criteria</span>
                  <ul className="m-0 grid gap-0.5 pl-4 text-[12.5px] text-dim">{task.acceptance.map((a) => <li key={a}>{a}</li>)}</ul>
                </div>
              ) : null}
              {task.files.length ? <div className="flex flex-wrap gap-x-3 gap-y-1">{task.files.map((f) => <span key={f.path} className="inline-flex items-center gap-1 text-[12px] text-dim"><FileCode2 className="size-3 text-faint" />{f.path}</span>)}</div> : null}
            </>
          )}

          {task.evidence.frames.length || task.evidence.quote || task.evidence.selector ? (
            <div className="grid gap-1.5">
              {task.evidence.quote ? <p className="m-0 text-[12.5px] italic text-dim">"{task.evidence.quote}"</p> : null}
              {task.evidence.selector ? <p className="m-0 text-[12px] text-faint">{[task.evidence.url, task.evidence.selector, task.evidence.source].filter(Boolean).join(' · ')}</p> : null}
              {task.evidence.frames.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {task.evidence.frames.map((f) => <a key={f} href={`/api/plans/${plan.id}/assets/${f}`} target="_blank" rel="noreferrer"><img src={`/api/plans/${plan.id}/assets/${f}`} alt="Screenshot" loading="lazy" className="h-16 w-auto rounded-md border border-line object-contain" /></a>)}
                </div>
              ) : null}
            </div>
          ) : null}

          {task.status === 'running' || task.status === 'reviewing' ? (
            <p className="m-0 inline-flex items-center gap-2 text-[12.5px] text-info"><Spinner className="size-3.5 text-info" />{task.status === 'running' ? 'The agent is working on this task.' : 'Reviewing the diff against the acceptance criteria.'}</p>
          ) : null}

          {last ? <ReviewBlock review={last} planId={plan.id} /> : null}
          {task.reviews.length > 1 ? (
            <details className="text-[12.5px] text-dim">
              <summary className="cursor-pointer">Earlier attempts ({task.reviews.length - 1})</summary>
              <div className="mt-2 grid gap-2">{task.reviews.slice(0, -1).reverse().map((r) => <ReviewBlock key={r.at} review={r} planId={plan.id} />)}</div>
            </details>
          ) : null}

          {task.report ? (
            <details className="text-[12.5px] text-dim">
              <summary className="cursor-pointer">Agent's report</summary>
              <Markdown text={task.report} className="mt-1.5 text-[12.5px]" />
            </details>
          ) : null}

          {task.feedback.filter((f) => f.by === 'you').length ? (
            <div className="grid gap-1">
              <span className="text-[12px] font-medium text-dim">Your notes</span>
              {task.feedback.filter((f) => f.by === 'you').map((f) => <p key={f.at} className="m-0 flex gap-1.5 text-[12.5px] text-fg"><MessageSquare className="mt-0.5 size-3.5 shrink-0 text-faint" />{f.text}</p>)}
            </div>
          ) : null}

          {asking ? (
            <div className="grid gap-2">
              <textarea className={cn(field, 'min-h-20 resize-y')} autoFocus value={comment} onChange={(e) => setComment(e.target.value)} placeholder="What is wrong or still missing? The agent gets this as its next instruction." aria-label="Requested changes" />
              <div className="flex gap-2">
                <Button size="sm" variant="primary" disabled={!comment.trim() || busy} onClick={() => { act(`${base}/request-changes`, { comment }); setAsking(false); setComment(''); }}><MessageSquareWarning />Send back</Button>
                <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {task.status === 'awaiting_approval' ? <Button size="sm" variant="primary" disabled={busy} onClick={() => act(`${base}/approve`)}><Check />Approve</Button> : null}
              {['awaiting_approval', 'done', 'blocked', 'skipped'].includes(task.status) ? <Button size="sm" disabled={busy} onClick={() => setAsking(true)}><MessageSquareWarning />Request changes</Button> : null}
              {task.status === 'blocked' ? <Button size="sm" disabled={busy} onClick={() => act(`${base}/retry`)}><RotateCcw />Try again</Button> : null}
              {task.status === 'blocked' ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(`${base}/approve`, { note: 'accepted from a failed review' })}><ShieldCheck />Accept anyway</Button> : null}
              {editable && !editing ? <Button size="sm" variant="ghost" onClick={() => setEditing(true)}><Pencil />Edit</Button> : null}
              {['todo', 'rework', 'blocked'].includes(task.status) ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(`${base}/skip`)}><Ban />Skip</Button> : null}
              {task.status === 'skipped' ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(`${base}/retry`)}><RotateCcw />Unskip</Button> : null}
              {task.status === 'todo' && !plan.running ? (
                <>
                  <Button size="icon-sm" variant="ghost" aria-label="Move up" disabled={busy || index === 0} onClick={() => act(`${base}/move`, { delta: -1 })}><ArrowUp /></Button>
                  <Button size="icon-sm" variant="ghost" aria-label="Move down" disabled={busy || index === plan.tasks.length - 1} onClick={() => act(`${base}/move`, { delta: 1 })}><ArrowDown /></Button>
                  <Button size="icon-sm" variant="ghost" aria-label="Delete task" disabled={busy} onClick={() => act(base, undefined, 'del')}><Trash2 /></Button>
                </>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </li>
  );
}

// ── plan detail ─────────────────────────────────────────────────────────────

export function PlanDetail({ planId, compact = false, onDeleted }: { planId: string; compact?: boolean; onDeleted?: () => void }) {
  const openConv = useApp((s) => s.openConv);
  const { data: plan, isLoading } = useQuery({ queryKey: ['plan-full', planId], queryFn: () => api.get<PlanFull>(`/api/plans/${planId}`), refetchInterval: (q) => (q.state.data?.running ? 3000 : false) });
  const m = usePlanActions(planId);
  const act = (path: string, body?: unknown, method: 'post' | 'patch' | 'del' = 'post') => m.mutate({ path, body, method });
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState('');

  if (isLoading || !plan) return <div className="grid h-40 place-items-center"><Spinner className="size-5" /></div>;
  const counts = countsOf(plan.tasks);
  const waiting = counts.awaiting_approval || 0;
  const blocked = counts.blocked || 0;
  const canRun = !plan.running && plan.status !== 'done';

  return (
    <div className="grid gap-3">
      <div className="grid gap-2">
        <div className="flex flex-wrap items-start gap-2">
          {renaming ? (
            <form className="flex min-w-0 flex-1 gap-2" onSubmit={(e) => { e.preventDefault(); act('', { title }, 'patch'); setRenaming(false); }}>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus aria-label="Plan title" />
              <Button size="sm" type="submit" variant="primary"><Check /></Button>
            </form>
          ) : (
            <h2 className={cn('m-0 min-w-0 flex-1 font-semibold leading-snug', compact ? 'text-[14px]' : 'text-[16px]')}>
              <button type="button" className="text-left hover:text-accent" onClick={() => { setTitle(plan.title); setRenaming(true); }} title="Rename">{plan.title}</button>
            </h2>
          )}
          <PlanStatusPill status={plan.status} />
        </div>
        <ProgressStrip counts={counts} total={plan.tasks.length} />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-faint">
          <span>{counts.done || 0}/{plan.tasks.length} done</span>
          <span>from {plan.source === 'show2plan' ? 'Show & tell' : plan.source === 'browser' ? 'Edit in browser' : plan.source}</span>
          <span>updated {relTime(plan.updatedAt)}</span>
        </div>
        {plan.summary && !compact ? <p className="m-0 line-clamp-3 text-[13px] text-dim">{plan.summary}</p> : null}
      </div>

      {waiting || blocked ? (
        <div className={cn('rounded-lg border px-3 py-2 text-[12.5px]', blocked ? 'border-danger/40 bg-danger/10 text-danger' : 'border-violet/40 bg-violet/10 text-violet')}>
          {blocked ? `${blocked} task${blocked === 1 ? '' : 's'} failed review ${3} times and need${blocked === 1 ? 's' : ''} you. ` : ''}
          {waiting ? `${waiting} task${waiting === 1 ? ' has' : 's have'} passed review and wait${waiting === 1 ? 's' : ''} for your sign-off.` : ''}
        </div>
      ) : null}
      {plan.status === 'draft' ? <p className="m-0 rounded-lg border border-line px-3 py-2 text-[12.5px] text-dim">Nothing runs until you start the plan. Edit, reorder or remove tasks first if you like.</p> : null}

      <div className="flex flex-wrap items-center gap-2">
        {plan.running ? (
          <Button size="sm" onClick={() => act('/pause')} disabled={m.isPending}><Pause />Pause after this task</Button>
        ) : canRun ? (
          <Button size="sm" variant="primary" onClick={() => act('/run')} disabled={m.isPending}><Play />{plan.started ? 'Resume' : 'Start plan'}</Button>
        ) : null}
        {plan.convId ? <Button size="sm" variant="ghost" onClick={() => void openConv(plan.convId as string)}><MessageSquare />Open conversation</Button> : null}
        <label className="ml-auto inline-flex items-center gap-2 text-[12.5px] text-dim">
          <Switch checked={plan.requireSignoff} onCheckedChange={(v) => act('', { requireSignoff: v }, 'patch')} aria-label="Require my sign-off" />
          Require my sign-off
        </label>
        {!plan.running && !compact ? (
          <Button size="icon-sm" variant="ghost" aria-label="Delete plan" onClick={() => { if (window.confirm(`Delete the plan "${plan.title}"?`)) { m.mutate({ path: '', method: 'del' }, { onSuccess: () => onDeleted?.() }); } }}><Trash2 /></Button>
        ) : null}
      </div>

      <ol className="m-0 grid list-none gap-2 p-0">
        {plan.tasks.map((t, i) => <TaskRow key={t.id} plan={plan} task={t} index={i} act={act} busy={m.isPending} />)}
      </ol>
    </div>
  );
}

// ── list ────────────────────────────────────────────────────────────────────

export function usePlans() {
  return useQuery({ queryKey: ['plans'], queryFn: () => api.get<{ plans: PlanMeta[] }>('/api/plans'), refetchInterval: 15000 });
}

export function PlanList({ plans, selected, onSelect }: { plans: PlanMeta[]; selected: string | null; onSelect: (id: string) => void }) {
  if (!plans.length) return <Empty title="No plans yet">Record a Show &amp; tell, pick elements with Edit in browser, or start a big request with <kbd>+</kbd>.</Empty>;
  return (
    <ul className="m-0 grid min-w-0 list-none grid-cols-[minmax(0,1fr)] gap-1.5 p-0">
      {plans.map((p) => {
        const attention = (p.counts.awaiting_approval || 0) + (p.counts.blocked || 0);
        return (
          <li key={p.id} className="min-w-0">
            <button type="button" onClick={() => onSelect(p.id)} aria-current={selected === p.id} title={p.title}
              className={cn('grid w-full min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5 overflow-hidden rounded-xl border px-3 py-2.5 text-left transition-colors', selected === p.id ? 'border-accent/45 bg-accent/5' : 'border-line bg-raised hover:border-line-strong')}>
              <div className="flex items-start gap-2">
                <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{p.title}</span>
                {attention ? <span className={cn(pill, 'border-violet/40 bg-violet/10 text-violet')}>{attention}</span> : null}
              </div>
              <ProgressStrip counts={p.counts} total={p.taskCount} />
              <div className="flex items-center gap-2 text-[11.5px] text-faint"><PlanStatusPill status={p.status} /><span>{p.counts.done || 0}/{p.taskCount}</span><span className="ml-auto">{relTime(p.updatedAt)}</span></div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ── create ────────────────────────────────────────────────────────────────────

function planToMeta(plan: PlanFull): PlanMeta {
  return {
    id: plan.id, title: plan.title, summary: plan.summary, source: plan.source, workspace: plan.workspace,
    requireSignoff: plan.requireSignoff, status: plan.status, started: plan.started, paused: plan.paused,
    running: plan.running, convId: plan.convId, createdAt: plan.createdAt, updatedAt: plan.updatedAt,
    taskCount: plan.tasks.length, counts: countsOf(plan.tasks),
  };
}

/**
 * Inline create-plan form. A plan needs a title and at least one task title
 * (the backend rejects an empty task list), so the first task is required and
 * more can be added before submitting. On success the new plan is pushed into
 * the list cache and the caller navigates to it; on failure the error is shown
 * and nothing is navigated.
 */
export function NewPlan({ onCreated }: { onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [tasks, setTasks] = useState<string[]>(['']);

  const m = useMutation({
    mutationFn: (body: { title: string; summary?: string; tasks: { title: string }[] }) => api.post<PlanFull>('/api/plans', body),
    onSuccess: (plan) => {
      qc.setQueryData<{ plans: PlanMeta[] }>(['plans'], (old) => ({ plans: [planToMeta(plan), ...(old?.plans ?? [])] }));
      setOpen(false); setTitle(''); setSummary(''); setTasks(['']);
      onCreated(plan.id);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!open) {
    return <Button variant="default" className="w-full justify-start" onClick={() => setOpen(true)}><Plus />New plan</Button>;
  }

  const setTask = (i: number, v: string) => setTasks((prev) => prev.map((t, k) => (k === i ? v : t)));
  const removeTask = (i: number) => setTasks((prev) => (prev.length > 1 ? prev.filter((_, k) => k !== i) : prev));
  const canSubmit = title.trim().length > 0 && tasks.some((t) => t.trim());
  const submit = () => m.mutate({
    title: title.trim(),
    summary: summary.trim() || undefined,
    tasks: tasks.map((t) => ({ title: t.trim() })).filter((t) => t.title),
  });

  return (
    <form className="grid gap-2.5 rounded-xl border border-line bg-raised p-3" onSubmit={(e) => { e.preventDefault(); if (canSubmit) submit(); }}>
      <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus placeholder="Plan title" aria-label="Plan title" />
      <textarea className={cn(field, 'min-h-16 resize-y')} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="What should this plan accomplish? (optional)" aria-label="Plan summary" />
      <div className="grid gap-1.5">
        <span className="text-[12px] font-medium text-dim">Tasks</span>
        {tasks.map((t, i) => (
          <div key={i} className="flex gap-1.5">
            <Input value={t} onChange={(e) => setTask(i, e.target.value)} placeholder={`Task ${i + 1} title`} aria-label={`Task ${i + 1} title`} />
            {tasks.length > 1 ? <Button size="icon-sm" variant="ghost" type="button" aria-label="Remove task" onClick={() => removeTask(i)}><X /></Button> : null}
          </div>
        ))}
        <Button size="sm" variant="ghost" type="button" className="justify-self-start" onClick={() => setTasks((prev) => [...prev, ''])}><Plus />Add task</Button>
      </div>
      <div className="flex gap-2">
        <Button size="sm" type="submit" variant="primary" disabled={!canSubmit || m.isPending}>{m.isPending ? <Spinner className="size-3.5" /> : <Check />}Create plan</Button>
        <Button size="sm" variant="ghost" type="button" onClick={() => { setOpen(false); setTitle(''); setSummary(''); setTasks(['']); }}>Cancel</Button>
      </div>
    </form>
  );
}

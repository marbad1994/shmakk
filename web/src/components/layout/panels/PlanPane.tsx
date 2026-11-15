import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Circle, CircleDashed, CircleSlash, Loader2, ListChecks, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { cn, relTime } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, Spinner } from '@/components/ui/misc';

type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';
interface Task { id: string; title: string; description?: string; status: TaskStatus; completedAt?: string | null }
interface Plan { id?: string; title: string; status: string; tasks: Task[]; updatedAt?: string }
interface Journal { status: string; input?: string; profile?: string; touchedFiles: string[]; updatedAt?: number | string }

const MARK: Record<TaskStatus, React.ReactNode> = {
  pending: <CircleDashed />,
  in_progress: <Loader2 className="animate-spin" />,
  completed: <CheckCircle2 />,
  failed: <XCircle />,
  skipped: <CircleSlash />,
};
const TONE: Record<TaskStatus, string> = {
  pending: 'text-faint',
  in_progress: 'text-accent',
  completed: 'text-accent',
  failed: 'text-danger',
  skipped: 'text-dim',
};

/** Read-only mirror of the active plan and the resume journal. */
export function PlanPane() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['plan'], queryFn: () => api.get<{ plan: Plan | null; journal: Journal | null }>('/api/plan'), refetchInterval: 3000 });
  const clear = useMutation({
    mutationFn: (what: 'plan' | 'journal') => api.del(`/api/${what}`),
    onSuccess: () => { toast.success('Cleared'); void qc.invalidateQueries({ queryKey: ['plan'] }); },
    onError: (e: Error) => toast.error(e.message),
  });
  const plan = data?.plan ?? null;
  const journal = data?.journal ?? null;

  if (isLoading) return <div className="grid h-full place-items-center"><Spinner className="size-5" /></div>;
  if (!plan) {
    return <div className="p-4"><Empty icon={<ListChecks />} title="No active plan">Ask for something big and shmakk breaks it into steps you approve first. Progress shows up here.</Empty></div>;
  }

  const done = plan.tasks.filter((t) => t.status === 'completed').length;
  const pct = plan.tasks.length ? Math.round((done / plan.tasks.length) * 100) : 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-line px-3 py-2.5">
        <div className="flex items-start gap-2">
          <h3 className="m-0 min-w-0 flex-1 text-[13.5px] font-semibold leading-snug">{plan.title}</h3>
          <Badge tone={plan.status === 'pending_approval' ? 'warn' : plan.status === 'running' ? 'info' : 'ok'}>{plan.status.replace('_', ' ')}</Badge>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-raised" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Plan progress">
            <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${pct}%` }} />
          </div>
          <span className="shrink-0 font-mono text-[11px] text-faint">{done}/{plan.tasks.length}</span>
          {plan.status !== 'running' ? <Button variant="ghost" size="sm" onClick={() => clear.mutate('plan')}>Clear</Button> : null}
        </div>
        {plan.status === 'pending_approval' ? <p className="m-0 mt-2 text-[12px] text-warn">Waiting for your approval in the chat.</p> : null}
      </div>

      <ol className="m-0 min-h-0 flex-1 list-none overflow-y-auto p-2">
        {plan.tasks.map((t) => (
          <li key={t.id} className="flex items-start gap-2 rounded-lg px-1.5 py-1.5 hover:bg-hover">
            <span className={cn('mt-0.5 shrink-0 [&_svg]:size-3.5', TONE[t.status] || 'text-faint')} aria-label={t.status}>{MARK[t.status] || <Circle />}</span>
            <div className={cn('min-w-0 flex-1 text-[13px]', t.status === 'skipped' && 'text-faint line-through', t.status === 'completed' && 'text-dim')}>
              <div className="leading-snug">{t.title}</div>
              {t.description && t.status !== 'completed' ? <div className="mt-0.5 text-[12px] leading-snug text-faint">{t.description}</div> : null}
            </div>
            <span className="shrink-0 font-mono text-[10.5px] text-faint">{t.id}</span>
          </li>
        ))}
      </ol>

      {journal ? (
        <div className="shrink-0 border-t border-line px-3 py-2 text-[11.5px] text-faint">
          <span className="text-dim">Resume journal:</span> {journal.status}
          {journal.touchedFiles.length ? ` · ${journal.touchedFiles.length} files touched` : ''}
          {journal.updatedAt ? ` · ${relTime(journal.updatedAt)}` : ''}
        </div>
      ) : null}
    </div>
  );
}

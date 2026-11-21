import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { Status } from '@/lib/types';
import { relTime } from '@/lib/utils';
import { useApp } from '@/store/app';
import { Button } from '@/components/ui/button';
import { Empty } from '@/components/ui/misc';
import { NewPlan, PlanDetail, PlanList, usePlans } from '@/components/work/PlanBoard';
import { Loading, Page, Section } from './Page';

/**
 * Plans: every task is executed by the agent, reviewed against its acceptance
 * criteria, and only then (with your sign-off, by default) counted as done.
 */
export function PlanView() {
  const qc = useQueryClient();
  const focus = useApp((s) => s.focusPlanId);
  const openPlan = useApp((s) => s.openPlan);
  const { data, isLoading } = usePlans();
  const plans = data?.plans ?? [];
  const selected = focus && plans.some((p) => p.id === focus) ? focus : plans[0]?.id ?? null;
  useEffect(() => { if (!focus && plans[0]) openPlan(plans[0].id); }, [focus, plans, openPlan]);

  const journal = useQuery({ queryKey: ['journal'], queryFn: () => api.get<{ journal: Status['journal'] }>('/api/plan') });
  const clearJournal = useMutation({
    mutationFn: () => api.del('/api/journal'),
    onSuccess: () => { toast.success('Cleared'); void qc.invalidateQueries({ queryKey: ['journal'] }); },
  });

  return (
    <Page lead="Each task runs, gets its diff reviewed against its acceptance criteria, and is only done once it passes and you sign off. Failed reviews go back to the agent with the reviewer's notes.">
      <div className="grid items-start gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
        <Section title="Plans" className="min-w-0">
          <NewPlan onCreated={openPlan} />
          {isLoading ? <Loading /> : <PlanList plans={plans} selected={selected} onSelect={(id) => openPlan(id)} />}
        </Section>
        <Section title="Plan" className="min-w-0">
          {selected ? <PlanDetail key={selected} planId={selected} onDeleted={() => openPlan(null)} /> : (
            <Empty title="Nothing selected">Plans you create show up on the left.</Empty>
          )}
        </Section>
      </div>

      {journal.data?.journal ? (
        <details className="rounded-xl border border-line px-4 py-2.5 text-[13px] text-dim">
          <summary className="flex cursor-pointer list-none items-center gap-2">
            <span className="font-medium text-fg">Resume journal</span>
            <span>{journal.data.journal.status} · updated {relTime(journal.data.journal.updatedAt)} · {journal.data.journal.touchedFiles.length} files touched</span>
            <Button variant="ghost" size="sm" className="ml-auto" onClick={(e) => { e.preventDefault(); clearJournal.mutate(); }}>Clear</Button>
          </summary>
          <p className="m-0 mt-2 text-[12px] text-faint">If a run is interrupted, the next request can pick up from here.</p>
          <p className="m-0 mt-2 line-clamp-4 whitespace-pre-wrap break-words text-[12.5px]">{journal.data.journal.input || '—'}</p>
          {journal.data.journal.touchedFiles.length ? <p className="m-0 mt-2 break-all text-[12px] text-faint">{journal.data.journal.touchedFiles.slice(-30).join('  ')}</p> : null}
        </details>
      ) : null}
    </Page>
  );
}

import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { Status } from '@/lib/types';
import { relTime } from '@/lib/utils';
import { useApp } from '@/store/app';
import { Button } from '@/components/ui/button';
import { Empty } from '@/components/ui/misc';
import { PlanDetail, PlanList, usePlans } from '@/components/work/PlanBoard';
import { Loading, Page, Row, Rows, Section } from './Page';

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
        <Section title="Plans" className="lg:sticky lg:top-0">
          {isLoading ? <Loading /> : <PlanList plans={plans} selected={selected} onSelect={(id) => openPlan(id)} />}
        </Section>
        <Section title="Plan">
          {selected ? <PlanDetail key={selected} planId={selected} onDeleted={() => openPlan(null)} /> : (
            <Empty title="Nothing selected">Plans you create show up on the left.</Empty>
          )}
        </Section>
      </div>

      <Section title="Resume journal" aside={journal.data?.journal ? <Button variant="ghost" size="sm" onClick={() => clearJournal.mutate()}>Clear journal</Button> : null}>
        {journal.data?.journal ? (
          <Rows>
            <Row title="Status" sub={`Updated ${relTime(journal.data.journal.updatedAt)} · profile ${journal.data.journal.profile}`}><span className="text-[12px] text-dim">{journal.data.journal.status}</span></Row>
            <Row title="Request" sub={journal.data.journal.input || '—'} />
            <Row title={`Touched files · ${journal.data.journal.touchedFiles.length}`} sub={<span className="break-all text-[12.5px]">{journal.data.journal.touchedFiles.slice(-30).join('  ') || 'none'}</span>} />
          </Rows>
        ) : <Empty title="Nothing to resume">The journal is written while a task runs and cleared when it finishes cleanly.</Empty>}
      </Section>
    </Page>
  );
}

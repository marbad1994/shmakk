import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ListChecks } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { Plan, Status } from '@/lib/types';
import { relTime } from '@/lib/utils';
import { useApp } from '@/store/app';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty } from '@/components/ui/misc';
import { PlanCard } from '@/components/chat/Items';
import { Loading, Page, Row, Rows, Section } from './Page';

export function PlanView() {
  const qc = useQueryClient();
  const setDraft = useApp((s) => s.setDraft);
  const { data, isLoading } = useQuery({ queryKey: ['plan'], queryFn: () => api.get<{ plan: Plan | null; journal: Status['journal'] }>('/api/plan'), refetchInterval: 4000 });
  const clear = useMutation({
    mutationFn: (what: 'plan' | 'journal') => api.del(`/api/${what}`),
    onSuccess: () => { toast.success('Cleared'); void qc.invalidateQueries({ queryKey: ['plan'] }); },
  });

  return (
    <Page lead="Large requests are broken into a plan you approve before anything runs. Interrupted tasks keep a journal so the next request can pick up where the last one stopped.">
      <Section title="Active plan" aside={data?.plan ? <Button variant="ghost" size="sm" onClick={() => clear.mutate('plan')}>Clear plan</Button> : null}>
        {isLoading ? <Loading /> : data?.plan ? <PlanCard plan={data.plan} /> : (
          <Empty icon={<ListChecks />} title="No active plan">
            Describe a big piece of work — or start any message with <kbd>+</kbd> to force plan-first execution.
            <div className="mt-3"><Button size="sm" onClick={() => setDraft('+')}>Plan something</Button></div>
          </Empty>
        )}
      </Section>

      <Section title="Resume journal" aside={data?.journal ? <Button variant="ghost" size="sm" onClick={() => clear.mutate('journal')}>Clear journal</Button> : null}>
        {data?.journal ? (
          <Rows>
            <Row title="Status" sub={`Updated ${relTime(data.journal.updatedAt)} · profile ${data.journal.profile}`}><Badge tone={data.journal.status === 'running' ? 'info' : 'warn'}>{data.journal.status}</Badge></Row>
            <Row title="Request" sub={<span className="font-mono text-[12.5px]">{data.journal.input || '—'}</span>} />
            <Row title={`Touched files · ${data.journal.touchedFiles.length}`} sub={<span className="font-mono text-[12.5px] break-all">{data.journal.touchedFiles.slice(-30).join('  ') || 'none'}</span>} />
          </Rows>
        ) : <Empty title="Nothing to resume">The journal is written while a task runs and cleared when it finishes cleanly.</Empty>}
      </Section>
    </Page>
  );
}

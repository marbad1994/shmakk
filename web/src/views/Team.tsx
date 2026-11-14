import { useQuery } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import { api } from '@/lib/api';
import { useApp } from '@/store/app';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ExtTabs } from './ExtTabs';
import { Loading, Page, Section } from './Page';

interface Workflow { id: string; description: string; topology: string; steps: { role: string; task: string }[] }
interface Agents { agents: { role: string; profile: string; description: string }[]; specialists: { name: string; profile: string; indicator: string }[] }

export function TeamView() {
  const setDraft = useApp((s) => s.setDraft);
  const wf = useQuery({ queryKey: ['workflows'], queryFn: () => api.get<{ workflows: Workflow[] }>('/api/workflows') });
  const ag = useQuery({ queryKey: ['agents'], queryFn: () => api.get<Agents>('/api/agents') });

  return (
    <Page tabs={<ExtTabs />} lead="For work that spans several domains, a project-manager agent assembles a team of specialists and runs them in parallel or as a pipeline. Workflows are pre-built team recipes it matches automatically.">
      <Section title="Workflow templates">
        {wf.isLoading ? <Loading /> : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-2.5">
            {wf.data?.workflows.map((w) => (
              <article key={w.id} className="grid content-start gap-2 rounded-2xl border border-line bg-raised px-3.5 py-3">
                <div className="flex items-center gap-2"><h3 className="m-0 min-w-0 flex-1 truncate font-mono text-[13.5px] font-semibold">{w.id}</h3><Badge tone="violet">{w.topology}</Badge></div>
                <p className="m-0 text-[13px] text-dim">{w.description}</p>
                <ol className="m-0 grid list-none gap-1 p-0 text-[12.5px]">
                  {w.steps.map((s, i) => (
                    <li key={i} className="flex gap-2"><span className="w-20 shrink-0 font-mono font-semibold uppercase text-violet">{s.role}</span><span className="text-dim">{s.task.replace(/\{input\}/g, '‹your task›')}</span></li>
                  ))}
                </ol>
                <Button size="sm" className="justify-self-start" onClick={() => setDraft(`${w.id.replace(/-/g, ' ')}: `)}>Use this workflow<ArrowRight /></Button>
              </article>
            ))}
          </div>
        )}
      </Section>

      <Section title="Team roster">
        {ag.isLoading ? <Loading /> : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2.5">
            {ag.data?.agents.map((a) => (
              <div key={a.role} className="grid gap-1 rounded-2xl border border-line bg-raised px-3.5 py-3">
                <div className="flex items-center gap-2"><span className="flex-1 font-mono text-xs font-semibold uppercase tracking-wide text-violet">{a.role}</span><Badge>{a.profile}</Badge></div>
                <span className="text-[13px] text-dim">{a.description}</span>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Single-agent specialists">
        <p className="m-0 text-[13px] text-dim">Picked automatically from the wording of your request; each brings its own approach and profile.</p>
        <div className="flex flex-wrap gap-1.5">{ag.data?.specialists.map((s) => <Badge key={s.name} tone="violet">{s.indicator} · {s.profile}</Badge>)}</div>
      </Section>
    </Page>
  );
}

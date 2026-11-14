import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RotateCw } from 'lucide-react';
import { api } from '@/lib/api';
import { tildify } from '@/lib/utils';
import { useApp } from '@/store/app';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Empty } from '@/components/ui/misc';
import { Loading, Page, Section } from './Page';

type Ev = { t: string; kind: string } & Record<string, unknown>;

function tone(kind: string) {
  if (/declined|failed|error/.test(kind)) return 'danger' as const;
  if (/allowed|run|start/.test(kind)) return 'ok' as const;
  if (/proposed|decision/.test(kind)) return 'info' as const;
  return 'neutral' as const;
}

function detail(e: Ev) {
  const { t: _t, kind: _k, ...rest } = e;
  if (typeof rest.cmd === 'string') return rest.cmd;
  if (typeof rest.name === 'string') {
    const args = rest.args as Record<string, unknown> | undefined;
    return `${rest.name} ${args?.path || args?.cmd || args?.query || args?.url || ''}`.trim();
  }
  return JSON.stringify(rest).slice(0, 200);
}

export function ActivityView() {
  const home = useApp((s) => s.home);
  const status = useApp((s) => s.status);
  const [filter, setFilter] = useState('');
  const { data, isLoading, refetch, isFetching } = useQuery({ queryKey: ['audit'], queryFn: () => api.get<{ path: string; events: Ev[] }>('/api/audit?limit=400') });
  const events = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (data?.events || []).filter((e) => !f || JSON.stringify(e).toLowerCase().includes(f));
  }, [data, filter]);

  const stats: [string, string][] = status ? [
    ['Server pid', String(status.pid)],
    ['Uptime', `${Math.round(status.uptimeSec / 60)} min`],
    ['Resume status', status.journal?.status || 'none'],
    ['Active skill', status.activeSkill?.name || 'none'],
    ['Files changed', String(status.edits)],
    ['Audit events', String(status.auditEvents)],
    ['MCP', `${status.mcp.servers} servers · ${status.mcp.tools} tools`],
    ['Glossary', status.glossary.exists ? `${status.glossary.commands} commands` : 'not built'],
  ] : [];

  return (
    <Page lead="A local, append-only audit trail of everything shmakk proposed, ran, or was told not to." actions={<Button size="sm" onClick={() => refetch()}><RotateCw className={isFetching ? 'animate-spin' : undefined} />Refresh</Button>}>
      <Section title="Session stats">
        <div className="grid grid-cols-4 gap-2.5 max-md:grid-cols-2">
          {stats.map(([k, v]) => (
            <div key={k} className="rounded-2xl border border-line bg-raised px-3.5 py-2.5"><div className="font-mono text-[10.5px] font-semibold uppercase tracking-wider text-faint">{k}</div><div className="truncate font-mono text-[13px]">{v}</div></div>
          ))}
        </div>
      </Section>

      <Section title="Audit log" aside={data ? <span className="font-mono text-xs text-faint">{tildify(data.path, home)}</span> : null}>
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter events…" aria-label="Filter events" />
        {isLoading ? <Loading /> : events.length === 0 ? <Empty title="No events" /> : (
          <div className="max-h-[60vh] overflow-auto rounded-2xl border border-line bg-raised">
            <table className="w-full border-collapse text-[12.5px]">
              <thead><tr className="sticky top-0 bg-raised text-left font-mono text-[10.5px] uppercase tracking-wider text-faint"><th className="border-b border-line px-3 py-2">Time</th><th className="border-b border-line px-3 py-2">Event</th><th className="border-b border-line px-3 py-2">Detail</th></tr></thead>
              <tbody>
                {events.map((e, i) => (
                  <tr key={i} className="border-b border-line last:border-b-0">
                    <td className="whitespace-nowrap px-3 py-1.5 align-top font-mono text-faint">{new Date(e.t).toLocaleTimeString()}</td>
                    <td className="px-3 py-1.5 align-top"><Badge tone={tone(e.kind)}>{e.kind}</Badge></td>
                    <td className="break-all px-3 py-1.5 align-top font-mono text-dim">{detail(e)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </Page>
  );
}

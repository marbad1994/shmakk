import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { History, Search } from 'lucide-react';
import { api } from '@/lib/api';
import { relTime, tildify } from '@/lib/utils';
import { useApp } from '@/store/app';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Empty } from '@/components/ui/misc';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Loading, Page, Row, Rows, Section } from './Page';

interface Group { sessionId: string; startedAt: number; workspace: string; hits: { role: string; snippet: string }[] }
interface Session { id: string; started_at: number; ended_at: number | null; workspace: string; turn_count: number }
interface Stats { available: boolean; path?: string; sessions?: number; turns?: number; files?: number; error?: string }

/** FTS snippets mark matches as [term]; render those as highlights. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/\[(.*?)\]/g);
  return <>{parts.map((p, i) => (i % 2 ? <mark key={i} className="rounded-[3px] bg-accent/15 px-0.5 text-accent">{p}</mark> : p))}</>;
}

export function RecallView() {
  const home = useApp((s) => s.home);
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');
  const [viewing, setViewing] = useState<string | null>(null);
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => api.get<{ available: boolean; sessions: Session[]; stats: Stats }>('/api/sessions') });
  const search = useQuery({ queryKey: ['search', q], queryFn: () => api.get<{ available: boolean; total?: number; groups: Group[] }>(`/api/search?q=${encodeURIComponent(q)}`), enabled: !!q });
  const turns = useQuery({ queryKey: ['session', viewing], queryFn: () => api.get<{ turns: { role: string; content: string; ts?: number }[] }>(`/api/sessions/${encodeURIComponent(viewing!)}`), enabled: !!viewing });

  if (sessions.data && !sessions.data.available) {
    return (
      <Page>
        <Empty icon={<History />} title="Session recall isn’t available">
          Cross-session search needs the optional <code className="font-mono">better-sqlite3</code> module. Install it with <code className="font-mono">npm install better-sqlite3</code> in the shmakk package and restart.
          {sessions.data.stats.error ? <div className="mt-2 font-mono text-xs text-faint">{sessions.data.stats.error}</div> : null}
        </Empty>
      </Page>
    );
  }
  const stats = sessions.data?.stats;

  return (
    <Page lead="Everything you and shmakk have said, in the CLI or here, is indexed locally. Search it to find how you solved something before.">
      <form className="relative" onSubmit={(e) => { e.preventDefault(); setQ(input.trim()); }}>
        <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-faint" />
        <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Search past sessions — press Enter" className="pl-9" aria-label="Search sessions" />
      </form>

      {q ? (
        <Section title={search.data ? `${search.data.total ?? 0} hits in ${search.data.groups.length} sessions` : 'Searching…'}>
          {search.isLoading ? <Loading /> : search.data?.groups.length ? search.data.groups.map((g) => (
            <button key={g.sessionId} type="button" onClick={() => setViewing(g.sessionId)} className="grid gap-1.5 rounded-2xl border border-line bg-raised px-4 py-3 text-left hover:border-accent/40">
              <div className="flex items-center gap-2 text-xs text-faint">
                <span className="font-mono font-semibold text-fg">{g.sessionId}</span><span>{new Date(g.startedAt).toLocaleString()}</span>
                <span className="min-w-0 truncate font-mono">{tildify(g.workspace || '', home)}</span>
              </div>
              {g.hits.map((h, i) => <div key={i} className="text-[13px] text-dim"><span className="mr-2 font-mono text-[11px] uppercase text-faint">{h.role}</span><Snippet text={h.snippet} /></div>)}
            </button>
          )) : <Empty title={`No matches for “${q}”`} />}
        </Section>
      ) : null}

      <Section title="Recent sessions" aside={stats?.available ? <span className="font-mono text-xs text-faint">{stats.sessions} sessions · {stats.turns} turns</span> : null}>
        {sessions.isLoading ? <Loading /> : sessions.data?.sessions.length ? (
          <Rows>
            {sessions.data.sessions.map((s) => (
              <Row key={s.id} title={<button type="button" className="font-mono text-[13px] hover:text-accent" onClick={() => setViewing(s.id)}>{s.id}</button>} sub={<span className="font-mono text-xs">{tildify(s.workspace || 'unknown', home)}</span>}>
                <span className="text-xs text-faint">{s.turn_count} turns · {relTime(s.started_at)}</span>
                {s.ended_at ? null : <Badge tone="ok">active</Badge>}
              </Row>
            ))}
          </Rows>
        ) : <Empty title="No recorded sessions yet" />}
      </Section>

      <Dialog open={!!viewing} onOpenChange={(o) => { if (!o) setViewing(null); }}>
        <DialogContent className="w-[min(760px,calc(100vw-32px))]">
          <DialogHeader><DialogTitle className="font-mono">{viewing}</DialogTitle><DialogDescription>Recorded turns</DialogDescription></DialogHeader>
          <DialogBody>
            {turns.isLoading ? <Loading /> : turns.data?.turns.length ? turns.data.turns.map((t, i) => (
              <div key={i} className="grid gap-1 border-b border-line pb-3 last:border-b-0">
                <span className={t.role === 'user' ? 'font-mono text-[11px] font-semibold uppercase text-accent' : 'font-mono text-[11px] font-semibold uppercase text-violet'}>{t.role}</span>
                <div className="whitespace-pre-wrap break-words text-[13.5px]">{t.content}</div>
              </div>
            )) : <p className="m-0 text-dim">No turns recorded for this session.</p>}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </Page>
  );
}

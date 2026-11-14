import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Search, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { bytes, cn } from '@/lib/utils';
import { useApp } from '@/store/app';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Empty } from '@/components/ui/misc';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Markdown } from '@/components/chat/Markdown';
import { Loading, Page, Section } from './Page';

interface Skill { name: string; version: string; category: string; scope: string; description: string; active: boolean; bytes: number }
interface SkillsData { active: { name: string; version: string; loadedAt?: string } | null; total: number; categories: { id: string; label: string; blurb: string; count: number }[]; skills: Skill[] }

export function SkillsView() {
  const qc = useQueryClient();
  const refreshStatus = useApp((s) => s.refreshStatus);
  const { data, isLoading } = useQuery({ queryKey: ['skills'], queryFn: () => api.get<SkillsData>('/api/skills') });
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [global, setGlobal] = useState(false);

  const detail = useQuery({ queryKey: ['skill', viewing], queryFn: () => api.get<Skill & { content: string }>(`/api/skills/${encodeURIComponent(viewing!)}`), enabled: !!viewing });
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body: Record<string, unknown>; ok: string }) => api.post(path, body),
    onSuccess: (_r, v) => { toast.success(v.ok); void qc.invalidateQueries({ queryKey: ['skills'] }); void refreshStatus(); },
    onError: (e: Error) => toast.error(e.message),
  });

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.skills || []).filter((s) => (!cat || s.category === cat) && (!needle || s.name.includes(needle) || s.description.toLowerCase().includes(needle) || s.category.includes(needle)));
  }, [data, q, cat]);

  return (
    <Page lead="Skills are task-specific playbooks loaded into the agent’s context. Load one to steer every reply in this workspace; the team PM also picks from this catalog automatically.">
      {data?.active ? (
        <div className="flex items-center gap-3 rounded-2xl border border-accent/35 bg-accent/10 px-4 py-3">
          <Sparkles className="size-5 shrink-0 text-accent" />
          <div className="min-w-0 flex-1"><strong className="font-mono">{data.active.name}</strong><span className="ml-2 text-[13px] text-dim">is active for this workspace · v{data.active.version}</span></div>
          <Button size="sm" onClick={() => act.mutate({ path: '/api/skills/deactivate', body: {}, ok: 'Skill deactivated' })}>Deactivate</Button>
        </div>
      ) : null}

      <Section title="Install from URL">
        <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (url.trim()) act.mutate({ path: '/api/skills/install', body: { url: url.trim(), global }, ok: 'Skill installed and loaded' }, { onSuccess: () => setUrl('') }); }}>
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/skill.md" className="min-w-52 flex-1 font-mono text-[13px]" aria-label="Skill URL" />
          <label className="flex items-center gap-2 text-[13px] text-dim"><Switch checked={global} onCheckedChange={setGlobal} />global</label>
          <Button type="submit" disabled={!url.trim() || act.isPending}><Download />Install</Button>
        </form>
      </Section>

      <Section title={`Catalog${data ? ` · ${data.total}` : ''}`}>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-faint" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a skill…" className="pl-9" aria-label="Search skills" />
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button type="button" aria-pressed={!cat} onClick={() => setCat(null)} className={cn('rounded-full border border-line px-2.5 py-0.5 font-mono text-xs text-dim hover:bg-hover', !cat && 'border-accent/40 bg-accent/10 text-accent')}>all</button>
          {data?.categories.map((c) => (
            <button key={c.id} type="button" title={c.blurb} aria-pressed={cat === c.id} onClick={() => setCat(cat === c.id ? null : c.id)} className={cn('rounded-full border border-line px-2.5 py-0.5 font-mono text-xs text-dim hover:bg-hover', cat === c.id && 'border-accent/40 bg-accent/10 text-accent')}>
              {c.label.toLowerCase()} <span className="text-faint">{c.count}</span>
            </button>
          ))}
        </div>
        {isLoading ? <Loading /> : list.length === 0 ? (
          <Empty icon={<Sparkles />} title={data?.total ? 'No skills match' : 'No skills installed'}>
            {data?.total ? 'Try a different search or category.' : <>Run <code className="font-mono">npm run postinstall</code> in the shmakk package to install the built-in library, or install one from a URL above.</>}
          </Empty>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-2.5">
            {list.slice(0, 300).map((s) => (
              <article key={s.name} className={cn('grid content-start gap-1.5 rounded-2xl border border-line bg-raised px-3.5 py-3', s.active && 'border-accent/45 ring-1 ring-accent/30')}>
                <div className="flex min-w-0 items-center gap-2">
                  <h3 className="m-0 min-w-0 flex-1 truncate font-mono text-[13.5px] font-semibold">{s.name}</h3>
                  {s.active ? <Badge tone="ok">active</Badge> : null}
                </div>
                <p className="m-0 line-clamp-3 min-h-[3.9em] text-[13px] text-dim">{s.description || 'No description.'}</p>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                  <Badge>{s.category}</Badge>
                  {s.scope === 'workspace' ? <Badge tone="info">workspace</Badge> : null}
                  <span className="flex-1" />
                  <Button variant="ghost" size="sm" onClick={() => setViewing(s.name)}>View</Button>
                  {s.scope === 'workspace'
                    ? <Button size="sm" variant="danger" onClick={() => act.mutate({ path: '/api/skills/unload', body: { name: s.name }, ok: `Unloaded ${s.name}` })}>Unload</Button>
                    : <Button size="sm" onClick={() => act.mutate({ path: '/api/skills/load', body: { name: s.name }, ok: `Loaded ${s.name}` })}>Load</Button>}
                </div>
              </article>
            ))}
          </div>
        )}
        {list.length > 300 ? <p className="m-0 text-center text-[13px] text-faint">Showing 300 of {list.length} — narrow the search to see more.</p> : null}
      </Section>

      <Dialog open={!!viewing} onOpenChange={(o) => { if (!o) setViewing(null); }}>
        <DialogContent className="w-[min(780px,calc(100vw-32px))]">
          <DialogHeader>
            <DialogTitle className="font-mono">{viewing}</DialogTitle>
            <DialogDescription>{detail.data ? `${detail.data.category} · v${detail.data.version} · ${bytes(detail.data.bytes || detail.data.content.length)}` : 'Loading…'}</DialogDescription>
          </DialogHeader>
          <DialogBody>{detail.data ? <Markdown text={detail.data.content.replace(/^---[\s\S]*?---\s*/, '')} /> : <Loading />}</DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setViewing(null)}>Close</Button>
            <Button onClick={() => { act.mutate({ path: '/api/skills/load', body: { name: viewing, global: true }, ok: `Loaded ${viewing} globally` }); setViewing(null); }}>Load globally</Button>
            <Button variant="primary" onClick={() => { act.mutate({ path: '/api/skills/load', body: { name: viewing }, ok: `Loaded ${viewing}` }); setViewing(null); }}>Load for this workspace</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  );
}

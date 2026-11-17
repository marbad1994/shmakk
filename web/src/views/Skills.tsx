import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Briefcase, BookOpen, Check, ChevronRight, CalendarCheck, Clapperboard, Code2, Database, FileText, Link2, Map, MoreHorizontal, Palette,
  Plus, Rocket, Search, Server, ShieldCheck, Shapes, Smartphone, Sparkles, SquarePen, Telescope, Terminal, Upload, Workflow, X,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { bytes, cn } from '@/lib/utils';
import { useApp } from '@/store/app';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/input';
import { Empty } from '@/components/ui/misc';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Markdown } from '@/components/chat/Markdown';
import { ExtTabs } from './ExtTabs';
import { Loading, Page } from './Page';

interface Skill { name: string; version: string; category: string; scope: string; description: string; active: boolean; bytes: number }
interface SkillsData { active: { name: string; version: string } | null; total: number; categories: { id: string; label: string; blurb: string; count: number }[]; skills: Skill[] }

// ── presentation ────────────────────────────────────────────────────────

const ICONS: Record<string, React.ReactNode> = {
  dev: <Code2 />, frontend: <Code2 />, backend: <Server />, database: <Database />, devops: <Rocket />, security: <ShieldCheck />,
  design: <Palette />, docs: <BookOpen />, research: <Telescope />, files: <FileText />, system: <Terminal />, business: <Briefcase />,
  productivity: <CalendarCheck />, media: <Clapperboard />, planning: <Map />, workflow: <Workflow />, diagrams: <Shapes />, mobile: <Smartphone />,
};
const TONES = ['bg-accent/12 text-accent', 'bg-info/12 text-info', 'bg-violet/12 text-violet', 'bg-warn/12 text-warn'];
const toneFor = (cat: string) => TONES[[...cat].reduce((n, c) => n + c.charCodeAt(0), 0) % TONES.length];

function SkillIcon({ category, size = 'md', className }: { category: string; size?: 'md' | 'lg'; className?: string }) {
  return (
    <span className={cn('grid shrink-0 place-items-center rounded-xl', size === 'lg' ? 'size-12 [&_svg]:size-6' : 'size-10 [&_svg]:size-5', toneFor(category), className)} aria-hidden>
      {ICONS[category] ?? <Sparkles />}
    </span>
  );
}

const PREVIEW_PER_CATEGORY = 6;
const PAGE = 40;

// ── dialogs ─────────────────────────────────────────────────────────────

function InstallDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange(o: boolean): void; onDone(): void }) {
  const [url, setUrl] = useState('');
  const [global, setGlobal] = useState(false);
  const install = useMutation({
    mutationFn: () => api.post('/api/skills/install', { url: url.trim(), global }),
    onSuccess: () => { toast.success('Skill installed'); setUrl(''); onOpenChange(false); onDone(); },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form className="flex min-h-0 flex-col" onSubmit={(e) => { e.preventDefault(); if (url.trim()) install.mutate(); }}>
          <DialogHeader><DialogTitle>Install from URL</DialogTitle><DialogDescription>Download a skill’s markdown file, check it, and load it.</DialogDescription></DialogHeader>
          <DialogBody>
            <Field label="Skill URL" htmlFor="skill-url"><Input id="skill-url" autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/skill.md" className="font-mono text-[13px]" autoCapitalize="off" spellCheck={false} /></Field>
            <label className="flex items-center gap-2.5 text-[13.5px]"><Switch checked={global} onCheckedChange={setGlobal} />Make available in every workspace</label>
          </DialogBody>
          <DialogFooter><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" type="submit" disabled={!url.trim() || install.isPending}>{install.isPending ? 'Installing…' : 'Install'}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CreateDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange(o: boolean): void; onDone(): void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [steps, setSteps] = useState('');
  const [global, setGlobal] = useState(false);
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const create = useMutation({
    mutationFn: () => {
      const title = name.trim();
      const raw = `---\nname: ${slug}\ndescription: ${description.trim().replace(/\n+/g, ' ')}\nversion: 1\n---\n# ${title}\n\n## When to use\n${description.trim()}\n\n## Instructions\n${steps.trim()}\n`;
      return api.post('/api/skills/import', { raw, name: slug, global });
    },
    onSuccess: () => { toast.success(`Created ${slug}`); setName(''); setDescription(''); setSteps(''); onOpenChange(false); onDone(); },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="md:w-[min(620px,calc(100vw-32px))]">
        <form className="flex min-h-0 flex-col" onSubmit={(e) => { e.preventDefault(); if (slug && description.trim() && steps.trim()) create.mutate(); }}>
          <DialogHeader><DialogTitle>Create skill</DialogTitle><DialogDescription>Write down how you want a kind of task done. shmakk follows it whenever the skill is active.</DialogDescription></DialogHeader>
          <DialogBody>
            <Field label="Name" htmlFor="sk-name" hint={slug ? <>Saved as <span className="font-mono">{slug}.md</span></> : undefined}><Input id="sk-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Release checklist" /></Field>
            <Field label="When should it be used?" htmlFor="sk-desc"><Input id="sk-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Preparing and tagging a new release" /></Field>
            <Field label="Instructions" htmlFor="sk-steps"><Textarea id="sk-steps" value={steps} onChange={(e) => setSteps(e.target.value)} className="min-h-40 font-sans" placeholder={'1. Run the full test suite\n2. Update CHANGELOG.md\n3. Tag the release'} /></Field>
            <label className="flex items-center gap-2.5 text-[13.5px]"><Switch checked={global} onCheckedChange={setGlobal} />Make available in every workspace</label>
          </DialogBody>
          <DialogFooter><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" type="submit" disabled={!slug || !description.trim() || !steps.trim() || create.isPending}>{create.isPending ? 'Creating…' : 'Create skill'}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── rows & tiles ────────────────────────────────────────────────────────

function SkillRow({ skill, onOpen, onLoad, onMenu }: { skill: Skill; onOpen(): void; onLoad(): void; onMenu: React.ReactNode }) {
  const installed = skill.scope === 'workspace';
  return (
    <div className="group flex min-w-0 items-center gap-3.5 rounded-2xl px-2 py-2 hover:bg-raised">
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3.5 text-left touch:min-h-12" aria-label={`${skill.name} — details`}>
        <SkillIcon category={skill.category} />
        <span className="grid min-w-0 gap-px">
          <span className="flex items-center gap-2"><span className="truncate font-semibold">{skill.name}</span>{skill.active ? <Badge tone="ok" className="px-1.5 text-[10px] leading-4">active</Badge> : null}</span>
          <span className="truncate text-[13.5px] text-dim">{skill.description || 'No description.'}</span>
        </span>
      </button>
      {installed ? onMenu : (
        <Button variant="ghost" size="icon" aria-label={`Load ${skill.name}`} onClick={onLoad} className="rounded-full text-dim hover:text-accent"><Plus /></Button>
      )}
    </div>
  );
}

export function SkillsView() {
  const qc = useQueryClient();
  const refreshStatus = useApp((s) => s.refreshStatus);
  const { data, isLoading } = useQuery({ queryKey: ['skills'], queryFn: () => api.get<SkillsData>('/api/skills') });
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<string | null>(null);
  const [showInstalled, setShowInstalled] = useState(true);
  const [limit, setLimit] = useState(PAGE);
  const [viewing, setViewing] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'url' | 'create' | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = () => { void qc.invalidateQueries({ queryKey: ['skills'] }); void refreshStatus(); };
  const detail = useQuery({ queryKey: ['skill', viewing], queryFn: () => api.get<Skill & { content: string }>(`/api/skills/${encodeURIComponent(viewing!)}`), enabled: !!viewing });
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body: Record<string, unknown>; ok: string }) => api.post(path, body),
    onSuccess: (_r, v) => { toast.success(v.ok); refresh(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const load = (name: string, global = false) => act.mutate({ path: '/api/skills/load', body: { name, global }, ok: global ? `Loaded ${name} globally` : `Loaded ${name}` });
  const unload = (name: string) => act.mutate({ path: '/api/skills/unload', body: { name }, ok: `Unloaded ${name}` });
  const deactivate = () => act.mutate({ path: '/api/skills/deactivate', body: {}, ok: 'Skill deactivated' });

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const raw = await file.text();
      await api.post('/api/skills/import', { raw, name: file.name.replace(/\.md$/i, '') });
      toast.success(`Added ${file.name}`);
      refresh();
    } catch (e) { toast.error((e as Error).message); }
    if (fileRef.current) fileRef.current.value = '';
  };

  const needle = q.trim().toLowerCase();
  const catLabel = (id: string) => data?.categories.find((c) => c.id === id)?.label ?? id;
  const all = data?.skills ?? [];
  const installed = useMemo(() => all.filter((s) => s.scope === 'workspace').sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name)), [all]);
  const filtered = useMemo(
    () => all.filter((s) => (!cat || s.category === cat) && (!needle || s.name.includes(needle) || s.description.toLowerCase().includes(needle) || s.category.includes(needle))),
    [all, cat, needle],
  );
  // Overview (no search, no category): a short preview of every category.
  const overview = !needle && !cat;
  const groups = useMemo(() => (data?.categories ?? []).map((c) => ({ ...c, skills: all.filter((s) => s.category === c.id) })).filter((g) => g.skills.length), [data, all]);

  const menu = (s: Skill) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label={`Options for ${s.name}`} className="rounded-full text-dim"><MoreHorizontal /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => setViewing(s.name)}><BookOpen />View</DropdownMenuItem>
        {s.active ? <DropdownMenuItem onSelect={deactivate}><X />Deactivate</DropdownMenuItem> : <DropdownMenuItem onSelect={() => load(s.name)}><Check />Make active</DropdownMenuItem>}
        <DropdownMenuSeparator />
        <DropdownMenuItem danger onSelect={() => unload(s.name)}><X />Remove from workspace</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
  const row = (s: Skill) => <SkillRow key={s.name} skill={s} onOpen={() => setViewing(s.name)} onLoad={() => load(s.name)} onMenu={menu(s)} />;
  const current = detail.data;
  const currentInstalled = !!current && all.find((s) => s.name === current.name)?.scope === 'workspace';

  return (
    <Page>
      <div className="flex items-center justify-between gap-3">
        <ExtTabs />
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button className="rounded-full bg-fg text-bg hover:bg-fg/90 hover:border-transparent">Add<ChevronRight className="rotate-90" /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuItem onSelect={() => setDialog('create')}><SquarePen />Create skill</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => fileRef.current?.click()}><Upload />Upload skill file</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setDialog('url')}><Link2 />Install from URL</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <input ref={fileRef} type="file" accept=".md,text/markdown,text/plain" hidden onChange={(e) => void onFile(e.target.files?.[0])} />
      </div>

      <div className="grid gap-1.5">
        <h2 className="m-0 text-[28px] font-semibold tracking-tight max-md:text-2xl">Skills</h2>
        <p className="m-0 text-[15px] text-dim">Playbooks that tell shmakk how you like a kind of task done. Load one and it steers every reply in this workspace.</p>
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-4 top-1/2 size-4.5 -translate-y-1/2 text-faint" />
        <Input value={q} onChange={(e) => { setQ(e.target.value); setLimit(PAGE); }} placeholder="Search skills" aria-label="Search skills" className="h-12 rounded-full pl-11 text-[15px] touch:h-12" />
        {q ? <button type="button" aria-label="Clear search" onClick={() => setQ('')} className="absolute right-3 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-full text-faint hover:bg-hover hover:text-fg"><X className="size-4" /></button> : null}
      </div>

      {isLoading ? <Loading /> : (
        <>
          {installed.length && !needle ? (
            <section className="grid gap-3" aria-label="Installed skills">
              <button type="button" onClick={() => setShowInstalled((v) => !v)} aria-expanded={showInstalled} className="flex w-fit items-center gap-1.5 text-[17px] font-semibold">
                Installed<span className="font-mono text-xs font-normal text-faint">{installed.length}</span><ChevronRight className={cn('size-4 text-faint transition-transform', showInstalled && 'rotate-90')} />
              </button>
              {showInstalled ? (
                <div className="no-scrollbar -mx-1 flex gap-2.5 overflow-x-auto px-1 pb-1 [scroll-snap-type:x_proximity]">
                  {installed.map((s) => (
                    <button key={s.name} type="button" onClick={() => setViewing(s.name)} aria-label={`${s.name}${s.active ? ' (active)' : ''}`} className="group relative grid w-[76px] shrink-0 snap-start justify-items-center gap-1.5 rounded-2xl p-1.5 hover:bg-raised">
                      <SkillIcon category={s.category} size="lg" className={cn(s.active && 'ring-2 ring-accent ring-offset-2 ring-offset-bg')} />
                      <span className="w-full truncate text-center text-[11.5px] text-dim group-hover:text-fg">{s.name}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </section>
          ) : null}

          <div className="no-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1" role="toolbar" aria-label="Categories">
            {[{ id: null as string | null, label: 'All' }, ...(data?.categories ?? [])].map((c) => (
              <button key={c.id ?? 'all'} type="button" aria-pressed={cat === c.id} title={'blurb' in c ? c.blurb : undefined} onClick={() => { setCat(c.id); setLimit(PAGE); }}
                className={cn('shrink-0 rounded-full border border-line bg-raised px-4 py-1.5 text-[13.5px] font-medium text-dim hover:text-fg touch:py-2.5', cat === c.id && 'border-transparent bg-fg text-bg hover:text-bg')}>
                {c.label}
              </button>
            ))}
          </div>

          {all.length === 0 ? (
            <Empty icon={<Sparkles />} title="No skills yet">Create one with <strong>Add</strong>, or run <code className="font-mono">npm run postinstall</code> in the shmakk package to install the built-in library.</Empty>
          ) : overview ? (
            groups.map((g) => (
              <section key={g.id} className="grid gap-1.5" aria-label={g.label}>
                <button type="button" onClick={() => { setCat(g.id); setLimit(PAGE); }} className="group flex w-fit items-center gap-1.5 text-[17px] font-semibold">
                  {g.label}<span className="font-mono text-xs font-normal text-faint">{g.count}</span><ChevronRight className="size-4 text-faint transition-transform group-hover:translate-x-0.5" />
                </button>
                <div className="grid grid-cols-2 gap-x-8 max-md:grid-cols-1">{g.skills.slice(0, PREVIEW_PER_CATEGORY).map(row)}</div>
                {g.skills.length > PREVIEW_PER_CATEGORY ? <button type="button" onClick={() => { setCat(g.id); setLimit(PAGE); }} className="w-fit rounded-full px-2 py-1 text-[13px] text-dim hover:text-accent">See all {g.skills.length}</button> : null}
              </section>
            ))
          ) : filtered.length === 0 ? (
            <Empty icon={<Search />} title={`No skills match${needle ? ` “${q.trim()}”` : ''}`}>Try a different word, or pick another category.</Empty>
          ) : (
            <section className="grid gap-1.5" aria-label="Results">
              <h3 className="m-0 text-[17px] font-semibold">{cat ? catLabel(cat) : 'Results'}<span className="ml-2 font-mono text-xs font-normal text-faint">{filtered.length}</span></h3>
              <div className="grid grid-cols-2 gap-x-8 max-md:grid-cols-1">{filtered.slice(0, limit).map(row)}</div>
              {filtered.length > limit ? <Button className="mt-2 justify-self-center rounded-full" onClick={() => setLimit((l) => l + PAGE)}>Show more</Button> : null}
            </section>
          )}
        </>
      )}

      <InstallDialog open={dialog === 'url'} onOpenChange={(o) => setDialog(o ? 'url' : null)} onDone={refresh} />
      <CreateDialog open={dialog === 'create'} onOpenChange={(o) => setDialog(o ? 'create' : null)} onDone={refresh} />

      <Dialog open={!!viewing} onOpenChange={(o) => { if (!o) setViewing(null); }}>
        <DialogContent className="md:w-[min(780px,calc(100vw-32px))]">
          <DialogHeader>
            <div className="flex items-center gap-3.5">
              {current ? <SkillIcon category={current.category} size="lg" /> : null}
              <div className="grid min-w-0 gap-0.5">
                <DialogTitle className="truncate">{viewing}</DialogTitle>
                <DialogDescription>{current ? `${catLabel(current.category)} · v${current.version} · ${bytes(current.bytes || current.content.length)}` : 'Loading…'}</DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <DialogBody>{current ? <Markdown text={current.content.replace(/^---[\s\S]*?---\s*/, '')} /> : <Loading />}</DialogBody>
          <DialogFooter>
            {currentInstalled ? (
              <>
                <Button variant="danger" onClick={() => { unload(viewing!); setViewing(null); }}>Remove from workspace</Button>
                {all.find((s) => s.name === viewing)?.active
                  ? <Button onClick={() => { deactivate(); setViewing(null); }}>Deactivate</Button>
                  : <Button variant="primary" onClick={() => { load(viewing!); setViewing(null); }}>Make active</Button>}
              </>
            ) : (
              <>
                <Button variant="ghost" onClick={() => setViewing(null)}>Close</Button>
                <Button variant="primary" onClick={() => { load(viewing!); setViewing(null); }}>Load for this workspace</Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  );
}

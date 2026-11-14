import { useMemo, useState } from 'react';
import {
  Activity, Brain, ChevronsUpDown, FileDiff, Folder, FolderKanban, FolderMinus, GitBranch, History, ListChecks, MoreHorizontal, PanelLeftClose,
  Pencil, Pin, PinOff, Plug, Plus, Search, Settings, Sparkles, Trash2, Users, Zap,
} from 'lucide-react';
import { api } from '@/lib/api';
import { MODES, PROJECT_COLORS, modeInfo } from '@/lib/modes';
import type { ConvMeta, Project, ViewId } from '@/lib/types';
import { basename, cn, dayBucket, modKey, tildify } from '@/lib/utils';
import { haptic } from '@/hooks/useMobile';
import { chooseWorkspace, useApp } from '@/store/app';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { Field, Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

// Workspace tools belong to the modes that work in a workspace.
const NAV: { id: ViewId; label: string; icon: React.ReactNode }[] = [
  { id: 'skills', label: 'Skills', icon: <Sparkles /> },
  { id: 'memory', label: 'Memory', icon: <Brain /> },
  { id: 'plan', label: 'Plan', icon: <ListChecks /> },
  { id: 'changes', label: 'Changes', icon: <FileDiff /> },
  { id: 'recall', label: 'Recall', icon: <History /> },
  { id: 'team', label: 'Team', icon: <Users /> },
  { id: 'mcp', label: 'MCP', icon: <Plug /> },
  { id: 'activity', label: 'Activity', icon: <Activity /> },
];

function ConvRow({ conv, active, running, projects, onRename }: { conv: ConvMeta; active: boolean; running: boolean; projects: Project[]; onRename(c: ConvMeta): void }) {
  const openConv = useApp((s) => s.openConv);
  const pinConv = useApp((s) => s.pinConv);
  const deleteConv = useApp((s) => s.deleteConv);
  const moveConv = useApp((s) => s.moveConv);
  const project = projects.find((p) => p.id === conv.projectId);
  return (
    <div role="listitem" className={cn('group relative flex items-center rounded-lg text-dim hover:bg-hover hover:text-fg', active && 'bg-raised text-fg shadow-[inset_2px_0_0_var(--accent)]')}>
      <button type="button" aria-current={active || undefined} onClick={() => openConv(conv.id)} className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-2.5 pr-1 text-left touch:py-2.5 touch:text-[15px]">
        {running ? <span className="size-[7px] shrink-0 animate-pulse rounded-full bg-accent" aria-label="Running" /> : null}
        {conv.repo ? <GitBranch className="size-3.5 shrink-0 text-violet" aria-label={`GitHub session on ${conv.repo.fullName}`} /> : null}
        {conv.automationId ? <Zap className="size-3.5 shrink-0 text-warn" aria-label="Automation run" /> : null}
        <span className="truncate">{conv.title}</span>
        {project ? <span className={cn('ml-auto size-2 shrink-0 rounded-full', PROJECT_COLORS[project.color] || 'bg-accent')} title={`In project ${project.name}`} /> : null}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label={`Options for ${conv.title}`} className="mr-1 grid size-6 shrink-0 place-items-center rounded-md text-faint opacity-0 hover:bg-line hover:text-fg focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 touch:size-9 touch:opacity-100">
            <MoreHorizontal className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={() => onRename(conv)}><Pencil />Rename</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => pinConv(conv.id, !conv.pinned)}>{conv.pinned ? <PinOff /> : <Pin />}{conv.pinned ? 'Unpin' : 'Pin'}</DropdownMenuItem>
          {projects.length ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Project</DropdownMenuLabel>
              {projects.filter((p) => p.id !== conv.projectId).slice(0, 8).map((p) => (
                <DropdownMenuItem key={p.id} onSelect={() => void moveConv(conv.id, p.id)}><span className={cn('size-2.5 rounded-full', PROJECT_COLORS[p.color])} />Move to {p.name}</DropdownMenuItem>
              ))}
              {conv.projectId ? <DropdownMenuItem onSelect={() => void moveConv(conv.id, null)}><FolderMinus />Remove from project</DropdownMenuItem> : null}
            </>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem danger onSelect={() => { if (!conv.repo || confirm(`Delete this session and its clone of ${conv.repo.fullName}? Unpushed work will be lost.`)) void deleteConv(conv.id); }}><Trash2 />{conv.repo ? 'Delete session & clone' : 'Delete'}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function Sidebar() {
  const convs = useApp((s) => s.convs);
  const runs = useApp((s) => s.runs);
  const activeId = useApp((s) => s.activeId);
  const view = useApp((s) => s.view);
  const mode = useApp((s) => s.mode);
  const projects = useApp((s) => s.projects);
  const projectId = useApp((s) => s.projectId);
  const workspace = useApp((s) => s.workspace);
  const home = useApp((s) => s.home);
  const edits = useApp((s) => s.status?.edits ?? 0);
  const { newChat, setView, setMode, setPalette, toggleSidebar, renameConv, openProject, refreshProjects } = useApp.getState();
  const [renaming, setRenaming] = useState<ConvMeta | null>(null);
  const [title, setTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ name: '', description: '', shareContext: true });
  const info = modeInfo(mode);
  const usesWorkspace = mode === 'code' || mode === 'cowork';

  const groups = useMemo(() => {
    const mine = convs.filter((c) => c.mode === mode);
    const out: { label: string; list: ConvMeta[] }[] = [];
    const pinned = mine.filter((c) => c.pinned);
    if (pinned.length) out.push({ label: 'Pinned', list: pinned });
    const autoRuns = mine.filter((c) => !c.pinned && c.automationId);
    for (const c of mine.filter((x) => !x.pinned && !x.automationId)) {
      const label = dayBucket(c.updatedAt);
      const g = out.find((x) => x.label === label);
      if (g) g.list.push(c); else out.push({ label, list: [c] });
    }
    if (autoRuns.length) out.push({ label: 'Automation runs', list: autoRuns.slice(0, 15) });
    return out;
  }, [convs, mode]);

  const createProject = async () => {
    if (!draft.name.trim()) return;
    const p = await api.post<Project>('/api/projects', draft);
    await refreshProjects();
    setCreating(false);
    setDraft({ name: '', description: '', shareContext: true });
    openProject(p.id);
  };

  const navBtn = 'flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left text-dim hover:bg-hover hover:text-fg';
  const navOn = 'bg-accent/10 text-accent hover:bg-accent/10 hover:text-accent';

  return (
    <aside aria-label="Navigation" className="flex h-full w-[272px] flex-col border-r border-line bg-panel pb-[var(--sab)] pl-[var(--sal)] pt-[var(--sat)] max-lg:w-[min(320px,86vw)]">
      <div className="drag flex min-h-12 items-center justify-between pb-1.5 pr-3 pt-3" style={{ paddingLeft: 'calc(14px + var(--titlebar-pad, 0px))' }}>
        <button type="button" onClick={() => newChat()} aria-label="shmakk — new chat" className="inline-flex items-baseline gap-1.5 rounded-lg px-1.5 py-1 font-mono text-base font-bold tracking-tight hover:bg-hover">
          <span className="text-accent" aria-hidden>❯</span>shmakk<span className="h-[15px] w-2 animate-blink self-center rounded-[1px] bg-accent" aria-hidden />
        </button>
        <Tip label={<>Hide sidebar <kbd>{modKey} B</kbd></>}><Button variant="ghost" size="icon" aria-label="Hide sidebar" className="max-md:hidden" onClick={() => toggleSidebar(false)}><PanelLeftClose /></Button></Tip>
      </div>

      {/* The four spaces */}
      <div role="tablist" aria-label="Mode" className="mx-2.5 mb-1 grid grid-cols-4 gap-0.5 rounded-xl border border-line bg-sunken p-[3px]">
        {MODES.map((m) => (
          <Tip key={m.id} label={m.tagline}>
            <button type="button" role="tab" aria-selected={mode === m.id} onClick={() => { haptic(); setMode(m.id); }}
              className={cn('grid justify-items-center gap-0.5 rounded-[9px] py-1.5 text-[10.5px] font-medium text-faint hover:text-fg touch:py-2 touch:text-[11px] [&_svg]:size-[17px]', mode === m.id && cn('bg-raised shadow-sm', m.tone))}>
              {m.icon}{m.label}
            </button>
          </Tip>
        ))}
      </div>

      <div className="grid gap-1 px-2.5 pb-1 pt-1.5">
        <button type="button" onClick={() => newChat()} className="flex w-full items-center gap-2.5 rounded-[10px] border border-line bg-raised px-2.5 py-2 text-left font-medium hover:border-accent/40">
          <Plus className={cn('size-4', info.tone)} />{info.newLabel}<kbd className="ml-auto touch:hidden">{modKey} N</kbd>
        </button>
        {mode === 'code' ? (
          <button type="button" aria-current={view === 'github' ? 'page' : undefined} onClick={() => setView('github')} className={cn(navBtn, view === 'github' && navOn)}><GitBranch className="size-4" />GitHub sessions</button>
        ) : null}
        {mode === 'cowork' ? (
          <button type="button" aria-current={view === 'automations' ? 'page' : undefined} onClick={() => setView('automations')} className={cn(navBtn, view === 'automations' && navOn)}><Zap className="size-4" />Automations</button>
        ) : null}
        <button type="button" onClick={() => setPalette(true)} className={navBtn}><Search className="size-4" />Search &amp; commands<kbd className="ml-auto touch:hidden">{modKey} K</kbd></button>
      </div>

      {usesWorkspace ? (
        <nav aria-label="Workspace tools" className="grid grid-cols-4 gap-1 border-b border-line px-2.5 py-1.5">
          {NAV.map((n) => (
            <button key={n.id} type="button" aria-current={view === n.id ? 'page' : undefined} onClick={() => setView(n.id)}
              className={cn('relative grid justify-items-center gap-0.5 rounded-[10px] px-0.5 pb-1.5 pt-2 text-[10.5px] text-dim hover:bg-hover hover:text-fg touch:pb-2 touch:pt-2.5 touch:text-[11px] [&_svg]:size-[17px]', view === n.id && navOn)}>
              {n.icon}{n.label}
              {n.id === 'changes' && edits > 0 ? <span className="absolute right-2 top-1 h-[15px] min-w-[15px] rounded-full bg-accent px-1 text-center font-mono text-[9.5px] font-semibold leading-[15px] text-accent-ink">{edits}</span> : null}
            </button>
          ))}
        </nav>
      ) : <div className="mx-2.5 border-b border-line" />}

      <div className="scroll-touch min-h-0 flex-1 overflow-y-auto px-2.5 pb-3 pt-1">
        {/* Projects span every mode */}
        <div className="flex items-center justify-between px-2 pb-1 pt-3">
          <span className="font-mono text-[10.5px] font-semibold uppercase tracking-wider text-faint">Projects</span>
          <Tip label="New project"><button type="button" aria-label="New project" onClick={() => setCreating(true)} className="grid size-5 place-items-center rounded text-faint hover:bg-hover hover:text-fg touch:size-8"><Plus className="size-3.5" /></button></Tip>
        </div>
        {projects.length === 0 ? (
          <button type="button" onClick={() => setCreating(true)} className="w-full rounded-lg px-2 py-1.5 text-left text-[13px] text-faint hover:bg-hover hover:text-fg">Group chats from every mode — and let them share context.</button>
        ) : projects.map((p) => (
          <button key={p.id} type="button" aria-current={view === 'project' && projectId === p.id ? 'page' : undefined} onClick={() => openProject(p.id)}
            className={cn('flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-dim hover:bg-hover hover:text-fg touch:py-2.5 touch:text-[15px]', view === 'project' && projectId === p.id && 'bg-raised text-fg')}>
            <FolderKanban className="size-4 shrink-0" /><span className="min-w-0 flex-1 truncate">{p.name}</span>
            <span className={cn('size-2 shrink-0 rounded-full', PROJECT_COLORS[p.color] || 'bg-accent')} />
          </button>
        ))}

        <div role="list" aria-label={`${info.label} conversations`}>
          {groups.length === 0 ? <p className="px-2 pb-2 pt-4 text-[13px] text-faint">Nothing in {info.label} yet. {info.tagline}.</p> : null}
          {groups.map((g) => (
            <div key={g.label}>
              <div className="px-2 pb-1.5 pt-3.5 font-mono text-[10.5px] font-semibold uppercase tracking-wider text-faint">{g.label}</div>
              {g.list.map((c) => (
                <ConvRow key={c.id} conv={c} projects={projects} active={view === 'chat' && c.id === activeId} running={c.id in runs} onRename={(x) => { setRenaming(x); setTitle(x.title); }} />
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-0.5 border-t border-line px-2.5 py-2">
        {usesWorkspace ? (
          <button type="button" onClick={() => void chooseWorkspace()} className="flex w-full items-center gap-2.5 rounded-[10px] p-2 text-left text-dim hover:bg-hover hover:text-fg">
            <Folder className="size-4 shrink-0" />
            <span className="grid min-w-0 flex-1 leading-tight">
              <span className="truncate font-medium text-fg">{basename(workspace)}</span>
              <span className="truncate font-mono text-[11px] text-faint">{tildify(workspace, home)}</span>
            </span>
            <ChevronsUpDown className="size-4 shrink-0" />
          </button>
        ) : null}
        <button type="button" aria-current={view === 'settings' ? 'page' : undefined} onClick={() => setView('settings')} className={cn('flex w-full items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-left text-dim hover:bg-hover hover:text-fg', view === 'settings' && 'bg-accent/10 text-accent')}>
          <Settings className="size-4" />Settings
        </button>
      </div>

      <Dialog open={!!renaming} onOpenChange={(o) => { if (!o) setRenaming(null); }}>
        <DialogContent>
          <form onSubmit={(e) => { e.preventDefault(); if (renaming && title.trim()) void renameConv(renaming.id, title.trim()); setRenaming(null); }}>
            <DialogHeader><DialogTitle>Rename conversation</DialogTitle></DialogHeader>
            <DialogBody><Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" /></DialogBody>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setRenaming(null)}>Cancel</Button>
              <Button variant="primary" type="submit">Rename</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <form className="flex min-h-0 flex-col" onSubmit={(e) => { e.preventDefault(); void createProject(); }}>
            <DialogHeader>
              <DialogTitle>New project</DialogTitle>
              <DialogDescription>A project holds chats from every mode — design it, build it, and automate it in one place.</DialogDescription>
            </DialogHeader>
            <DialogBody>
              <Field label="Name" htmlFor="proj-name"><Input id="proj-name" autoFocus value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Website relaunch" /></Field>
              <Field label="What is it about? (optional)" htmlFor="proj-desc"><Input id="proj-desc" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></Field>
              <label className="flex items-start gap-3 rounded-xl border border-line bg-sunken p-3">
                <Switch checked={draft.shareContext} onCheckedChange={(v) => setDraft({ ...draft, shareContext: v })} className="mt-0.5" />
                <span className="grid gap-0.5"><span className="font-medium">Share context between chats</span><span className="text-[13px] text-dim">Chats in this project can see what the others decided and made. You can change this any time.</span></span>
              </label>
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
              <Button variant="primary" type="submit" disabled={!draft.name.trim()}>Create project</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </aside>
  );
}

import { useMemo, useState } from 'react';
import {
  Activity, Brain, ChevronsUpDown, FileDiff, Folder, ListChecks, MoreHorizontal, PanelLeftClose, Pencil, Pin, PinOff, Plug, Plus, Search,
  Settings, Sparkles, Trash2, Users, History,
} from 'lucide-react';
import type { ConvMeta, ViewId } from '@/lib/types';
import { basename, cn, dayBucket, modKey, tildify } from '@/lib/utils';
import { chooseWorkspace, useApp } from '@/store/app';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { Input } from '@/components/ui/input';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

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

function ConvRow({ conv, active, running, onRename }: { conv: ConvMeta; active: boolean; running: boolean; onRename(c: ConvMeta): void }) {
  const openConv = useApp((s) => s.openConv);
  const pinConv = useApp((s) => s.pinConv);
  const deleteConv = useApp((s) => s.deleteConv);
  return (
    <div role="listitem" className={cn('group relative flex items-center rounded-lg text-dim hover:bg-hover hover:text-fg', active && 'bg-raised text-fg shadow-[inset_2px_0_0_var(--accent)]')}>
      <button type="button" aria-current={active || undefined} onClick={() => openConv(conv.id)} className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-2.5 pr-1 text-left touch:py-2.5 touch:text-[15px]">
        {running ? <span className="size-[7px] shrink-0 animate-pulse rounded-full bg-accent" aria-label="Running" /> : null}
        <span className="truncate">{conv.title}</span>
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
          <DropdownMenuSeparator />
          <DropdownMenuItem danger onSelect={() => deleteConv(conv.id)}><Trash2 />Delete</DropdownMenuItem>
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
  const workspace = useApp((s) => s.workspace);
  const home = useApp((s) => s.home);
  const edits = useApp((s) => s.status?.edits ?? 0);
  const newChat = useApp((s) => s.newChat);
  const setView = useApp((s) => s.setView);
  const setPalette = useApp((s) => s.setPalette);
  const toggleSidebar = useApp((s) => s.toggleSidebar);
  const renameConv = useApp((s) => s.renameConv);
  const [renaming, setRenaming] = useState<ConvMeta | null>(null);
  const [title, setTitle] = useState('');

  const groups = useMemo(() => {
    const out: { label: string; list: ConvMeta[] }[] = [];
    const pinned = convs.filter((c) => c.pinned);
    if (pinned.length) out.push({ label: 'Pinned', list: pinned });
    for (const c of convs.filter((x) => !x.pinned)) {
      const label = dayBucket(c.updatedAt);
      const g = out.find((x) => x.label === label);
      if (g) g.list.push(c); else out.push({ label, list: [c] });
    }
    return out;
  }, [convs]);

  return (
    <aside aria-label="Navigation" className="flex h-full w-[272px] flex-col border-r border-line bg-panel pb-[var(--sab)] pl-[var(--sal)] pt-[var(--sat)] max-lg:w-[min(320px,86vw)]">
      <div className="drag flex min-h-12 items-center justify-between pb-1.5 pr-3 pt-3" style={{ paddingLeft: 'calc(14px + var(--titlebar-pad, 0px))' }}>
        <button type="button" onClick={newChat} aria-label="shmakk — new chat" className="inline-flex items-baseline gap-1.5 rounded-lg px-1.5 py-1 font-mono text-base font-bold tracking-tight hover:bg-hover">
          <span className="text-accent" aria-hidden>❯</span>shmakk<span className="h-[15px] w-2 animate-blink self-center rounded-[1px] bg-accent" aria-hidden />
        </button>
        <Tip label={<>Hide sidebar <kbd>{modKey} B</kbd></>}><Button variant="ghost" size="icon" aria-label="Hide sidebar" className="max-md:hidden" onClick={() => toggleSidebar(false)}><PanelLeftClose /></Button></Tip>
      </div>

      <div className="grid gap-1 px-2.5 pb-1 pt-1.5">
        <button type="button" onClick={newChat} className="flex w-full items-center gap-2.5 rounded-[10px] border border-line bg-raised px-2.5 py-2 text-left font-medium hover:border-accent/40">
          <Plus className="size-4 text-accent" />New chat<kbd className="ml-auto touch:hidden">{modKey} N</kbd>
        </button>
        <button type="button" onClick={() => setPalette(true)} className="flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left text-dim hover:bg-hover hover:text-fg">
          <Search className="size-4" />Search &amp; commands<kbd className="ml-auto touch:hidden">{modKey} K</kbd>
        </button>
      </div>

      <nav aria-label="Workspace tools" className="grid grid-cols-4 gap-1 border-b border-line px-2.5 py-1.5">
        {NAV.map((n) => (
          <button
            key={n.id}
            type="button"
            aria-current={view === n.id ? 'page' : undefined}
            onClick={() => setView(n.id)}
            className={cn('relative grid justify-items-center gap-0.5 rounded-[10px] px-0.5 pb-1.5 pt-2 text-[10.5px] text-dim touch:pb-2 touch:pt-2.5 touch:text-[11px] hover:bg-hover hover:text-fg [&_svg]:size-[17px]', view === n.id && 'bg-accent/10 text-accent hover:bg-accent/10 hover:text-accent')}
          >
            {n.icon}{n.label}
            {n.id === 'changes' && edits > 0 ? <span className="absolute right-2 top-1 h-[15px] min-w-[15px] rounded-full bg-accent px-1 text-center font-mono text-[9.5px] font-semibold leading-[15px] text-accent-ink">{edits}</span> : null}
          </button>
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3 pt-1" role="list" aria-label="Conversations">
        {groups.length === 0 ? <p className="px-2 py-4 text-[13px] text-faint">No conversations yet. Everything you ask shmakk shows up here.</p> : null}
        {groups.map((g) => (
          <div key={g.label}>
            <div className="px-2 pb-1.5 pt-3.5 font-mono text-[10.5px] font-semibold uppercase tracking-wider text-faint">{g.label}</div>
            {g.list.map((c) => (
              <ConvRow key={c.id} conv={c} active={view === 'chat' && c.id === activeId} running={c.id in runs} onRename={(x) => { setRenaming(x); setTitle(x.title); }} />
            ))}
          </div>
        ))}
      </div>

      <div className="grid gap-0.5 border-t border-line px-2.5 py-2">
        <button type="button" onClick={() => void chooseWorkspace()} className="flex w-full items-center gap-2.5 rounded-[10px] p-2 text-left text-dim hover:bg-hover hover:text-fg">
          <Folder className="size-4 shrink-0" />
          <span className="grid min-w-0 flex-1 leading-tight">
            <span className="truncate font-medium text-fg">{basename(workspace)}</span>
            <span className="truncate font-mono text-[11px] text-faint">{tildify(workspace, home)}</span>
          </span>
          <ChevronsUpDown className="size-4 shrink-0" />
        </button>
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
    </aside>
  );
}

import { ArrowRightLeft, Check, Cloud, CloudOff, Copy, FolderMinus, GitBranch, MoreHorizontal, Pencil, Pin, PinOff, Radio, Trash2, Zap } from 'lucide-react';
import type { ConvMeta, Project } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useApp } from '@/store/app';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { PROJECT_COLORS } from '@/lib/modes';

interface ConvRowProps {
  conv: ConvMeta;
  active: boolean;
  running: boolean;
  projects: Project[];
  onRename: (c: ConvMeta) => void;
  showProject?: boolean;
}

export function ConvRow({ conv, active, running, projects, onRename, showProject = true }: ConvRowProps) {
  const openConv = useApp((s) => s.openConv);
  const pinConv = useApp((s) => s.pinConv);
  const deleteConv = useApp((s) => s.deleteConv);
  const moveConv = useApp((s) => s.moveConv);
  const transferConv = useApp((s) => s.transferConv);
  const setExposed = useApp((s) => s.setExposed);
  const nodeOf = useApp((s) => s.nodeOf);
  const nodes = useApp((s) => s.nodes);
  const tunnel = useApp((s) => s.tunnel);
  const settings = useApp((s) => s.settings);
  const project = projects.find((p) => p.id === conv.projectId);
  const node = nodeOf(conv.id);
  const cloudAvailable = nodes.some((n) => n.kind === 'cloud');
  // Exposing needs the reverse tunnel, which only works when an SSH host and
  // remote port are configured (a cloud node with a URL/token alone can't reach
  // back into this computer).
  const canExpose = cloudAvailable && !!settings.cloud?.sshHost && !!settings.cloud?.remotePort;
  const exposed = tunnel.exposed.includes(conv.id);

  return (
    <div role="listitem" className={cn('group relative flex items-center rounded-lg text-dim hover:bg-hover hover:text-fg', active && 'bg-raised text-fg shadow-[inset_2px_0_0_var(--accent)]')}>
      <button type="button" aria-current={active || undefined} onClick={() => openConv(conv.id)} className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-2.5 pr-1 text-left touch:py-2.5 touch:text-[15px]">
        {running ? <span className="size-[7px] shrink-0 animate-pulse rounded-full bg-accent" aria-label="Running" /> : null}
        {conv.repo ? <GitBranch className="size-3.5 shrink-0 text-violet" aria-label={`GitHub session on ${conv.repo.fullName}`} /> : null}
        {conv.automationId ? <Zap className="size-3.5 shrink-0 text-warn" aria-label="Automation run" /> : null}
        {node === 'cloud' ? <Cloud className="size-3.5 shrink-0 text-accent" aria-label="Cloud session" /> : null}
        {conv.remote ? <Radio className="size-3.5 shrink-0 text-accent" aria-label="Remote session" /> : null}
        <span className="truncate">{conv.title}</span>
        {showProject && project ? <span className={cn('ml-auto size-2 shrink-0 rounded-full', PROJECT_COLORS[project.color] || 'bg-accent')} title={`In project ${project.name}`} /> : null}
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
          {cloudAvailable && !conv.remote ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{node === 'cloud' ? 'Send to this computer' : 'Send to cloud'}</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => void transferConv(conv.id, 'copy')}><Copy />Copy</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void transferConv(conv.id, 'move')}><ArrowRightLeft />Move</DropdownMenuItem>
            </>
          ) : null}
          {node === 'local' && canExpose ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Expose to cloud</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => void setExposed(conv.id, !exposed)}>
                {exposed ? <Check /> : <CloudOff />}{exposed ? 'Stop exposing' : 'Expose to cloud'}
              </DropdownMenuItem>
              <DropdownMenuItem disabled>
                <span className={cn('size-2 rounded-full', tunnel.up ? 'bg-accent' : 'bg-line')} />Reverse tunnel {tunnel.up ? 'up' : 'down'}
              </DropdownMenuItem>
            </>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem danger onSelect={() => { if (!conv.repo || confirm(`Delete this session and its clone of ${conv.repo.fullName}? Unpushed work will be lost.`)) void deleteConv(conv.id); }}><Trash2 />{conv.repo ? 'Delete session & clone' : 'Delete'}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

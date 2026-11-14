import { Cpu, FileDiff, Folder, Gauge, Plug, ShieldCheck, Sparkles, SquareTerminal, Zap } from 'lucide-react';
import { cn, tildify } from '@/lib/utils';
import { chooseWorkspace, useApp } from '@/store/app';
import { Tip } from '@/components/ui/tooltip';

function Cell({ label, onClick, className, children }: { label: string; onClick?: () => void; className?: string; children: React.ReactNode }) {
  const cls = cn('inline-flex h-full min-w-0 items-center gap-1.5 px-2 [&_svg]:size-3 [&_svg]:shrink-0', onClick && 'hover:bg-hover hover:text-fg', className);
  return (
    <Tip label={label} side="top">
      {onClick ? <button type="button" onClick={onClick} className={cls}>{children}</button> : <span className={cls}>{children}</span>}
    </Tip>
  );
}

/** tmux-style strip: everything about the session at a glance, each cell a shortcut. */
export function StatusBar() {
  const online = useApp((s) => s.online);
  const workspace = useApp((s) => s.workspace);
  const home = useApp((s) => s.home);
  const provider = useApp((s) => s.provider);
  const settings = useApp((s) => s.settings);
  const status = useApp((s) => s.status);
  const version = useApp((s) => s.version);
  const dockOpen = useApp((s) => s.dockOpen);
  const setView = useApp((s) => s.setView);
  const patchSettings = useApp((s) => s.patchSettings);
  const toggleDock = useApp((s) => s.toggleDock);

  return (
    <footer aria-label="Status" className="flex h-[26px] shrink-0 items-center max-md:hidden overflow-hidden whitespace-nowrap border-t border-line bg-panel px-1.5 font-mono text-[11.5px] text-dim">
      <Cell label={online ? 'Connected to shmakk' : 'Reconnecting…'}>
        <span className={cn('size-[7px] rounded-full', online ? 'bg-accent shadow-[0_0_6px_var(--accent)]' : 'animate-pulse bg-danger')} />
        {online ? 'ready' : 'offline'}
      </Cell>
      <Cell label="Workspace — click to switch" onClick={() => void chooseWorkspace()}>
        <Folder /><span className="max-w-60 truncate">{tildify(workspace, home)}</span>
      </Cell>
      <Cell label={provider.configured ? `Model${provider.endpoint ? ` · endpoint ${provider.endpoint}` : ''} — click to change` : 'No model configured — click to set up'} onClick={() => setView('settings')} className={!provider.configured ? 'text-warn' : undefined}>
        <Cpu /><span className="max-w-52 truncate">{provider.configured ? provider.model || 'default model' : 'no model'}</span>
      </Cell>
      <Cell label="Profile" className="max-md:hidden"><Gauge />{settings.profile || 'auto'}</Cell>
      <Cell label={settings.review ? 'Review mode: every AI action needs confirmation' : 'Auto mode: safe actions run without asking'} onClick={() => patchSettings({ review: !settings.review })} className={settings.review ? 'text-accent' : undefined}>
        <ShieldCheck />{settings.review ? 'review' : 'auto'}
      </Cell>
      {settings.yesFiles ? <Cell label="File edits are auto-accepted" onClick={() => patchSettings({ yesFiles: false })} className="text-accent max-md:hidden"><Zap />yes-files</Cell> : null}
      {status?.activeSkill ? <Cell label="Active skill" onClick={() => setView('skills')} className="text-violet max-md:hidden"><Sparkles />{status.activeSkill.name}</Cell> : null}
      <span className="flex-1" />
      {status && status.edits > 0 ? <Cell label="Files changed this session" onClick={() => setView('changes')}><FileDiff />{status.edits}</Cell> : null}
      {status && status.mcp.servers > 0 ? <Cell label="MCP servers · tools" onClick={() => setView('mcp')} className="max-md:hidden"><Plug />{status.mcp.servers}·{status.mcp.tools}</Cell> : null}
      <Cell label="Terminal (Ctrl+`)" onClick={() => toggleDock()} className={dockOpen ? 'text-accent' : undefined}><SquareTerminal />terminal</Cell>
      <span className="px-2 text-faint max-md:hidden">v{version}</span>
    </footer>
  );
}

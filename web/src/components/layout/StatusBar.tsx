import { Cpu, FileDiff, Folder, Gauge, Plug, ShieldCheck, Sparkles, SquareTerminal, Zap } from 'lucide-react';
import { cn, tildify } from '@/lib/utils';
import { modeInfo } from '@/lib/modes';
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
  const mode = useApp((s) => s.mode);
  // Workspace, approvals and the terminal only exist in the agent modes.
  const agentic = mode === 'code' || mode === 'cowork';
  const setView = useApp((s) => s.setView);
  const patchSettings = useApp((s) => s.patchSettings);
  const toggleDock = useApp((s) => s.toggleDock);

  const activeModel = (settings.modelByMode?.[mode]) || provider.model || 'default model';

  return (
    <footer aria-label="Status" className="flex h-[26px] shrink-0 items-center max-md:hidden overflow-hidden whitespace-nowrap border-t border-line bg-panel px-1.5 font-mono text-[11.5px] text-dim">
      <Cell label={online ? 'Connected to shmakk' : 'Reconnecting…'}>
        <span className={cn('size-[7px] rounded-full', online ? 'bg-accent shadow-[0_0_6px_var(--accent)]' : 'animate-pulse bg-danger')} />
        {online ? 'ready' : 'offline'}
      </Cell>
      <Cell label={modeInfo(mode).tagline} className={modeInfo(mode).tone}>{modeInfo(mode).icon}{modeInfo(mode).label.toLowerCase()}</Cell>
      {agentic ? (
        <Cell label="Workspace — click to switch" onClick={() => void chooseWorkspace()}>
          <Folder /><span className="max-w-60 truncate">{tildify(workspace, home)}</span>
        </Cell>
      ) : null}
      <Cell label={provider.configured ? `Model for ${modeInfo(mode).label.toLowerCase()}${provider.endpoint ? ` · endpoint ${provider.endpoint}` : ''} — click to change` : 'No model configured — click to set up'} onClick={() => setView('settings')} className={!provider.configured ? 'text-warn' : undefined}>
        <Cpu /><span className="max-w-52 truncate">{provider.configured ? activeModel : 'no model'}</span>
      </Cell>
      {agentic ? <Cell label="Profile" className="max-md:hidden"><Gauge />{settings.profile || 'auto'}</Cell> : null}
      {agentic ? <Cell label={settings.review ? 'Review mode: every AI action needs confirmation' : 'Auto mode: safe actions run without asking'} onClick={() => patchSettings({ review: !settings.review })} className={settings.review ? 'text-accent' : undefined}>
        <ShieldCheck />{settings.review ? 'review' : 'auto'}
      </Cell> : null}
      {agentic && settings.yesFiles ? <Cell label="File edits are auto-accepted" onClick={() => patchSettings({ yesFiles: false })} className="text-accent max-md:hidden"><Zap />yes-files</Cell> : null}
      {agentic && status?.activeSkill ? <Cell label="Active skill" onClick={() => setView('skills')} className="text-violet max-md:hidden"><Sparkles />{status.activeSkill.name}</Cell> : null}
      <span className="flex-1" />
      {agentic && status && status.edits > 0 ? <Cell label="Files changed this session" onClick={() => setView('changes')}><FileDiff />{status.edits}</Cell> : null}
      {agentic && status && status.mcp.servers > 0 ? <Cell label="MCP servers · tools" onClick={() => setView('mcp')} className="max-md:hidden"><Plug />{status.mcp.servers}·{status.mcp.tools}</Cell> : null}
      {agentic ? <Cell label="Terminal (Ctrl+`)" onClick={() => toggleDock()} className={dockOpen ? 'text-accent' : undefined}><SquareTerminal />terminal</Cell> : null}
      <span className="px-2 text-faint max-md:hidden">v{version}</span>
    </footer>
  );
}

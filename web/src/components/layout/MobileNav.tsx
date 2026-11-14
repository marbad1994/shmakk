import { FileDiff, Menu, Sparkles, SquareTerminal, Zap } from 'lucide-react';
import { MODES, modeInfo } from '@/lib/modes';
import { cn } from '@/lib/utils';
import { haptic } from '@/hooks/useMobile';
import { useApp } from '@/store/app';

interface Tab { id: string; label: string; icon: React.ReactNode; active: boolean; badge?: number; dot?: boolean; onPress(): void }

/**
 * Bottom tab bar for phones. The first tab is always the current space's chat;
 * the middle tabs are the tools that space actually has; "More" opens the
 * drawer (mode switcher, projects, history, settings).
 */
export function MobileNav() {
  const view = useApp((s) => s.view);
  const mode = useApp((s) => s.mode);
  const dockOpen = useApp((s) => s.dockOpen);
  const edits = useApp((s) => s.status?.edits ?? 0);
  const running = useApp((s) => Object.keys(s.runs).length > 0);
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const { setView, toggleDock, toggleSidebar, setMode } = useApp.getState();
  const info = modeInfo(mode);
  const go = (v: Parameters<typeof setView>[0]) => () => { toggleDock(false); setView(v); };

  const tabs: Tab[] = [{ id: 'chat', label: info.label, icon: info.icon, active: view === 'chat' && !dockOpen, dot: running, onPress: go('chat') }];
  if (mode === 'code') {
    tabs.push(
      { id: 'skills', label: 'Skills', icon: <Sparkles />, active: view === 'skills' && !dockOpen, onPress: go('skills') },
      { id: 'changes', label: 'Changes', icon: <FileDiff />, active: view === 'changes' && !dockOpen, badge: edits, onPress: go('changes') },
      { id: 'terminal', label: 'Terminal', icon: <SquareTerminal />, active: dockOpen, onPress: () => toggleDock(!dockOpen) },
    );
  } else if (mode === 'cowork') {
    tabs.push(
      { id: 'automations', label: 'Automations', icon: <Zap />, active: view === 'automations' && !dockOpen, onPress: go('automations') },
      { id: 'changes', label: 'Changes', icon: <FileDiff />, active: view === 'changes' && !dockOpen, badge: edits, onPress: go('changes') },
    );
  } else {
    // Chat and Design have no tools of their own: offer the other spaces instead.
    for (const m of MODES.filter((x) => x.id !== mode).slice(0, 3)) tabs.push({ id: m.id, label: m.label, icon: m.icon, active: false, onPress: () => setMode(m.id) });
  }
  tabs.push({ id: 'more', label: 'More', icon: <Menu />, active: sidebarOpen, onPress: () => toggleSidebar(true) });

  return (
    <nav aria-label="Primary" className="flex shrink-0 border-t border-line bg-panel/95 pb-[var(--sab)] pl-[var(--sal)] pr-[var(--sar)] backdrop-blur md:hidden">
      {tabs.map((t) => (
        <button key={t.id} type="button" aria-current={t.active ? 'page' : undefined} onClick={() => { haptic(); t.onPress(); }}
          className={cn('relative grid h-[52px] min-w-0 flex-1 place-content-center justify-items-center gap-0.5 text-[10.5px] font-medium text-faint [&_svg]:size-[22px]', t.active && (t.id === 'chat' ? info.tone : 'text-accent'))}>
          <span className="relative">
            {t.icon}
            {t.badge ? <span className="absolute -right-2.5 -top-1.5 h-4 min-w-4 rounded-full bg-accent px-1 text-center font-mono text-[10px] font-semibold leading-4 text-accent-ink">{t.badge}</span> : null}
            {t.dot ? <span className="absolute -right-1 -top-0.5 size-2 animate-pulse rounded-full bg-accent" /> : null}
          </span>
          <span className="max-w-full truncate">{t.label}</span>
        </button>
      ))}
    </nav>
  );
}

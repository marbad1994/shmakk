import { FileDiff, Menu, MessageSquare, Sparkles, SquareTerminal } from 'lucide-react';
import { cn } from '@/lib/utils';
import { haptic } from '@/hooks/useMobile';
import { useApp } from '@/store/app';

/** Bottom tab bar for phones — thumb-reachable, like a native app. */
export function MobileNav() {
  const view = useApp((s) => s.view);
  const dockOpen = useApp((s) => s.dockOpen);
  const edits = useApp((s) => s.status?.edits ?? 0);
  const running = useApp((s) => Object.keys(s.runs).length > 0);
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const { setView, toggleDock, toggleSidebar } = useApp.getState();

  const tabs = [
    { id: 'chat', label: 'Chat', icon: <MessageSquare />, active: view === 'chat' && !dockOpen, dot: running, onPress: () => { toggleDock(false); setView('chat'); } },
    { id: 'skills', label: 'Skills', icon: <Sparkles />, active: view === 'skills' && !dockOpen, onPress: () => { toggleDock(false); setView('skills'); } },
    { id: 'changes', label: 'Changes', icon: <FileDiff />, active: view === 'changes' && !dockOpen, badge: edits, onPress: () => { toggleDock(false); setView('changes'); } },
    { id: 'terminal', label: 'Terminal', icon: <SquareTerminal />, active: dockOpen, onPress: () => toggleDock(!dockOpen) },
    { id: 'more', label: 'More', icon: <Menu />, active: sidebarOpen, onPress: () => toggleSidebar(true) },
  ];

  return (
    <nav aria-label="Primary" className="flex shrink-0 border-t border-line bg-panel/95 pb-[var(--sab)] pl-[var(--sal)] pr-[var(--sar)] backdrop-blur md:hidden">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          aria-current={t.active ? 'page' : undefined}
          onClick={() => { haptic(); t.onPress(); }}
          className={cn('relative grid h-[52px] flex-1 place-content-center justify-items-center gap-0.5 text-[10.5px] font-medium text-faint [&_svg]:size-[22px]', t.active && 'text-accent')}
        >
          <span className="relative">
            {t.icon}
            {t.badge ? <span className="absolute -right-2.5 -top-1.5 h-4 min-w-4 rounded-full bg-accent px-1 text-center font-mono text-[10px] font-semibold leading-4 text-accent-ink">{t.badge}</span> : null}
            {t.dot ? <span className="absolute -right-1 -top-0.5 size-2 animate-pulse rounded-full bg-accent" /> : null}
          </span>
          {t.label}
        </button>
      ))}
    </nav>
  );
}

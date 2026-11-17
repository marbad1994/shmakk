import { SquareTerminal } from 'lucide-react';
import { MODES } from '@/lib/modes';
import { cn } from '@/lib/utils';
import { haptic } from '@/hooks/useMobile';
import { useApp } from '@/store/app';

interface Tab { id: string; label: string; icon: React.ReactNode; active: boolean; tone?: string; onPress(): void }

/** Stable space switcher for phones, with the terminal always within reach. */
export function MobileNav() {
  const view = useApp((s) => s.view);
  const mode = useApp((s) => s.mode);
  const dockOpen = useApp((s) => s.dockOpen);
  const { toggleDock, toggleSidebar, toggleRight, setMode } = useApp.getState();
  const dismiss = () => { toggleSidebar(false); toggleRight(false); };
  const tabs: Tab[] = MODES.map((m) => ({
    id: m.id, label: m.label, icon: m.icon, tone: m.tone,
    active: view === 'chat' && mode === m.id && !dockOpen,
    onPress: () => { dismiss(); toggleDock(false); setMode(m.id); },
  }));
  tabs.push({ id: 'terminal', label: 'Terminal', icon: <SquareTerminal />, active: dockOpen,
    onPress: () => { dismiss(); toggleDock(true); } });

  return (
    <nav aria-label="Primary" className="flex shrink-0 border-t border-line bg-panel/95 pb-[var(--sab)] pl-[var(--sal)] pr-[var(--sar)] backdrop-blur md:hidden">
      {tabs.map((t) => (
        <button key={t.id} type="button" aria-current={t.active ? 'page' : undefined} onClick={() => { haptic(); t.onPress(); }}
          className={cn('relative grid h-[52px] min-w-0 flex-1 place-content-center justify-items-center gap-0.5 text-[10.5px] font-medium text-faint [&_svg]:size-[22px]', t.active && (t.tone || 'text-accent'))}>
          <span className="relative">
            {t.icon}

          </span>
          <span className="max-w-full truncate">{t.label}</span>
        </button>
      ))}
    </nav>
  );
}

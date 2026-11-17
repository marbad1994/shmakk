import { Plug, Sparkles, Users } from 'lucide-react';
import type { ViewId } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useApp } from '@/store/app';

const TABS: { id: ViewId; label: string; icon: React.ReactNode }[] = [
  { id: 'skills', label: 'Skills', icon: <Sparkles /> },
  { id: 'team', label: 'Agents', icon: <Users /> },
  { id: 'mcp', label: 'MCP', icon: <Plug /> },
];

/** Pill tabs shared by the "extend shmakk" pages: skills, agents & workflows, MCP. */
export function ExtTabs() {
  const view = useApp((s) => s.view);
  const setView = useApp((s) => s.setView);
  return (
    <div role="tablist" aria-label="Extensions" className="no-scrollbar flex gap-1 overflow-x-auto">
      {TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={view === t.id}
          onClick={() => setView(t.id)}
          className={cn(
            'inline-flex shrink-0 items-center gap-2 rounded-full px-4 py-1.5 text-[13.5px] font-medium text-dim hover:bg-hover hover:text-fg touch:py-2.5 [&_svg]:size-3.5',
            view === t.id && 'bg-raised text-fg shadow-sm ring-1 ring-line',
          )}
        >
          {t.icon}{t.label}
        </button>
      ))}
    </div>
  );
}

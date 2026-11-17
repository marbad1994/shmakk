import { lazy, Suspense, useEffect, useState } from 'react';
import { Eraser, FolderKanban, Menu, PanelLeft, SquarePen, SquareTerminal } from 'lucide-react';
import { PROJECT_COLORS, modeInfo } from '@/lib/modes';
import { useDrawerSwipe, useIsMobile, useVisualViewport } from '@/hooks/useMobile';
import { MobileNav } from '@/components/layout/MobileNav';
import { cn, modKey } from '@/lib/utils';
import type { ViewId } from '@/lib/types';
import { useApp } from '@/store/app';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/misc';
import { Tip } from '@/components/ui/tooltip';
import { Sidebar } from '@/components/layout/Sidebar';
import { CommandPalette } from '@/components/layout/CommandPalette';
import { FolderPicker } from '@/components/layout/FolderPicker';
import { PANES, RightDock } from '@/components/layout/RightDock';
import { ChatView } from '@/components/chat/ChatView';
import { HeaderSlotContext } from '@/components/layout/header-slot';

// Secondary screens and the terminal (xterm) load on demand.
const ProjectView = lazy(() => import('@/views/Project').then((m) => ({ default: m.ProjectView })));
const AutomationsView = lazy(() => import('@/views/Automations').then((m) => ({ default: m.AutomationsView })));
const GitHubView = lazy(() => import('@/views/GitHub').then((m) => ({ default: m.GitHubView })));
const SkillsView = lazy(() => import('@/views/Skills').then((m) => ({ default: m.SkillsView })));
const MemoryView = lazy(() => import('@/views/Memory').then((m) => ({ default: m.MemoryView })));
const PlanView = lazy(() => import('@/views/Plan').then((m) => ({ default: m.PlanView })));
const ChangesView = lazy(() => import('@/views/Changes').then((m) => ({ default: m.ChangesView })));
const RecallView = lazy(() => import('@/views/Recall').then((m) => ({ default: m.RecallView })));
const TeamView = lazy(() => import('@/views/Team').then((m) => ({ default: m.TeamView })));
const McpView = lazy(() => import('@/views/Mcp').then((m) => ({ default: m.McpView })));
const ActivityView = lazy(() => import('@/views/Activity').then((m) => ({ default: m.ActivityView })));
const ArtefactsView = lazy(() => import('@/views/Artefacts').then((m) => ({ default: m.ArtefactsView })));
const SettingsDialog = lazy(() => import('@/views/Settings').then((m) => ({ default: m.SettingsDialog })));
const TerminalDock = lazy(() => import('@/components/layout/TerminalDock').then((m) => ({ default: m.TerminalDock })));
const Show2Plan = lazy(() => import('@/components/showtell/Show2Plan').then((m) => ({ default: m.Show2Plan })));
const RecordingBar = lazy(() => import('@/components/showtell/RecordingBar').then((m) => ({ default: m.RecordingBar })));

const TITLES: Record<ViewId, string> = {
  chat: 'New chat', project: 'Project', automations: 'Automations', github: 'GitHub sessions', skills: 'Skills', memory: 'Memory & rules', plan: 'Plan & resume', changes: 'Changes',
  recall: 'Session recall', team: 'Agents & workflows', mcp: 'MCP servers', activity: 'Activity', artefacts: 'Artefacts', settings: 'Settings',
};

function View({ view }: { view: ViewId }) {
  switch (view) {
    case 'project': return <ProjectView />;
    case 'automations': return <AutomationsView />;
    case 'github': return <GitHubView />;
    case 'skills': return <SkillsView />;
    case 'memory': return <MemoryView />;
    case 'plan': return <PlanView />;
    case 'changes': return <ChangesView />;
    case 'recall': return <RecallView />;
    case 'team': return <TeamView />;
    case 'mcp': return <McpView />;
    case 'activity': return <ActivityView />;
    case 'artefacts': return <ArtefactsView />;
    default: return <ChatView />;
  }
}

function useGlobalShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const s = useApp.getState();
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); s.setPalette(!s.paletteOpen); }
      else if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); s.toggleSidebar(); }
      else if (mod && e.key.toLowerCase() === 'n' && !e.shiftKey) { e.preventDefault(); s.newChat(); }
      else if (e.ctrlKey && e.key === '`') { e.preventDefault(); s.toggleDock(); }
      else if (mod && e.key.toLowerCase() === 'i' && !e.shiftKey) { e.preventDefault(); s.toggleRight(); }
      else if (mod && e.key === ',') { e.preventDefault(); s.setView('settings'); }
    };
    window.addEventListener('keydown', onKey);
    // Native menu items in the desktop app map onto the same actions.
    const off = window.shmakkDesktop?.onMenu((action) => {
      const s = useApp.getState();
      if (action === 'new-chat') s.newChat();
      else if (action === 'palette') s.setPalette(true);
      else if (action === 'toggle-sidebar') s.toggleSidebar();
      else if (action === 'toggle-terminal') s.toggleDock();
      else if (action.startsWith('view:')) s.setView(action.slice(5) as ViewId);
    });
    return () => { window.removeEventListener('keydown', onKey); off?.(); };
  }, []);
}

export function App() {
  const ready = useApp((s) => s.ready);
  const view = useApp((s) => s.view);
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const toggleSidebar = useApp((s) => s.toggleSidebar);
  const toggleDock = useApp((s) => s.toggleDock);
  const dockOpen = useApp((s) => s.dockOpen);
  const rightOpen = useApp((s) => s.rightOpen);
  const rightPane = useApp((s) => s.rightPane);
  const toggleRight = useApp((s) => s.toggleRight);
  const setRightPane = useApp((s) => s.setRightPane);
  const settingsOpen = useApp((s) => s.settingsOpen);
  const openSettings = useApp((s) => s.openSettings);
  const resetConv = useApp((s) => s.resetConv);
  const active = useApp((s) => s.convs.find((c) => c.id === s.activeId));
  const running = useApp((s) => (s.activeId ? s.activeId in s.runs : false));
  useGlobalShortcuts();

  const mode = useApp((s) => s.mode);
  const projects = useApp((s) => s.projects);
  const viewedProject = useApp((s) => s.projects.find((p) => p.id === s.projectId));
  const pendingProjectId = useApp((s) => s.pendingProjectId);
  const chatProject = projects.find((p) => p.id === (active ? active.projectId : pendingProjectId));
  const agentic = mode === 'code' || mode === 'cowork';
  // Design chats put their preview toolbar in the header instead of the inspector tabs.
  const design = view === 'chat' && (active?.mode ?? mode) === 'design';
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  const title = view === 'chat' ? active?.title || modeInfo(mode).newLabel : view === 'project' ? viewedProject?.name || 'Project' : TITLES[view];
  useEffect(() => { document.title = `${title} — shmakk`; }, [title]);

  const mobile = useIsMobile();
  const newChat = useApp((s) => s.newChat);
  const keyboardOpen = useApp((s) => s.keyboardOpen);
  const setKeyboard = useApp((s) => s.setKeyboard);
  useVisualViewport(setKeyboard);
  useDrawerSwipe(sidebarOpen, toggleSidebar, mobile && !dockOpen);
  const overlay = 'max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:z-40 max-lg:shadow-pop';

  if (!ready) {
    return <div className="grid h-full place-items-center"><div className="flex items-center gap-3 font-mono text-dim"><Spinner className="size-4" />starting shmakk…</div></div>;
  }

  return (
    <HeaderSlotContext.Provider value={headerSlot}>
    <div className="flex overflow-hidden" style={{ height: 'var(--app-h)' }}>
      <a href="#composer-input" className="absolute -left-[999px] top-2 z-[100] rounded-lg bg-accent px-2.5 py-1.5 text-accent-ink focus:left-2">Skip to message box</a>

      {/* Sidebar: in-flow on wide screens, slide-over drawer on tablets and phones */}
      <div
        className={cn('shrink-0 overflow-hidden transition-[width,transform] duration-200 ease-out', overlay, sidebarOpen ? 'w-[272px] max-lg:w-[min(320px,86vw)]' : 'w-0 max-lg:w-[min(320px,86vw)] max-lg:-translate-x-full max-lg:shadow-none')}
        inert={!sidebarOpen}
      >
        <Sidebar />
      </div>
      {sidebarOpen ? <div className="fixed inset-0 z-30 hidden animate-fade bg-black/50 max-lg:block" onClick={() => toggleSidebar(false)} aria-hidden /> : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className="drag flex min-h-12 shrink-0 items-center gap-2 px-3.5 pb-2 pt-[calc(8px+var(--sat))] max-md:border-b max-md:border-line max-md:bg-panel/80 max-md:px-2 max-md:backdrop-blur"
          style={{ paddingLeft: !sidebarOpen || mobile ? 'calc(8px + var(--sal) + var(--titlebar-pad, 0px))' : undefined, paddingRight: 'calc(8px + var(--sar))' }}
        >
          {mobile ? (
            <Button variant="ghost" size="icon" aria-label="Open menu" onClick={() => toggleSidebar(true)}><Menu /></Button>
          ) : !sidebarOpen ? (
            <Tip label={<>Show sidebar <kbd>{modKey} B</kbd></>}><Button variant="ghost" size="icon" aria-label="Show sidebar" onClick={() => toggleSidebar(true)}><PanelLeft /></Button></Tip>
          ) : null}
          <h1 className="m-0 min-w-0 flex-1 truncate pl-1 text-[14.5px] font-semibold max-md:text-center max-md:text-[16px]">
            {view === 'chat' && !(dockOpen && mobile) ? <span className={cn('mr-2 inline-flex translate-y-[2px] [&_svg]:size-4', modeInfo(mode).tone)} aria-label={`${modeInfo(mode).label} mode`}>{modeInfo(mode).icon}</span> : null}
            {dockOpen && mobile ? 'Terminal' : title}
          </h1>
          {view === 'chat' && chatProject && !mobile ? (
            <Tip label={chatProject.shareContext ? 'In this project — shares context with its other chats' : 'In this project — isolated from its other chats'}>
              <button type="button" onClick={() => useApp.getState().openProject(chatProject.id)} className="inline-flex max-w-48 shrink-0 items-center gap-1.5 rounded-full border border-line px-2.5 py-0.5 text-[12.5px] text-dim hover:bg-hover hover:text-fg">
                <span className={cn('size-2 rounded-full', PROJECT_COLORS[chatProject.color])} /><FolderKanban className="size-3.5" /><span className="truncate">{chatProject.name}</span>
              </button>
            </Tip>
          ) : null}
          {view === 'chat' && active && agentic && !mobile && !design ? (
            <Tip label="Reset context — clear AI history for this chat"><Button variant="ghost" size="icon" aria-label="Reset conversation context" disabled={running} onClick={() => void resetConv()}><Eraser /></Button></Tip>
          ) : null}
          {mobile ? (
            <Button variant="ghost" size="icon" aria-label={modeInfo(mode).newLabel} onClick={() => { toggleDock(false); newChat(); }}><SquarePen /></Button>
          ) : !agentic ? null : (
            <Tip label={<>Terminal <kbd>Ctrl `</kbd></>}><Button variant="ghost" size="icon" aria-label="Toggle terminal" aria-pressed={dockOpen} onClick={() => toggleDock()} className={dockOpen ? 'bg-accent/10 text-accent' : undefined}><SquareTerminal /></Button></Tip>
          )}
          {design && !mobile ? (
            <div ref={setHeaderSlot} className="flex min-w-0 shrink items-center justify-end gap-1.5 overflow-hidden" aria-label="Design preview controls" />
          ) : null}
          {view === 'chat' && !design ? (
            <div role="group" aria-label="Inspector panels" className="flex items-center gap-0.5 rounded-lg border border-line p-0.5">
              {PANES.map((p) => {
                const on = rightOpen && rightPane === p.id;
                return (
                  <Tip key={p.id} label={p.label}>
                    <Button
                      variant="ghost" size="icon-sm" aria-label={p.label} aria-pressed={on}
                      onClick={() => (on ? toggleRight(false) : setRightPane(p.id))}
                      className={on ? 'bg-accent/10 text-accent' : undefined}
                    >
                      {p.icon}
                    </Button>
                  </Tip>
                );
              })}
            </div>
          ) : null}
        </header>

        <div className="flex min-h-0 flex-1">
          <main className={cn('flex min-h-0 min-w-0 flex-1 flex-col pl-[var(--sal)] pr-[var(--sar)]', mobile && dockOpen && 'hidden')}>
            <Suspense fallback={<div className="grid flex-1 place-items-center"><Spinner className="size-5" /></div>}>
              <View view={view} />
            </Suspense>
          </main>
          <RightDock />
        </div>
        <Suspense fallback={null}><TerminalDock /></Suspense>
        {/* The tab bar steps aside while typing, exactly like native chat apps. */}
        {keyboardOpen ? null : <MobileNav />}
      </div>

      <CommandPalette />
      <FolderPicker />
      <Suspense fallback={null}><Show2Plan /></Suspense>
      <Suspense fallback={null}><RecordingBar /></Suspense>
      {settingsOpen ? (
        <Suspense fallback={null}><SettingsDialog open onOpenChange={(o) => openSettings(o)} /></Suspense>
      ) : null}
    </div>
    </HeaderSlotContext.Provider>
  );
}

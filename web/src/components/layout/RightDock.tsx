import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { FileDiff, Globe, ListChecks, X } from 'lucide-react';
import type { DocPane } from '@/lib/types';
import { cn } from '@/lib/utils';
import { RIGHT_MIN, rightMax, useApp } from '@/store/app';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/misc';
import { Tip } from '@/components/ui/tooltip';

// Each pane carries a fair amount of code; only the visible one is bundled in.
const BrowserPane = lazy(() => import('./panels/BrowserPane').then((m) => ({ default: m.BrowserPane })));
const ChangesPane = lazy(() => import('./panels/ChangesPane').then((m) => ({ default: m.ChangesPane })));
const PlanPane = lazy(() => import('./panels/PlanPane').then((m) => ({ default: m.PlanPane })));

export const PANES: { id: DocPane; label: string; icon: React.ReactNode }[] = [
  { id: 'browser', label: 'Browser', icon: <Globe /> },
  { id: 'changes', label: 'Changes', icon: <FileDiff /> },
  { id: 'plan', label: 'Plan', icon: <ListChecks /> },
];

const DEFAULT_WIDTH = 440;
const STEP = 24;

/**
 * The inspector: chat stays in the middle, work products sit beside it. One pane
 * at a time, so the chat never has to shrink to a column of slivers. The pane is
 * picked from the tab row in the app header (Browser, Changes, Plan); this dock
 * renders whichever one is active. Drag the left edge (or focus it and use the
 * arrow keys) to set the width.
 */
export function RightDock() {
  const open = useApp((s) => s.rightOpen);
  const pane = useApp((s) => s.rightPane);
  const width = useApp((s) => s.rightWidth);
  const toggleRight = useApp((s) => s.toggleRight);
  const setRightWidth = useApp((s) => s.setRightWidth);
  const active = PANES.find((p) => p.id === pane) ?? PANES[0];
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ x: number; width: number } | null>(null);

  // A narrower window can leave the saved width too wide for the chat beside it.
  useEffect(() => {
    const onResize = () => setRightWidth(useApp.getState().rightWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [setRightWidth]);

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = { x: e.clientX, width };
    setDragging(true);
  };

  useEffect(() => {
    if (!dragging) return;
    const move = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (d) setRightWidth(d.width + d.x - ev.clientX);
    };
    const up = () => {
      dragRef.current = null;
      setDragging(false);
      setRightWidth(useApp.getState().rightWidth, true);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [dragging, setRightWidth]);

  // Keep the drag from selecting text or fighting the transition.
  useEffect(() => {
    if (!dragging) return;
    const prev = document.body.style.cursor;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.body.style.cursor = prev;
      document.body.style.userSelect = '';
    };
  }, [dragging]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const max = rightMax();
    const next =
      e.key === 'ArrowLeft' ? width + STEP
      : e.key === 'ArrowRight' ? width - STEP
      : e.key === 'Home' ? DEFAULT_WIDTH
      : e.key === 'End' ? max
      : null;
    if (next === null) return;
    e.preventDefault();
    setRightWidth(next, true);
  };

  return (
    <>
      {open ? <div className="fixed inset-0 z-30 hidden bg-black/50 max-lg:block" onClick={() => toggleRight(false)} aria-hidden /> : null}
      <aside
        aria-label="Inspector"
        className={cn(
          'mobile-inspector relative flex shrink-0 flex-col border-l border-line bg-panel',
          'max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:z-40 max-lg:!w-[min(420px,92vw)] max-lg:shadow-pop max-md:!w-full max-md:rounded-t-3xl max-md:overflow-hidden max-md:border-l-0 max-md:border-t',
          !open && 'border-l-0 max-lg:translate-x-full max-md:translate-x-0 max-md:translate-y-full max-lg:shadow-none',
          open && !dragging && 'transition-[width,transform] duration-200 ease-out max-lg:transition-transform',
          dragging && 'transition-none',
        )}
        inert={!open}
        style={{ width: open ? width : 0, paddingTop: 'var(--sat)' }}
      >
        <div className="mx-auto mb-1 mt-2 h-1 w-9 shrink-0 rounded-full bg-line-strong md:hidden" aria-hidden />
        {open ? (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize inspector"
            aria-valuenow={width}
            aria-valuemin={RIGHT_MIN}
            aria-valuemax={Math.round(rightMax())}
            tabIndex={0}
            onPointerDown={startResize}
            onDoubleClick={() => setRightWidth(DEFAULT_WIDTH, true)}
            onKeyDown={onKeyDown}
            className={cn(
              'absolute inset-y-0 left-0 z-10 hidden w-1.5 cursor-col-resize touch-none outline-none lg:block',
              'hover:bg-accent/20 focus-visible:bg-accent/30',
              dragging && 'bg-accent/30',
            )}
          />
        ) : null}
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-3 py-1.5">
          <span className="flex items-center gap-2 text-[13px] font-medium">
            {active.icon}
            {active.label}
          </span>
          <Tip label="Close">
            <Button variant="ghost" size="icon-sm" aria-label="Close inspector" onClick={() => toggleRight(false)}>
              <X />
            </Button>
          </Tip>
        </div>
        <div className="min-h-0 flex-1">
          <Suspense fallback={<div className="grid h-full place-items-center"><Spinner className="size-5" /></div>}>
            {pane === 'browser' ? <BrowserPane /> : pane === 'changes' ? <ChangesPane /> : <PlanPane />}
          </Suspense>
        </div>
      </aside>
    </>
  );
}

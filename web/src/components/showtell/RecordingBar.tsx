import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { Check, Loader2, Pause, PictureInPicture2, Play, SkipForward, Square, X, XCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useApp } from '@/store/app';
import { useRecording } from '@/lib/recordingStore';

export interface ClipStatus { n: number; stage: string; error: string | null; result: { mode: string; topics?: { title: string }[]; title?: string } | null }
export interface SessionStatus { id: string; clips: ClipStatus[] }

/** Server-side progress of every clip in the recording. */
export function useSessionStatus(sessionId: string | null, active = true) {
  return useQuery({
    queryKey: ['show2plan', sessionId],
    queryFn: () => api.get<SessionStatus>(`/api/show2plan/${sessionId}`),
    enabled: !!sessionId && active,
    refetchInterval: 1500,
  });
}

type PipWindow = Window & { document: Document };
const pipApi = () => (window as unknown as { documentPictureInPicture?: { requestWindow(o: { width: number; height: number }): Promise<PipWindow> } }).documentPictureInPicture;

const fmt = (sec: number) => { const s = Math.max(0, Math.floor(sec)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/** Copy the app's styles and theme into the pop-out window. */
function adoptStyles(win: PipWindow) {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      if (sheet.href) {
        const link = win.document.createElement('link');
        link.rel = 'stylesheet';
        link.href = sheet.href;
        win.document.head.appendChild(link);
      } else {
        const style = win.document.createElement('style');
        style.textContent = Array.from(sheet.cssRules).map((r) => r.cssText).join('\n');
        win.document.head.appendChild(style);
      }
    } catch { /* cross-origin sheet */ }
  }
  win.document.documentElement.dataset.theme = document.documentElement.dataset.theme || 'dark';
  win.document.body.className = 'm-0 bg-bg text-fg font-sans';
  win.document.title = 'shmakk recording';
}

function ClipChips({ compact }: { compact?: boolean }) {
  const clips = useRecording((s) => s.clips);
  const sessionId = useRecording((s) => s.sessionId);
  const { data } = useSessionStatus(sessionId, clips.some((c) => c.state === 'sent'));
  const shown = clips.filter((c) => c.state !== 'skipped');
  if (!shown.length) return null;
  return (
    <div className={cn('flex flex-wrap gap-1.5', compact && 'max-h-12 overflow-y-auto')}>
      {shown.map((c) => {
        const srv = data?.clips.find((x) => x.n === c.n);
        const failed = c.state === 'failed' || srv?.stage === 'error';
        const done = srv?.stage === 'done';
        const title = done ? (srv?.result?.topics?.[0]?.title || srv?.result?.title || 'Ready') : null;
        return (
          <span key={c.n} title={failed ? (c.error || srv?.error || 'failed') : title || undefined}
            className={cn('inline-flex max-w-[220px] items-center gap-1 rounded-full border px-2 py-0.5 text-[11.5px]', failed ? 'border-danger/40 text-danger' : done ? 'border-accent/40 text-accent' : 'border-line-strong text-dim')}>
            {failed ? <XCircle className="size-3 shrink-0" /> : done ? <Check className="size-3 shrink-0" /> : <Loader2 className="size-3 shrink-0 animate-spin" />}
            <span className="truncate">Task {c.n + 1}{title ? `: ${title}` : failed ? ': failed' : ': analyzing'}</span>
          </span>
        );
      })}
    </div>
  );
}

function Controls({ inPip, onPopOut }: { inPip: boolean; onPopOut?: () => void }) {
  const r = useRecording();
  const [, setTick] = useState(0);
  useEffect(() => { const t = window.setInterval(() => setTick((n) => n + 1), 500); return () => window.clearInterval(t); }, []);
  const finishing = r.phase === 'finishing';
  const tasks = r.deliverable === 'tasks';
  const btn = 'inline-flex h-9 items-center justify-center gap-1.5 rounded-lg px-3 text-[13px] font-medium transition-colors disabled:opacity-50 [&_svg]:size-4';
  return (
    <div className={cn('grid gap-2', inPip ? 'p-3' : '')}>
      <div className="flex items-center gap-2.5">
        <span className={cn('size-2.5 shrink-0 rounded-full bg-danger', !r.paused && !finishing && 'animate-pulse', r.paused && 'bg-warn')} aria-hidden />
        <span className="text-[13px] font-semibold text-fg">{finishing ? 'Finishing…' : r.paused ? 'Paused' : tasks ? `Task ${r.clip + 1}` : 'Recording'}</span>
        <span className="text-[13px] tabular-nums text-dim">{fmt(r.elapsed())}</span>
        <span className="h-1.5 w-14 overflow-hidden rounded-full bg-line" aria-hidden><span className="block h-full rounded-full bg-accent transition-[width] duration-100" style={{ width: `${Math.round(r.level * 100)}%` }} /></span>
        <span className="text-[11.5px] text-faint">{r.frames} shots</span>
        <span className="flex-1" />
        {!inPip && pipApi() && onPopOut ? (
          <button type="button" onClick={onPopOut} title="Pop out the controls into a small window that stays on top while you show other apps" className={cn(btn, 'h-8 px-2 text-dim hover:bg-hover hover:text-fg')}><PictureInPicture2 /><span className="max-sm:hidden">Pop out</span></button>
        ) : null}
        <button type="button" disabled={finishing} title="Discard this recording" aria-label="Discard recording"
          onClick={() => { if (window.confirm('Discard this recording and every task in it?')) r.discard(); }}
          className={cn(btn, 'h-8 w-8 px-0 text-faint hover:bg-hover hover:text-danger')}><X /></button>
      </div>
      <div className="flex items-center gap-2">
        <button type="button" disabled={finishing} onClick={r.togglePause} className={cn(btn, 'border border-line-strong bg-raised text-fg hover:border-faint')}>
          {r.paused ? <Play /> : <Pause />}{r.paused ? 'Resume' : 'Pause'}
        </button>
        {tasks ? (
          <button type="button" disabled={finishing} onClick={() => void r.next()} title="End this task and start the next one. This task is analysed in the background."
            className={cn(btn, 'flex-1 border border-accent/50 bg-accent/10 text-accent hover:bg-accent/20')}>
            <SkipForward />Next task
          </button>
        ) : <span className="flex-1" />}
        <button type="button" disabled={finishing} onClick={() => void r.stop()} className={cn(btn, 'bg-accent text-accent-ink hover:bg-accent-strong')}>
          {finishing ? <Loader2 className="animate-spin" /> : <Square />}Stop
        </button>
      </div>
      <ClipChips compact={inPip} />
      {r.micNote ? <p className="m-0 text-[12px] text-warn">{r.micNote}</p> : null}
    </div>
  );
}

/**
 * Floating controls while Show & tell records: Pause/Resume, Next task, Stop.
 * They can pop out into an always-on-top window (Document Picture-in-Picture,
 * Chrome and Edge), so they stay reachable while you show another app.
 */
export function RecordingBar() {
  const phase = useRecording((s) => s.phase);
  const setShow2plan = useApp((s) => s.setShow2plan);
  const [pip, setPip] = useState<PipWindow | null>(null);
  const active = phase === 'recording' || phase === 'finishing';

  // Stopping hands over to the review dialog.
  useEffect(() => {
    if (phase === 'review') setShow2plan(true);
    if (!active && pip) { pip.close(); setPip(null); }
  }, [phase, active, pip, setShow2plan]);

  const popOut = async () => {
    const api = pipApi();
    if (!api) return;
    try {
      const win = await api.requestWindow({ width: 420, height: 170 });
      adoptStyles(win);
      win.addEventListener('pagehide', () => setPip(null));
      setPip(win);
    } catch { /* blocked or unsupported */ }
  };

  if (!active) return null;
  return (
    <>
      {pip ? createPortal(<Controls inPip />, pip.document.body) : null}
      <div role="region" aria-label="Recording controls"
        className="fixed bottom-5 left-1/2 z-[60] w-[min(560px,calc(100vw-24px))] -translate-x-1/2 rounded-2xl border border-line-strong bg-panel/95 p-3 shadow-pop backdrop-blur">
        {pip ? (
          <div className="flex items-center gap-2 text-[13px] text-dim">
            <span className="size-2.5 animate-pulse rounded-full bg-danger" />Recording. The controls are in the pop-out window.
            <button type="button" className="ml-auto text-accent hover:underline" onClick={() => { pip.close(); setPip(null); }}>Bring them back</button>
          </div>
        ) : <Controls inPip={false} onPopOut={() => void popOut()} />}
      </div>
    </>
  );
}

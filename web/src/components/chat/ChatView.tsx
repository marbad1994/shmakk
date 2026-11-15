import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown } from 'lucide-react';
import type { Item } from '@/lib/types';
import { useApp } from '@/store/app';
import { cn } from '@/lib/utils';
import { useVoice } from '@/hooks/useVoice';
import { Spinner } from '@/components/ui/misc';
import { TranscriptItem } from './Items';
import { Composer } from './Composer';
import { Welcome } from './Welcome';
import { RepoBar } from './RepoBar';
import { DesignPreview } from './DesignPreview';
import { useIsMobile } from '@/hooks/useMobile';
import { Segmented } from '@/components/ui/misc';

const EMPTY: Item[] = [];

// Width of the chat column in design mode, in px, remembered across reloads.
const SPLIT_KEY = 'shmakk.designSplit';
const SPLIT_MIN = 300;
const SPLIT_MAX = 900;
function loadSplit(): number | null {
  try {
    const n = Number(localStorage.getItem(SPLIT_KEY));
    return Number.isFinite(n) && n >= SPLIT_MIN && n <= SPLIT_MAX ? n : null;
  } catch { return null; }
}

export function ChatView() {
  const activeId = useApp((s) => s.activeId);
  const conv = useApp((s) => s.convs.find((c) => c.id === s.activeId));
  const items = useApp((s) => (s.activeId ? s.items[s.activeId] : undefined)) ?? EMPTY;
  const activity = useApp((s) => (s.activeId ? s.runs[s.activeId] : undefined)) ?? null;
  const loading = useApp((s) => s.loading);
  const settings = useApp((s) => s.settings);
  const send = useApp((s) => s.send);
  const running = activity !== null;
  const mode = useApp((s) => conv?.mode ?? s.mode);
  const mobile = useIsMobile();
  const [pane, setPane] = useState<'chat' | 'preview'>('chat');
  const [split, setSplit] = useState<number | null>(loadSplit);
  const splitBox = useRef<HTMLDivElement>(null);
  const tick = useApp((s) => (s.activeId ? s.designTick[s.activeId] || 0 : 0));
  // On a phone, jump to the preview the first time a design gets files.
  useEffect(() => { if (mode === 'design' && mobile && tick === 1) setPane('preview'); }, [tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const voice = useVoice();
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [showJump, setShowJump] = useState(false);

  // Stick to the bottom while new content streams in — unless the reader
  // has scrolled up to look at something.
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    pinned.current = near;
    setShowJump(!near);
  };
  const toBottom = useCallback((smooth = false) => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);
  useLayoutEffect(() => { if (pinned.current) toBottom(); }, [items, toBottom]);
  useEffect(() => { pinned.current = true; setShowJump(false); toBottom(); }, [activeId, toBottom]);

  // Voice input → send. In hands-free mode the mic re-arms after each reply.
  const onMic = useCallback(async () => {
    const text = await voice.listen();
    if (text) void send(text, 'ask');
  }, [voice, send]);

  // Read the final reply aloud when a run finishes (--tts), then listen again (--sts).
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) {
      const last = [...items].reverse().find((i) => i.type === 'assistant' && !i.interim);
      const speakIt = settings.ttsAuto && last && last.type === 'assistant' && last.text;
      void (async () => {
        if (speakIt) await voice.speak(last.text);
        if (settings.voiceHandsFree && useApp.getState().view === 'chat') void onMic();
      })();
    }
    wasRunning.current = running;
  }, [running]); // eslint-disable-line react-hooks/exhaustive-deps

  const design = mode === 'design';

  // Drag the divider to resize the chat column, which resizes the preview.
  const clampSplit = (w: number, total: number) => Math.round(Math.min(Math.max(SPLIT_MIN, w), Math.max(SPLIT_MIN, Math.min(SPLIT_MAX, total - 320))));
  // A narrower window must not leave the chat column wider than the pane.
  useEffect(() => {
    if (!design || split === null) return;
    const onResize = () => {
      const box = splitBox.current;
      if (box) setSplit(clampSplit(split, box.clientWidth));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [design, split]); // eslint-disable-line react-hooks/exhaustive-deps

  const chat = (
    <div className={cn('relative flex min-h-0 flex-col', design ? 'w-[min(460px,42%)] min-w-0 shrink-0 border-r border-line max-md:w-full max-md:flex-1 max-md:border-r-0' : 'flex-1', design && mobile && pane !== 'chat' && 'hidden')}
      style={design && !mobile && split !== null ? { width: split } : undefined}>
      {conv?.repo ? <RepoBar conv={conv} running={running} /> : null}
      <div ref={scroller} onScroll={onScroll} className="scroll-touch min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]">
        {loading ? (
          <div className="grid h-full place-items-center"><Spinner className="size-5" /></div>
        ) : items.length === 0 ? (
          <Welcome />
        ) : (
          <div className="mx-auto flex max-w-[780px] flex-col gap-3.5 px-5.5 pb-7 pt-4.5 max-md:px-3.5" role="log" aria-label="Conversation">
            {items.map((item) => <TranscriptItem key={item.id} item={item} onSpeak={voice.speak} />)}
          </div>
        )}
      </div>
      {showJump ? (
        <button
          type="button"
          aria-label="Jump to latest"
          onClick={() => toBottom(true)}
          className="absolute bottom-40 left-1/2 max-md:bottom-36 touch:size-10 z-10 grid size-[34px] -translate-x-1/2 place-items-center rounded-full border border-line-strong bg-raised text-dim shadow-pop hover:text-fg"
        >
          <ArrowDown className="size-4" />
        </button>
      ) : null}
      <Composer mode={mode} running={running} activity={activity} mic={voice.mic} speaking={voice.speaking} onMic={onMic} onStopSpeaking={voice.stopSpeaking} />
    </div>
  );
  if (!design) return chat;

  // Design mode: chat on the left, live preview on the right (tabs on a phone).
  return (
    <div className="flex min-h-0 min-w-0 flex-1 max-md:flex-col">
      {mobile ? (
        <div className="flex shrink-0 justify-center border-b border-line bg-panel/60 py-1.5">
          <Segmented label="Pane" value={pane} onChange={setPane} options={[{ value: 'chat', label: 'chat' }, { value: 'preview', label: 'preview' }]} />
        </div>
      ) : null}
      {chat}
      <div className={cn('min-h-0 min-w-0 flex-1', mobile && pane !== 'preview' && 'hidden')}>
        <DesignPreview convId={activeId} running={running} />
      </div>
    </div>
  );
}

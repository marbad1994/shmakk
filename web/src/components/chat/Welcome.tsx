import { useEffect, useRef, useState } from 'react';
import { ArrowRight, GitBranch, KeyRound, RefreshCw, Zap } from 'lucide-react';
import { modeInfo } from '@/lib/modes';
import { nextStart, PRESETS, randomStart, windowAt } from '@/lib/presets';
import type { Mode } from '@/lib/types';
import { basename, cn } from '@/lib/utils';
import { useApp } from '@/store/app';
import { Button } from '@/components/ui/button';

const HEADLINE: Record<Mode, string> = { chat: 'What’s on your mind?', code: 'What are we building', design: 'What should we design?', cowork: 'What can I take off your plate?' };
const ROTATE_MS = 60 * 60 * 1000; // one fresh page of prompts per hour

export function Welcome() {
  const mode = useApp((s) => s.mode);
  const workspace = useApp((s) => s.workspace);
  const provider = useApp((s) => s.provider);
  const project = useApp((s) => s.projects.find((p) => p.id === s.pendingProjectId));
  const { setDraft, setView } = useApp.getState();
  const info = modeInfo(mode);

  // One page index per space, so switching back and forth keeps its place.
  const [starts, setStarts] = useState<Record<Mode, number>>({ chat: 0, code: 0, design: 0, cowork: 0 });
  const [paused, setPaused] = useState(false);
  const pool = PRESETS[mode];
  const start = starts[mode] ?? 0;
  const shown = windowAt(pool, start);
  const advance = (random = false) => setStarts((s) => {
    const cur = s[mode] ?? 0;
    return { ...s, [mode]: random ? randomStart(pool.length, cur) : nextStart(cur, pool.length) };
  });

  // Cycle the cards slowly, and only when nobody is reading them. Reduced
  // motion keeps the static set; the shuffle button still works. The hour
  // clock keeps running across space switches instead of restarting.
  const modeRef = useRef(mode);
  modeRef.current = mode;
  useEffect(() => {
    if (paused || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const t = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      const m = modeRef.current;
      setStarts((s) => ({ ...s, [m]: nextStart(s[m] ?? 0, PRESETS[m].length) }));
    }, ROTATE_MS);
    return () => clearInterval(t);
  }, [paused]);

  return (
    <div className="grid min-h-full place-content-center justify-items-center gap-[18px] p-6 text-center max-md:gap-3.5 max-md:p-4">
      <div className={cn('grid size-16 place-items-center rounded-3xl bg-raised ring-1 ring-line max-md:size-14 [&_svg]:size-8', info.tone)} aria-hidden>{info.icon}</div>
      <h2 className="m-0 text-[26px] font-semibold tracking-tight max-md:text-[21px]">
        {HEADLINE[mode]}{mode === 'code' ? <> in <span className="font-mono text-accent">{basename(workspace) || 'here'}</span>?</> : null}
      </h2>
      <p className="m-0 max-w-[520px] text-dim">
        {mode === 'chat' ? 'A plain conversation, with no files or tools beyond a web search when facts matter.'
          : mode === 'code' ? 'Ask for a change, run a command, or hand over a whole task. shmakk reads, edits and runs inside your workspace, and asks before anything risky.'
          : mode === 'design' ? 'Describe a screen or a flow. shmakk builds it as real, clickable HTML next to the chat and keeps every version.'
          : 'Give shmakk a job. It can do it now, or save it as an automation that runs on a schedule or a webhook.'}
      </p>
      {project ? <p className="m-0 rounded-full border border-line bg-raised px-3 py-1 text-[13px] text-dim">This chat will be part of <strong className="text-fg">{project.name}</strong>{project.shareContext ? ' and can see its other chats' : ''}.</p> : null}

      {!provider.configured ? (
        <div className="flex w-full max-w-[640px] items-center gap-3 rounded-2xl border border-warn/35 bg-warn/10 px-3.5 py-3 text-left max-sm:flex-wrap">
          <KeyRound className="size-5 shrink-0 text-warn" />
          <div className="min-w-0 flex-1">
            <strong className="block">Connect a model to get started</strong>
            <span className="text-[13px] text-dim">Add an OpenAI-compatible base URL, key and model.</span>
          </div>
          <Button variant="primary" onClick={() => setView('settings')}>Open settings<ArrowRight /></Button>
        </div>
      ) : null}

      {mode === 'code' || mode === 'cowork' ? (
        <button type="button" onClick={() => setView(mode === 'code' ? 'github' : 'automations')} className="flex w-full max-w-[640px] items-center gap-3 rounded-2xl border border-line bg-raised px-3.5 py-3 text-left transition-colors hover:border-accent/40">
          {mode === 'code' ? <GitBranch className="size-5 shrink-0 text-violet" /> : <Zap className="size-5 shrink-0 text-warn" />}
          <span className="min-w-0 flex-1">
            <strong className="block font-semibold">{mode === 'code' ? 'Start from a GitHub repository' : 'Automations'}</strong>
            <span className="text-[13px] text-dim">{mode === 'code' ? 'Clone a repo here and work on it in its own session, then push and open a PR when you’re done.' : 'See what is scheduled, build a multi-step workflow, or run one now.'}</span>
          </span>
          <ArrowRight className="size-4 shrink-0 text-faint" />
        </button>
      ) : null}

      <div
        className="mt-1.5 grid w-full max-w-[640px] grid-cols-2 gap-2.5 max-md:grid-cols-1"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        onFocusCapture={() => setPaused(true)}
        onBlurCapture={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPaused(false); }}
      >
        {shown.map((s) => (
          <button key={s.text} type="button" onClick={() => setDraft(s.text, s.shell ? 'shell' : 'ask')}
            className="animate-fade grid min-h-[92px] content-start gap-0.5 rounded-2xl border border-line bg-raised px-3.5 py-3 text-left transition-[border-color,transform] hover:-translate-y-px hover:border-accent/40">
            <span className={cn('font-mono text-[10.5px] font-semibold uppercase tracking-wider', info.tone)}>{s.kind}</span>
            <span className={cn(s.shell ? 'font-mono text-[13px]' : 'text-[13.5px]')}>{s.shell ? `$ ${s.text}` : s.text}</span>
          </button>
        ))}
      </div>

      <Button variant="ghost" size="sm" className="text-faint" onClick={() => advance(true)} aria-label="Show different examples">
        <RefreshCw />Show me something else
      </Button>
    </div>
  );
}

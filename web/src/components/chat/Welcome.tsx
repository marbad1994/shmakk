import { ArrowRight, GitBranch, KeyRound } from 'lucide-react';
import { basename } from '@/lib/utils';
import { useApp } from '@/store/app';
import { Button } from '@/components/ui/button';

const SUGGESTIONS: { kind: string; text: string; mode: 'ask' | 'shell' }[] = [
  { kind: 'understand', text: 'Give me a tour of this codebase — entry points, structure, and how to run it', mode: 'ask' },
  { kind: 'fix', text: 'Run the tests and fix whatever is failing', mode: 'ask' },
  { kind: 'shell', text: 'git status', mode: 'shell' },
  { kind: 'review', text: 'Review my uncommitted changes for bugs and risky edits', mode: 'ask' },
];

export function Welcome() {
  const workspace = useApp((s) => s.workspace);
  const provider = useApp((s) => s.provider);
  const setDraft = useApp((s) => s.setDraft);
  const setView = useApp((s) => s.setView);
  return (
    <div className="grid min-h-full place-content-center justify-items-center gap-[18px] p-6 text-center max-md:gap-3.5 max-md:p-4">
      <div className="flex items-center gap-1 font-mono text-[44px] font-bold leading-none text-accent max-md:text-[34px] [text-shadow:0_0_28px_color-mix(in_srgb,var(--accent)_45%,transparent)]" aria-hidden>
        ❯<i className="h-10 w-5 max-md:h-8 max-md:w-4 animate-blink rounded-[2px] bg-accent shadow-[0_0_24px_color-mix(in_srgb,var(--accent)_45%,transparent)]" />
      </div>
      <h2 className="m-0 text-[26px] font-semibold tracking-tight max-md:text-[21px]">What are we building in <span className="font-mono text-accent">{basename(workspace) || 'here'}</span>?</h2>
      <p className="m-0 max-w-[520px] text-dim">
        Ask for a change, run a command, or hand over a whole task. shmakk reads, edits and runs inside your workspace — and asks before anything risky.
      </p>

      {!provider.configured ? (
        <div className="flex w-full max-w-[640px] items-center gap-3 rounded-2xl border border-warn/35 bg-warn/10 px-3.5 py-3 text-left max-sm:flex-wrap">
          <KeyRound className="size-5 shrink-0 text-warn" />
          <div className="min-w-0 flex-1">
            <strong className="block">Connect a model to get started</strong>
            <span className="text-[13px] text-dim">Add an OpenAI-compatible base URL, key and model. Shell commands work without one.</span>
          </div>
          <Button variant="primary" onClick={() => setView('settings')}>Open settings<ArrowRight /></Button>
        </div>
      ) : null}

      <button type="button" onClick={() => setView('github')} className="flex w-full max-w-[640px] items-center gap-3 rounded-2xl border border-line bg-raised px-3.5 py-3 text-left transition-colors hover:border-violet/50">
        <GitBranch className="size-5 shrink-0 text-violet" />
        <span className="min-w-0 flex-1"><strong className="block font-semibold">Start from a GitHub repository</strong><span className="text-[13px] text-dim">Clone a repo here and work on it in its own session — push and open a PR when you’re done.</span></span>
        <ArrowRight className="size-4 shrink-0 text-faint" />
      </button>

      <div className="mt-1.5 grid w-full max-w-[640px] grid-cols-2 gap-2.5 max-md:grid-cols-1">
        {SUGGESTIONS.map((s) => (
          <button
            key={s.text}
            type="button"
            onClick={() => setDraft(s.text, s.mode)}
            className="grid gap-0.5 rounded-2xl border border-line bg-raised px-3.5 py-3 text-left transition-[border-color,transform] hover:-translate-y-px hover:border-accent/40"
          >
            <span className="font-mono text-[10.5px] font-semibold uppercase tracking-wider text-accent">{s.kind}</span>
            <span className={s.mode === 'shell' ? 'font-mono text-[13px]' : 'text-[13.5px]'}>{s.mode === 'shell' ? `$ ${s.text}` : s.text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

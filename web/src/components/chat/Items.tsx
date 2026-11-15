import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { Collapsible } from 'radix-ui';
import {
  Brain, Check, ChevronRight, CircleSlash, Copy, FilePen, FilePlus2, FileText, FolderOpen, FolderPlus, Globe, Info,
  ListChecks, MousePointerClick, Paperclip, Plug, Search, ShieldAlert, ShieldCheck, TerminalSquare, Trash2, TriangleAlert, Users, Volume2, Wand2, X,
} from 'lucide-react';
import type {
  AskItem, AssistantItem, Item, LogItem, NoticeItem, OutputItem, PlanItem, RouteItem, ShellItem, StepItem, TeamItem, ToolItem, UserItem, ViewId,
} from '@/lib/types';
import { bytes, cn, copyText } from '@/lib/utils';
import { useApp } from '@/store/app';
import { haptic } from '@/hooks/useMobile';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, Spinner } from '@/components/ui/misc';
import { Tip } from '@/components/ui/tooltip';
import { Markdown } from './Markdown';
import { Ansi } from './Ansi';
import { Diff, diffStats } from './Diff';

// ── user ────────────────────────────────────────────────────────────────

function User({ item }: { item: UserItem }) {
  const shell = item.mode === 'shell';
  return (
    <div className="mt-2 flex max-w-[86%] flex-col items-end gap-1 self-end">
      {item.text ? (
        <div className={cn('whitespace-pre-wrap break-words rounded-[18px] rounded-br-[5px] border border-line bg-raised px-3.5 py-2', shell && 'border-accent/35 font-mono text-[13px]')}>
          {shell ? <span className="text-accent">$ </span> : null}
          {item.text}
        </div>
      ) : null}
      {item.attachments?.length ? (
        <div className="flex max-w-full flex-wrap justify-end gap-1.5">
          {item.attachments.map((a, i) => (
            <span key={`${a.name}-${i}`} className="inline-flex items-center gap-1.5 rounded-full border border-line bg-raised px-2.5 py-0.5 font-mono text-[11px] text-dim">
              <Paperclip className="size-3" />
              <span className="max-w-44 truncate">{a.name}</span>
              <span className="text-faint">{bytes(a.size)}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ── assistant ───────────────────────────────────────────────────────────

function Assistant({ item, onSpeak }: { item: AssistantItem; onSpeak?: (text: string) => void }) {
  const [copied, setCopied] = useState(false);
  const thinking = item.streaming && !item.text;
  return (
    <div className="group/msg min-w-0">
      {item.agent ? <div className="mb-1 font-mono text-[10.5px] font-semibold uppercase tracking-wider text-violet">{item.agent}</div> : null}
      {item.reasoning ? (
        <Collapsible.Root className="mb-2 border-l-2 border-line-strong pl-3" defaultOpen={false}>
          <Collapsible.Trigger className="group inline-flex items-center gap-1.5 text-[12.5px] text-faint hover:text-dim">
            <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" />
            <Brain className="size-3.5" />
            {thinking ? 'Thinking…' : 'Thought process'}
          </Collapsible.Trigger>
          <Collapsible.Content className="mt-1.5 whitespace-pre-wrap text-[13px] text-dim">{item.reasoning}</Collapsible.Content>
        </Collapsible.Root>
      ) : null}
      {item.text ? <Markdown text={item.text} streaming={item.streaming} /> : null}
      {!item.streaming && item.text && !item.interim ? (
        <div className="mt-1 flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/msg:opacity-100 touch:opacity-100">
          <Tip label={copied ? 'Copied' : 'Copy'}>
            <Button variant="ghost" size="icon-sm" aria-label="Copy message" onClick={async () => { if (await copyText(item.text)) { setCopied(true); setTimeout(() => setCopied(false), 1400); } }}>
              {copied ? <Check className="text-accent" /> : <Copy />}
            </Button>
          </Tip>
          {onSpeak ? (
            <Tip label="Read aloud"><Button variant="ghost" size="icon-sm" aria-label="Read aloud" onClick={() => onSpeak(item.text)}><Volume2 /></Button></Tip>
          ) : null}
          {item.cached ? <Badge className="ml-1">cached</Badge> : null}
        </div>
      ) : null}
    </div>
  );
}

// ── tool call (timeline row) ────────────────────────────────────────────

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));

function toolView(item: ToolItem): { icon: ReactNode; verb: string; target: string } {
  const a = item.args || {};
  const mcp = /^mcp__(.+?)__(.+)$/.exec(item.name);
  if (mcp) return { icon: <Plug />, verb: mcp[2], target: `${mcp[1]} · ${JSON.stringify(a).slice(0, 80)}` };
  switch (item.name) {
    case 'read_file': return { icon: <FileText />, verb: 'Read', target: str(a.path) + (a.mode && a.mode !== 'full' ? ` (${str(a.mode)})` : '') };
    case 'list_dir': return { icon: <FolderOpen />, verb: 'Listed', target: str(a.path) || '.' };
    case 'write_file': return { icon: item.created ? <FilePlus2 /> : <FilePen />, verb: item.created ? 'Created' : 'Wrote', target: str(a.path) };
    case 'edit_file': return { icon: <FilePen />, verb: 'Edited', target: str(a.path) };
    case 'make_dir': return { icon: <FolderPlus />, verb: 'Created folder', target: str(a.path) };
    case 'delete_file': return { icon: <Trash2 />, verb: 'Deleted', target: str(a.path) };
    case 'run': return { icon: <TerminalSquare />, verb: 'Ran', target: str(a.cmd).split('\n')[0] };
    case 'web_search': return { icon: <Search />, verb: 'Searched', target: str(a.query) };
    case 'fetch_url': return { icon: <Globe />, verb: 'Fetched', target: str(a.url) };
    case 'browser': return { icon: <MousePointerClick />, verb: `Browser ${str(a.command)}`, target: str(a.url || a.selector) };
    case 'remember': return { icon: <Brain />, verb: 'Remembered', target: str(a.fact) };
    default: return { icon: <Wand2 />, verb: item.name, target: JSON.stringify(a).slice(0, 100) };
  }
}

function Rail({ status, children }: { status: string; children: ReactNode }) {
  return (
    <div className="relative -my-1.5 pl-[26px]">
      <span className="absolute bottom-0 left-2 top-0 w-px bg-line-strong" />
      <span
        className={cn(
          'absolute left-[3px] top-[11px] size-[11px] rounded-full border-2 border-faint bg-bg',
          status === 'running' && 'animate-pulse border-accent',
          status === 'done' && 'border-accent bg-accent',
          (status === 'error' || status === 'declined') && 'border-danger',
          status === 'interrupted' && 'border-warn',
        )}
      />
      {children}
    </div>
  );
}

function Tool({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const v = toolView(item);
  const stats = diffStats(item.diff);
  const r = item.result as { exitCode?: number; stdout?: string; stderr?: string; entries?: { name: string; type: string }[]; results?: { title: string; url: string }[] } | null | undefined;
  const hasBody = !!(item.diff || item.error || r?.stdout || r?.stderr || r?.entries?.length || r?.results?.length || item.name === 'run' || item.name.startsWith('mcp__'));
  return (
    <Rail status={item.status}>
      <Collapsible.Root open={open} onOpenChange={setOpen}>
        <Collapsible.Trigger
          disabled={!hasBody}
          className="group flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-left text-[13px] text-dim enabled:hover:bg-hover enabled:hover:text-fg touch:py-2"
        >
          <span className="shrink-0 text-faint [&_svg]:size-3.5">{v.icon}</span>
          <span className="shrink-0 font-medium text-fg">{v.verb}</span>
          <span className="min-w-0 truncate font-mono text-[12.5px]">{v.target}</span>
          <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[11.5px] text-faint">
            {item.agent ? <span className="text-violet">{item.agent}</span> : null}
            {stats ? <><span className="text-accent">+{stats.added}</span><span className="text-danger">−{stats.removed}</span></> : null}
            {item.status === 'running' ? <Spinner className="size-3" /> : null}
            {item.status === 'error' ? <span className="text-danger">failed</span> : null}
            {item.status === 'declined' ? <span className="text-danger">declined</span> : null}
            {item.status === 'interrupted' ? <span className="text-warn">interrupted</span> : null}
            {item.status === 'done' && !stats && item.summary ? <span>{item.summary}</span> : null}
            {hasBody ? <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" /> : null}
          </span>
        </Collapsible.Trigger>
        <Collapsible.Content className="mb-2 ml-2 mt-1 grid gap-2">
          {item.error && item.status !== 'declined' ? <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-[12.5px] text-danger">{item.error}</div> : null}
          {item.name === 'run' ? <pre className="m-0 whitespace-pre-wrap break-words rounded-lg border border-line bg-sunken px-3 py-2 font-mono text-[12.8px]"><span className="text-accent">$ </span>{str(item.args.cmd)}</pre> : null}
          {r?.stdout ? <div className="max-h-80 overflow-auto rounded-lg border border-line bg-sunken px-3 py-2"><Ansi text={r.stdout} /></div> : null}
          {r?.stderr ? <div className="max-h-60 overflow-auto rounded-lg border border-warn/30 bg-sunken px-3 py-2"><Ansi text={r.stderr} /></div> : null}
          {item.diff ? <Diff diff={item.diff} /> : null}
          {r?.entries?.length ? (
            <div className="max-h-56 overflow-auto rounded-lg border border-line bg-sunken px-3 py-2 font-mono text-[12.5px] text-dim">
              {r.entries.map((e) => <div key={e.name}>{e.type === 'dir' ? <span className="text-info">{e.name}/</span> : e.name}</div>)}
            </div>
          ) : null}
          {r?.results?.length ? (
            <ul className="m-0 grid list-none gap-1 rounded-lg border border-line bg-sunken px-3 py-2 text-[13px]">
              {r.results.map((x) => <li key={x.url} className="truncate"><a className="text-accent hover:underline" href={x.url} target="_blank" rel="noopener noreferrer">{x.title || x.url}</a></li>)}
            </ul>
          ) : null}
          {item.name.startsWith('mcp__') ? <pre className="m-0 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-sunken px-3 py-2 font-mono text-xs text-dim">{JSON.stringify({ args: item.args, result: item.result }, null, 2)}</pre> : null}
        </Collapsible.Content>
      </Collapsible.Root>
    </Rail>
  );
}

// ── asks: tool approval, plan approval, correction, confirm ─────────────

function safetyTone(s?: string) { return s === 'unsafe' ? 'danger' : s === 'uncertain' ? 'warn' : 'ok'; }

function Ask({ item }: { item: AskItem }) {
  const answer = useApp((s) => s.answer);
  const patchSettings = useApp((s) => s.patchSettings);
  const yesRef = useRef<HTMLButtonElement>(null);
  const pending = item.status === 'pending';

  // A pending question owns the keyboard: Enter/Y allows, Esc/N declines.
  useEffect(() => {
    if (!pending) return;
    haptic(14);
    // On touch devices focusing would summon nothing useful and can scroll; skip it.
    if (!matchMedia('(pointer: coarse)').matches) yesRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'y' || e.key === 'Y') { e.preventDefault(); answer(item.id, true); }
      if (e.key === 'n' || e.key === 'N' || e.key === 'Escape') { e.preventDefault(); answer(item.id, false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending, item.id, answer]);

  if (!pending) {
    const yes = item.status === 'yes';
    const label = item.kind === 'tool' ? item.description : item.kind === 'plan' ? 'plan' : item.kind === 'correction' ? item.proposed : item.question;
    if (item.kind === 'plan') return null; // the plan card itself shows the outcome
    return (
      <Rail status={yes ? 'done' : 'declined'}>
        <div className="flex min-h-[26px] min-w-0 items-center gap-2 px-2 text-[12.5px] text-faint">
          {yes ? <ShieldCheck className="size-3.5 shrink-0 text-accent" /> : <CircleSlash className="size-3.5 shrink-0 text-danger" />}
          <span className={yes ? 'text-accent' : 'text-danger'}>{item.status === 'expired' ? 'Expired' : yes ? 'Allowed' : 'Declined'}</span>
          <span className="min-w-0 truncate font-mono">{label}</span>
        </div>
      </Rail>
    );
  }

  const unsafe = item.safety === 'unsafe';
  const title = item.kind === 'tool' ? 'Permission needed' : item.kind === 'plan' ? 'Approve plan' : item.kind === 'correction' ? 'Did you mean…' : 'Confirm';
  const yesLabel = item.kind === 'tool' ? 'Allow' : item.kind === 'plan' ? 'Approve & run' : item.kind === 'correction' ? 'Run corrected' : 'Yes';
  const noLabel = item.kind === 'tool' ? 'Deny' : item.kind === 'plan' ? 'Reject' : item.kind === 'correction' ? 'Dismiss' : 'No';
  const isFileTool = item.name === 'write_file' || item.name === 'edit_file' || item.name === 'make_dir';

  return (
    <Card role="alertdialog" aria-label={title} className={cn('animate-rise border-accent/40 ring-[3px] ring-accent/10', unsafe && 'border-danger/50 ring-danger/10')}>
      <div className="flex items-center gap-2.5 border-b border-line px-3.5 py-2.5 font-semibold">
        {unsafe ? <ShieldAlert className="size-4 text-danger" /> : item.kind === 'correction' ? <Wand2 className="size-4 text-accent" /> : item.kind === 'plan' ? <ListChecks className="size-4 text-accent" /> : <ShieldCheck className="size-4 text-accent" />}
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {item.safety ? <Badge tone={safetyTone(item.safety)}>{item.safety}</Badge> : null}
      </div>
      <div className="grid gap-2.5 px-3.5 py-3">
        {item.kind === 'tool' ? (
          <>
            {item.name === 'run' && item.args?.cmd ? (
              <pre className="m-0 whitespace-pre-wrap break-words rounded-lg border border-line bg-sunken px-3 py-2 font-mono text-[13px]"><span className="text-accent">$ </span>{str(item.args.cmd)}</pre>
            ) : (
              <div className="break-words font-mono text-[13px]">{item.description}</div>
            )}
            {item.diff ? <Diff diff={item.diff} maxHeight={300} /> : null}
            <div className="grid gap-0.5 text-[12.5px] text-dim">
              <span>{item.what}</span>
              <span>{item.why}</span>
            </div>
          </>
        ) : null}
        {item.kind === 'correction' ? (
          <div className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1 font-mono text-[13px]">
            <span className="text-[10.5px] font-semibold uppercase tracking-wider text-faint">you typed</span>
            <span className="text-danger line-through decoration-danger/50">{item.input}</span>
            <span className="text-[10.5px] font-semibold uppercase tracking-wider text-faint">run instead</span>
            <span className="text-accent">{item.proposed}</span>
            {item.reason ? <><span className="text-[10.5px] font-semibold uppercase tracking-wider text-faint">why</span><span className="font-sans text-dim">{item.reason}</span></> : null}
          </div>
        ) : null}
        {item.kind === 'confirm' || item.kind === 'plan' ? (
          <>
            <div>{item.question}</div>
            {item.detail ? <pre className="m-0 whitespace-pre-wrap break-words rounded-lg border border-line bg-sunken px-3 py-2 font-mono text-[13px]">{item.detail}</pre> : null}
          </>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-line bg-panel px-3.5 py-2.5 max-md:[&>button]:flex-1">
        <Button ref={yesRef} variant={unsafe ? 'danger' : 'primary'} onClick={() => answer(item.id, true)}>{yesLabel}<kbd className="!border-current/30 !bg-transparent !text-current opacity-70 touch:hidden">Y</kbd></Button>
        <Button onClick={() => answer(item.id, false)}>{noLabel}<kbd className="touch:hidden">N</kbd></Button>
        {item.kind === 'tool' && isFileTool && !unsafe ? (
          <Button variant="ghost" size="sm" onClick={() => { void patchSettings({ yesFiles: true }); answer(item.id, true); }}>Always allow file edits</Button>
        ) : null}
        <span className="ml-auto text-xs text-faint max-md:hidden">shmakk is waiting for you</span>
      </div>
    </Card>
  );
}

// ── plan / step / team ──────────────────────────────────────────────────

const TASK_MARK: Record<string, string> = { completed: '✓', failed: '✕', skipped: '–' };

export function PlanCard({ plan }: { plan: PlanItem['plan'] }) {
  const done = plan.tasks.filter((t) => t.status === 'completed').length;
  const tone = plan.status === 'completed' ? 'ok' : plan.status === 'rejected' || plan.status === 'aborted' ? 'danger' : plan.status === 'executing' ? 'info' : 'warn';
  return (
    <Card>
      <div className="flex items-center gap-2.5 px-3.5 py-2.5 font-semibold">
        <ListChecks className="size-4 text-accent" />
        <span className="min-w-0 flex-1 truncate">{plan.title}</span>
        <Badge tone={tone}>{plan.status.replace(/_/g, ' ')}</Badge>
        <span className="font-mono text-xs text-faint">{done}/{plan.tasks.length}</span>
      </div>
      <div className="h-[3px] bg-line"><div className="h-full bg-accent transition-[width] duration-300" style={{ width: `${(done / Math.max(1, plan.tasks.length)) * 100}%` }} /></div>
      <ol className="m-0 grid list-none gap-0.5 p-2.5">
        {plan.tasks.map((t) => (
          <li key={t.id} className="grid grid-cols-[22px_1fr] gap-x-2 rounded-lg px-1 py-1.5">
            <span
              className={cn(
                'mt-0.5 grid size-[18px] place-items-center rounded-full border-[1.5px] border-line-strong text-[10px]',
                t.status === 'completed' && 'border-accent bg-accent text-accent-ink',
                t.status === 'in_progress' && 'animate-spin border-accent border-t-transparent',
                t.status === 'failed' && 'border-danger text-danger',
                t.status === 'skipped' && 'border-warn text-warn',
              )}
            >
              {TASK_MARK[t.status] || ''}
            </span>
            <span className={cn('font-medium', t.status === 'completed' && 'text-dim')}>{t.title}</span>
            {t.description ? <span className="col-start-2 text-[13px] text-dim">{t.description}</span> : null}
          </li>
        ))}
      </ol>
    </Card>
  );
}

function Step({ item }: { item: StepItem }) {
  return (
    <div className="mt-1.5 flex items-center gap-2.5 text-[12.5px] text-dim before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line">
      <b className="font-mono text-[11px] font-semibold tracking-wide text-accent">STEP {item.index}/{item.total}</b>
      <span>{item.title}</span>
    </div>
  );
}

function Team({ item }: { item: TeamItem }) {
  return (
    <Card>
      <div className="flex items-center gap-2.5 border-b border-line px-3.5 py-2.5 font-semibold">
        <Users className="size-4 text-violet" />
        <span className="flex-1">Team of {item.agents.length}</span>
        <Badge tone="violet">{item.topology}</Badge>
      </div>
      <div className="grid gap-1.5 p-3">
        {item.reason ? <p className="m-0 mb-1 text-[13px] text-dim">{item.reason}</p> : null}
        {item.agents.map((a, i) => (
          <div key={i} className="grid grid-cols-[1fr_auto] items-center gap-x-2.5 gap-y-0.5 rounded-[10px] border border-line bg-sunken px-2.5 py-2">
            <span className="font-mono text-xs font-semibold uppercase tracking-wide text-violet">{item.topology === 'pipeline' ? `${i + 1}. ` : ''}{a.role}</span>
            <span className={cn('inline-flex items-center gap-1.5 font-mono text-[11.5px] text-faint', a.status === 'done' && 'text-accent', a.status === 'error' && 'text-danger')}>
              {a.status === 'running' ? <Spinner className="size-3" /> : null}
              {a.status === 'done' ? `done · ${a.toolCount ?? 0} tools · ${a.elapsed ?? 0}s` : a.status === 'error' ? (a.error || 'failed') : a.status}
            </span>
            <span className="col-span-2 text-[13px] text-dim">{a.task}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ── shell / output / log / notice / route ───────────────────────────────

function Shell({ item }: { item: ShellItem }) {
  const ok = item.exitCode === 0;
  return (
    <div className="overflow-hidden rounded-[10px] border border-line bg-sunken">
      <div className="flex items-center gap-2 border-b border-line bg-panel px-3 py-1.5 font-mono text-[12.5px] text-dim">
        <span className="min-w-0 flex-1 truncate text-fg"><span className="text-accent">$ </span>{item.cmd}</span>
        {item.correctedFrom ? <Tip label={`Corrected from “${item.correctedFrom}”`}><Badge tone="ok"><Wand2 className="size-3" />corrected</Badge></Tip> : null}
        {item.running ? <Spinner /> : <Badge tone={ok ? 'ok' : 'danger'}>exit {item.exitCode ?? '?'}</Badge>}
      </div>
      {item.output ? <div className="max-h-96 overflow-auto px-3 py-2"><Ansi text={item.output} /></div> : null}
      <div className="flex gap-3 border-t border-line px-3 py-1 font-mono text-[11.5px] text-faint">
        <span className="truncate">{item.cwd}</span>
        {item.cwdAfter && item.cwdAfter !== item.cwd ? <span className="truncate">→ {item.cwdAfter}</span> : null}
        {item.truncated ? <span className="text-warn">output truncated</span> : null}
      </div>
    </div>
  );
}

function Output({ item }: { item: OutputItem }) {
  return (
    <div className="overflow-hidden rounded-[10px] border border-line bg-sunken">
      <div className="border-b border-line bg-panel px-3 py-1.5 font-mono text-[12px] text-faint">{item.title}</div>
      <div className="max-h-[28rem] overflow-auto px-3 py-2"><Ansi text={item.text} /></div>
    </div>
  );
}

function Log({ item }: { item: LogItem }) {
  if (!item.text.trim()) return null;
  return (
    <Collapsible.Root className="border-l-2 border-line-strong pl-3">
      <Collapsible.Trigger className="group inline-flex items-center gap-1.5 text-[12.5px] text-faint hover:text-dim">
        <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" />Agent log
      </Collapsible.Trigger>
      <Collapsible.Content className="mt-1.5 max-h-64 overflow-auto"><Ansi text={item.text} className="text-xs" /></Collapsible.Content>
    </Collapsible.Root>
  );
}

const NOTICE_ICON = { info: <Info />, ok: <Check />, warn: <TriangleAlert />, error: <X /> };
const NOTICE_CLS = {
  info: 'border-line text-dim',
  ok: 'border-accent/35 bg-accent/10 text-accent',
  warn: 'border-warn/35 bg-warn/10 text-warn',
  error: 'border-danger/35 bg-danger/10 text-danger',
};

function Notice({ item }: { item: NoticeItem }) {
  const setView = useApp((s) => s.setView);
  const target = item.action?.startsWith('open:') ? (item.action.slice(5) as ViewId) : null;
  return (
    <div className={cn('flex max-w-full items-center gap-2 self-center rounded-full border px-3 py-1 text-[13px] [&_svg]:size-3.5 [&_svg]:shrink-0', NOTICE_CLS[item.level])}>
      {NOTICE_ICON[item.level]}
      <span className="min-w-0">{item.text}</span>
      {target ? <button type="button" className="font-semibold underline underline-offset-2" onClick={() => setView(target)}>Open {target}</button> : null}
    </div>
  );
}

function Route({ item }: { item: RouteItem }) {
  return <Badge tone="violet" className="self-start">specialist · {item.indicator} · {item.profile}</Badge>;
}

// ── dispatcher ──────────────────────────────────────────────────────────

export const TranscriptItem = memo(function TranscriptItem({ item, onSpeak }: { item: Item; onSpeak?: (text: string) => void }) {
  switch (item.type) {
    case 'user': return <User item={item} />;
    case 'assistant': return <Assistant item={item} onSpeak={onSpeak} />;
    case 'tool': return <Tool item={item} />;
    case 'ask': return <Ask item={item} />;
    case 'plan': return <PlanCard plan={item.plan} />;
    case 'step': return <Step item={item} />;
    case 'team': return <Team item={item} />;
    case 'shell': return <Shell item={item} />;
    case 'output': return <Output item={item} />;
    case 'log': return <Log item={item} />;
    case 'notice': return <Notice item={item} />;
    case 'route': return <Route item={item} />;
    default: return null;
  }
});

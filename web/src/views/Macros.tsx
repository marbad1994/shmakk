import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, ChevronRight, FolderTree, MoreHorizontal, Pencil, Play, Plus, Terminal, Trash2, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { Automation, Macro } from '@/lib/types';
import { basename, cn, relTime } from '@/lib/utils';
import { useApp } from '@/store/app';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/input';
import { Empty, Spinner } from '@/components/ui/misc';
import { MultiSelect, type MultiOption } from '@/components/ui/multiselect';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Loading, Page } from './Page';

interface Data { macros: Macro[] }
interface Draft {
  id: string | null; trigger: string; name: string; description: string;
  kind: Macro['kind']; automationId: string | null; commands: string; askWhen: string;
  workspaces: string[];
}

const STATUS: Record<string, { tone: 'ok' | 'danger' | 'warn' | 'info' | 'neutral'; label: string }> = {
  ok: { tone: 'ok', label: 'succeeded' }, error: { tone: 'danger', label: 'failed' },
  stopped: { tone: 'warn', label: 'stopped' }, running: { tone: 'info', label: 'running' },
};
const when = (ts: number) => new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const dur = (ms?: number) => (!ms ? '' : ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.round(ms / 60000)}m`);

const blank = (): Draft => ({ id: null, trigger: '', name: '', description: '', kind: 'commands', automationId: null, commands: '', askWhen: '', workspaces: [] });
const toDraft = (m: Macro): Draft => ({
  id: m.id, trigger: m.trigger, name: m.name, description: m.description, kind: m.kind,
  automationId: m.automationId, commands: (m.commands || []).join('\n'), askWhen: m.askWhen || '',
  workspaces: m.workspaces || [],
});

// The workspaces a macro can be limited to: the managed folders under the
// workspaces root, every project's folder, and the folder open right now.
function useWorkspaceOptions(): MultiOption[] {
  const current = useApp((s) => s.workspace);
  const projects = useApp((s) => s.projects);
  const dirs = useQuery({ queryKey: ['workspaces'], queryFn: () => api.get<{ root: string | null; workspaces: { name: string; path: string }[] }>('/api/workspaces') });
  return useMemo(() => {
    const out: MultiOption[] = [];
    const seen = new Set<string>();
    const add = (value: string | null | undefined, label: string, hint?: string) => {
      if (!value || seen.has(value)) return;
      seen.add(value);
      out.push({ value, label, hint });
    };
    add(current, current ? basename(current) : '', current);
    for (const p of projects) add(p.workspace, p.name, p.workspace || undefined);
    for (const w of dirs.data?.workspaces ?? []) add(w.path, w.name, w.path);
    return out;
  }, [current, projects, dirs.data]);
}

function Editor({ draft, setDraft, automations, workspaceOptions, onClose }: { draft: Draft | null; setDraft(d: Draft | null): void; automations: Automation[]; workspaceOptions: MultiOption[]; onClose(): void }) {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (d: Draft) => {
      const body = {
        trigger: d.trigger, name: d.name || d.trigger, description: d.description, kind: d.kind,
        automationId: d.kind === 'automation' ? d.automationId : null,
        commands: d.commands.split('\n').map((c) => c.trim()).filter(Boolean),
        askWhen: d.askWhen,
        workspaces: d.workspaces,
      };
      return d.id ? api.patch(`/api/macros/${d.id}`, body) : api.post('/api/macros', body);
    },
    onSuccess: (_r, d) => { toast.success(d.id ? 'Macro saved' : 'Macro created'); onClose(); void qc.invalidateQueries({ queryKey: ['macros'] }); },
    onError: (e: Error) => toast.error(e.message),
  });
  const d = draft;
  const valid = !!d && !!d.trigger.trim() && (d.kind === 'automation' ? !!d.automationId : d.commands.split('\n').some((c) => c.trim()));
  const set = (patch: Partial<Draft>) => d && setDraft({ ...d, ...patch });

  return (
    <Dialog open={!!d} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="md:w-[min(760px,calc(100vw-32px))] md:top-[6vh] md:max-h-[88vh]">
        <form onSubmit={(e) => { e.preventDefault(); if (d && valid) save.mutate(d); }} className="flex min-h-0 flex-col">
          <DialogHeader>
            <DialogTitle>{d?.id ? 'Edit macro' : 'New macro'}</DialogTitle>
            <DialogDescription>A word you type, that runs something. Type it alone or end a sentence with “then run the {d?.trigger || 'word'} macro”.</DialogDescription>
          </DialogHeader>
          {d ? (
            <DialogBody className="grid gap-4">
              <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
                <Field label="Trigger word" htmlFor="ma-trigger" hint="One word is easiest to remember. Letters, digits, spaces, dots and dashes.">
                  <Input id="ma-trigger" autoFocus={!d.id} value={d.trigger} onChange={(e) => set({ trigger: e.target.value })} placeholder="deploy" className="font-mono text-[13px]" spellCheck={false} autoCapitalize="off" />
                </Field>
                <Field label="Name" htmlFor="ma-name" hint="Shown in the list and in the transcript.">
                  <Input id="ma-name" value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="Deploy to production" />
                </Field>
              </div>

              <div className="grid gap-2">
                <span className="text-[12.5px] font-medium text-dim">What happens</span>
                <div className="grid grid-cols-2 gap-2 max-sm:grid-cols-1" role="radiogroup" aria-label="What the macro runs">
                  <button type="button" role="radio" aria-checked={d.kind === 'commands'} onClick={() => set({ kind: 'commands' })}
                    className={cn('grid gap-0.5 rounded-xl border border-line bg-raised p-3 text-left', d.kind === 'commands' && 'border-accent/50 bg-accent/10 ring-1 ring-accent/30')}>
                    <span className="flex items-center gap-2 font-semibold [&_svg]:size-4"><Terminal />Commands</span>
                    <span className="text-[12.5px] text-dim">Shell commands, run in the conversation you typed the word in.</span>
                  </button>
                  <button type="button" role="radio" aria-checked={d.kind === 'automation'} onClick={() => set({ kind: 'automation' })}
                    className={cn('grid gap-0.5 rounded-xl border border-line bg-raised p-3 text-left', d.kind === 'automation' && 'border-accent/50 bg-accent/10 ring-1 ring-accent/30')}>
                    <span className="flex items-center gap-2 font-semibold [&_svg]:size-4"><Bot />An automation</span>
                    <span className="text-[12.5px] text-dim">Starts a saved automation in its own conversation.</span>
                  </button>
                </div>
              </div>

              {d.kind === 'commands' ? (
                <Field label="Commands" htmlFor="ma-cmds" hint="One per line, run in order in the current conversation. Risky ones still ask first.">
                  <Textarea id="ma-cmds" value={d.commands} onChange={(e) => set({ commands: e.target.value })} placeholder={'git fetch\ngit status\nnpm test'} className="min-h-24 font-mono text-[13px]" spellCheck={false} autoCapitalize="off" />
                </Field>
              ) : (
                <Field label="Automation" hint={automations.length ? 'The macro only pulls the trigger; the automation’s steps do the work.' : 'You have no automations yet. Create one on the Automations page first.'}>
                  <Select value={d.automationId || ''} onValueChange={(v) => set({ automationId: v })}>
                    <SelectTrigger aria-label="Automation"><SelectValue placeholder="Pick an automation" /></SelectTrigger>
                    <SelectContent>{automations.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent>
                  </Select>
                </Field>
              )}

              <Field label="When should it offer itself? (optional)" htmlFor="ma-when"
                hint="Describe the moment, e.g. “after git push to main or dev”, or a /regex/ for anything the keywords cannot express. Matching commands bring up a Run macro / Cancel question when the run ends.">
                <Input id="ma-when" value={d.askWhen} onChange={(e) => set({ askWhen: e.target.value })} placeholder="after git push to main or dev" />
              </Field>

              <Field label="Workspaces" htmlFor="ma-ws"
                hint={d.workspaces.length
                  ? `The trigger word only counts inside ${d.workspaces.length === 1 ? 'this workspace' : `these ${d.workspaces.length} workspaces`}. Leave it empty to fire everywhere.`
                  : 'Empty means any workspace. Pick one or more to make the trigger word count only there.'}>
                <MultiSelect id="ma-ws" ariaLabel="Workspaces this macro fires in" value={d.workspaces}
                  onChange={(next) => set({ workspaces: next })} options={workspaceOptions}
                  placeholder="Any workspace" searchPlaceholder="Search workspaces…" emptyText="No workspaces found." />
              </Field>

              <Field label="What is it for? (optional)" htmlFor="ma-desc">
                <Input id="ma-desc" value={d.description} onChange={(e) => set({ description: e.target.value })} />
              </Field>
            </DialogBody>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant="primary" type="submit" disabled={!valid || save.isPending}>{d?.id ? 'Save' : 'Create macro'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Card({ m, onEdit }: { m: Macro; onEdit(): void }) {
  const qc = useQueryClient();
  const openConv = useApp((s) => s.openConv);
  const [open, setOpen] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['macros'] });
  const patch = useMutation({ mutationFn: (body: Record<string, unknown>) => api.patch(`/api/macros/${m.id}`, body), onSuccess: refresh, onError: (e: Error) => toast.error(e.message) });
  const run = useMutation({
    mutationFn: () => api.post<{ convId?: string }>(`/api/macros/${m.id}/run`),
    onSuccess: (r) => { toast(`${m.name} started`); void refresh(); if (r?.convId) void openConv(r.convId); },
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({ mutationFn: () => api.del(`/api/macros/${m.id}`), onSuccess: () => { toast('Macro deleted'); void refresh(); } });
  const last = m.runs?.[0];

  return (
    <article className={cn('grid gap-2.5 rounded-2xl border border-line bg-raised p-4', !m.enabled && 'opacity-60')}>
      <header className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="m-0 flex flex-wrap items-center gap-2 text-[15px] font-semibold">
            {m.name}
            <code className="rounded-md bg-sunken px-1.5 py-0.5 font-mono text-[12px] font-normal text-dim">{m.trigger}</code>
            <Badge tone={m.kind === 'automation' ? 'info' : 'neutral'}>{m.kind === 'automation' ? 'automation' : 'commands'}</Badge>
          </h3>
          <p className="m-0 mt-1 text-[13px] text-dim">
            {m.kind === 'automation'
              ? (m.automation ? `Starts “${m.automation.name}”` : 'Starts a missing automation')
              : `${m.commands.length} command${m.commands.length === 1 ? '' : 's'}: ${m.commands.join(' · ')}`}
          </p>
          {m.askWhen ? <p className="m-0 mt-1 text-[13px] text-faint">Offers itself {m.askWhen.startsWith('/') ? `on ${m.askWhen}` : m.askWhen}</p> : null}
          <p className="m-0 mt-1 flex flex-wrap items-center gap-1.5 text-[13px] text-faint">
            <FolderTree className="size-3.5" aria-hidden />
            {m.workspaces?.length
              ? <>Only in {m.workspaces.map((w) => basename(w)).join(', ')}</>
              : 'Any workspace'}
          </p>
        </div>
        <Switch checked={m.enabled} onCheckedChange={(v) => patch.mutate({ enabled: v })} aria-label={`${m.name} enabled`} className="mt-1.5" />
      </header>

      <div className="flex flex-wrap items-center gap-2">
        {m.running ? <Badge tone="info"><Spinner className="size-3 text-info" />running</Badge>
          : last ? <Badge tone={STATUS[last.status]?.tone}>{STATUS[last.status]?.label ?? last.status} · {relTime(last.at)}</Badge> : <Badge>never run</Badge>}
        {!m.enabled ? <span className="text-[13px] text-faint">Paused</span> : null}
        <span className="flex-1" />
        <Button size="sm" variant="primary" disabled={m.running || run.isPending} onClick={() => run.mutate()}><Play />Run now</Button>
        <Button size="sm" onClick={onEdit}><Pencil />Edit</Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`More for ${m.name}`}><MoreHorizontal /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem danger onSelect={() => { if (confirm(`Delete the “${m.name}” macro? Past runs stay in your chats.`)) remove.mutate(); }}><Trash2 />Delete</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {m.runs?.length ? (
        <div className="border-t border-line pt-2">
          <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="inline-flex items-center gap-1.5 text-[13px] text-dim hover:text-fg">
            <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />Run history · {m.runs.length}
          </button>
          {open ? (
            <ul className="m-0 mt-2 grid list-none gap-1 p-0">
              {m.runs.slice(0, 10).map((r) => (
                <li key={r.id}>
                  <button type="button" disabled={!r.convId} onClick={() => r.convId && void openConv(r.convId)} className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-hover disabled:hover:bg-transparent">
                    <Badge tone={STATUS[r.status]?.tone}>{STATUS[r.status]?.label ?? r.status}</Badge>
                    <span className="shrink-0 text-[13px]">{when(r.at)}</span>
                    <span className="shrink-0 font-mono text-[11.5px] text-faint">{r.via}{r.durationMs ? ` · ${dur(r.durationMs)}` : ''}</span>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-dim">{r.summary || r.input}</span>
                    {r.convId ? <ChevronRight className="size-3.5 shrink-0 text-faint" /> : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export function MacrosView() {
  const { data, isLoading } = useQuery({ queryKey: ['macros'], queryFn: () => api.get<Data>('/api/macros'), refetchInterval: 30000 });
  const automations = useQuery({ queryKey: ['automations'], queryFn: () => api.get<{ automations: Automation[] }>('/api/automations') });
  const [draft, setDraft] = useState<Draft | null>(null);
  const list = data?.macros ?? [];
  const autos = useMemo(() => automations.data?.automations ?? [], [automations.data]);
  const workspaceOptions = useWorkspaceOptions();

  return (
    <Page
      lead="A word that runs something. Type it on its own in any chat, or end a sentence with “then run the deploy macro”. Macros can also offer themselves when a command matches their instruction."
      actions={<Button variant="primary" onClick={() => setDraft(blank())}><Plus />New macro</Button>}
    >
      {isLoading ? <Loading /> : list.length === 0 ? (
        <Empty icon={<Zap />} title="No macros yet">
          Give a routine a word of its own, e.g. “deploy” for a short command list, or a word that starts an automation.
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            <Button size="sm" variant="primary" onClick={() => setDraft(blank())}><Plus />New macro</Button>
          </div>
        </Empty>
      ) : (
        <div className="grid gap-3">{list.map((m) => <Card key={m.id} m={m} onEdit={() => setDraft(toDraft(m))} />)}</div>
      )}
      <Editor draft={draft} setDraft={setDraft} automations={autos} workspaceOptions={workspaceOptions} onClose={() => setDraft(null)} />
    </Page>
  );
}

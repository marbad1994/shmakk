import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, CalendarClock, ChevronRight, Copy, Hand, MoreHorizontal, Pencil, Play, Plus, Trash2, Webhook, X, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { DAY_NAMES, defaultSchedule, describe, fromCron, toCron, type Freq, type Schedule } from '@/lib/schedule';
import type { Automation, AutomationStep } from '@/lib/types';
import { cn, copyText, relTime } from '@/lib/utils';
import { useApp } from '@/store/app';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/input';
import { Empty, Spinner } from '@/components/ui/misc';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Loading, Page } from './Page';

interface Template { id: string; name: string; description: string; steps: AutomationStep[] }
interface Data { automations: Automation[]; timezone: string; templates: Template[] }
type TriggerType = 'manual' | 'schedule' | 'webhook';
interface Draft { id: string | null; name: string; description: string; steps: AutomationStep[]; trigger: TriggerType; schedule: Schedule; timezone: string; approval: Automation['approval']; projectId: string | null; workspace: string }

const STATUS: Record<string, { tone: 'ok' | 'danger' | 'warn' | 'info' | 'neutral'; label: string }> = {
  ok: { tone: 'ok', label: 'succeeded' }, error: { tone: 'danger', label: 'failed' }, stopped: { tone: 'warn', label: 'stopped' },
  running: { tone: 'info', label: 'running' }, interrupted: { tone: 'warn', label: 'interrupted' },
};
const when = (ts: number) => new Date(ts).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });
const until = (ts: number) => { const m = Math.max(0, Math.round((ts - Date.now()) / 60000)); return m < 1 ? 'any moment' : m < 60 ? `in ${m} min` : m < 1440 ? `in ${Math.round(m / 60)} h` : `in ${Math.round(m / 1440)} d`; };
const dur = (ms: number) => (ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.round(ms / 60000)}m`);

function blank(timezone: string, projectId: string | null): Draft {
  return { id: null, name: '', description: '', steps: [{ title: '', prompt: '' }], trigger: 'schedule', schedule: defaultSchedule(), timezone, approval: 'auto', projectId, workspace: '' };
}
function toDraft(a: Automation, timezone: string): Draft {
  return {
    id: a.id, name: a.name, description: a.description, steps: a.steps.length ? a.steps : [{ title: '', prompt: '' }], trigger: a.trigger.type,
    schedule: a.trigger.type === 'schedule' ? fromCron(a.trigger.cron) : defaultSchedule(), timezone: a.trigger.type === 'schedule' ? a.trigger.timezone : timezone,
    approval: a.approval, projectId: a.projectId, workspace: a.workspace || '',
  };
}

function ScheduleBuilder({ value, onChange, timezone, onTimezone }: { value: Schedule; onChange(s: Schedule): void; timezone: string; onTimezone(tz: string): void }) {
  const zones = useMemo(() => { try { return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone'); } catch { return []; } }, []);
  const set = (patch: Partial<Schedule>) => onChange({ ...value, ...patch });
  const needsTime = value.freq !== 'minutes' && value.freq !== 'cron';
  return (
    <div className="grid gap-3 rounded-xl border border-line bg-sunken p-3">
      <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
        <Field label="Repeat">
          <Select value={value.freq} onValueChange={(v) => set({ freq: v as Freq })}>
            <SelectTrigger aria-label="Repeat"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="minutes">Every few minutes</SelectItem><SelectItem value="hourly">Every hour</SelectItem><SelectItem value="daily">Every day</SelectItem>
              <SelectItem value="weekdays">Weekdays (Mon–Fri)</SelectItem><SelectItem value="weekly">On chosen days</SelectItem><SelectItem value="monthly">Monthly</SelectItem><SelectItem value="cron">Custom (cron)</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {value.freq === 'minutes' ? <Field label="Every (minutes)" htmlFor="sch-every"><Input id="sch-every" type="number" min={1} max={59} value={value.every} onChange={(e) => set({ every: Number(e.target.value) })} /></Field> : null}
        {value.freq === 'hourly' ? <Field label="At minute" htmlFor="sch-min"><Input id="sch-min" type="number" min={0} max={59} value={Number(value.time.split(':')[1])} onChange={(e) => set({ time: `00:${String(Math.max(0, Math.min(59, Number(e.target.value)))).padStart(2, '0')}` })} /></Field> : null}
        {needsTime && value.freq !== 'hourly' ? <Field label="At" htmlFor="sch-time"><Input id="sch-time" type="time" value={value.time} onChange={(e) => set({ time: e.target.value || '09:00' })} /></Field> : null}
        {value.freq === 'cron' ? <Field label="Cron expression" htmlFor="sch-cron" hint="minute hour day month weekday"><Input id="sch-cron" value={value.cron} onChange={(e) => set({ cron: e.target.value })} className="font-mono text-[13px]" spellCheck={false} /></Field> : null}
      </div>
      {value.freq === 'weekly' ? (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Days">
          {DAY_NAMES.map((d, i) => (
            <button key={d} type="button" aria-pressed={value.days.includes(i)} onClick={() => set({ days: value.days.includes(i) ? value.days.filter((x) => x !== i) : [...value.days, i] })}
              className={cn('rounded-full border border-line px-3 py-1 text-[13px] text-dim touch:py-2', value.days.includes(i) && 'border-transparent bg-fg text-bg')}>{d}</button>
          ))}
        </div>
      ) : null}
      {value.freq === 'monthly' ? <Field label="Day of the month" htmlFor="sch-dom"><Input id="sch-dom" type="number" min={1} max={31} value={value.dayOfMonth} onChange={(e) => set({ dayOfMonth: Number(e.target.value) })} className="w-28" /></Field> : null}
      <div className="grid grid-cols-[1fr_auto] items-end gap-3 max-sm:grid-cols-1">
        <Field label="Time zone" htmlFor="sch-tz">
          <Input id="sch-tz" list="tz-list" value={timezone} onChange={(e) => onTimezone(e.target.value)} className="font-mono text-[13px]" spellCheck={false} />
          <datalist id="tz-list">{zones.map((z) => <option key={z} value={z} />)}</datalist>
        </Field>
        <p className="m-0 pb-2 text-[13.5px] font-medium text-accent">{describe(value)}</p>
      </div>
    </div>
  );
}

function Editor({ draft, setDraft, templates, onClose }: { draft: Draft | null; setDraft(d: Draft | null): void; templates: Template[]; onClose(): void }) {
  const qc = useQueryClient();
  const projects = useApp((s) => s.projects);
  const save = useMutation({
    mutationFn: (d: Draft) => {
      const body = {
        name: d.name, description: d.description, steps: d.steps.filter((s) => s.prompt.trim()), approval: d.approval, projectId: d.projectId, workspace: d.workspace.trim() || null,
        trigger: d.trigger === 'schedule' ? { type: 'schedule', cron: toCron(d.schedule), timezone: d.timezone } : { type: d.trigger },
      };
      return d.id ? api.patch(`/api/automations/${d.id}`, body) : api.post('/api/automations', body);
    },
    onSuccess: (_r, d) => { toast.success(d.id ? 'Automation saved' : 'Automation created'); onClose(); void qc.invalidateQueries({ queryKey: ['automations'] }); },
    onError: (e: Error) => toast.error(e.message),
  });
  if (!draft) return <Dialog open={false} onOpenChange={() => {}}><DialogContent><DialogTitle className="sr-only">Automation</DialogTitle></DialogContent></Dialog>;
  const d = draft;
  const set = (patch: Partial<Draft>) => setDraft({ ...d, ...patch });
  const setStep = (i: number, patch: Partial<AutomationStep>) => set({ steps: d.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const move = (i: number, by: number) => { const steps = [...d.steps]; const [x] = steps.splice(i, 1); steps.splice(i + by, 0, x); set({ steps }); };
  const valid = d.name.trim() && d.steps.some((s) => s.prompt.trim());
  const TRIGGERS: { id: TriggerType; label: string; hint: string; icon: React.ReactNode }[] = [
    { id: 'schedule', label: 'On a schedule', hint: 'Runs by itself at set times', icon: <CalendarClock /> },
    { id: 'webhook', label: 'When called', hint: 'A URL other tools can hit', icon: <Webhook /> },
    { id: 'manual', label: 'By hand', hint: 'Only when you press Run', icon: <Hand /> },
  ];

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="md:top-[6vh] md:max-h-[88vh] md:w-[min(720px,calc(100vw-32px))]">
        <form className="flex min-h-0 flex-col" onSubmit={(e) => { e.preventDefault(); if (valid) save.mutate(d); }}>
          <DialogHeader>
            <DialogTitle>{d.id ? 'Edit automation' : 'New automation'}</DialogTitle>
            <DialogDescription>A job shmakk does for you. Each run gets its own chat, so you can read what happened and pick it up from there.</DialogDescription>
          </DialogHeader>
          <DialogBody className="gap-4">
            {!d.id && templates.length ? (
              <Field label="Start from a template (optional)">
                <Select onValueChange={(v) => { const t = templates.find((x) => x.id === v); if (t) set({ name: d.name || t.name.replace(/^\w/, (c) => c.toUpperCase()), description: t.description, steps: t.steps }); }}>
                  <SelectTrigger aria-label="Template"><SelectValue placeholder="Blank automation" /></SelectTrigger>
                  <SelectContent>{templates.map((t) => <SelectItem key={t.id} value={t.id}>{t.name} — {t.steps.length} steps</SelectItem>)}</SelectContent>
                </Select>
              </Field>
            ) : null}
            <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
              <Field label="Name" htmlFor="au-name"><Input id="au-name" autoFocus={!d.id} value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="Morning repo digest" /></Field>
              <Field label="What is it for? (optional)" htmlFor="au-desc"><Input id="au-desc" value={d.description} onChange={(e) => set({ description: e.target.value })} /></Field>
            </div>

            <div className="grid gap-2">
              <span className="text-[12.5px] font-medium text-dim">Steps — run in order, each building on the last</span>
              {d.steps.map((s, i) => (
                <div key={i} className="grid grid-cols-[auto_1fr_auto] gap-2.5 rounded-xl border border-line bg-raised p-2.5">
                  <span className="mt-1.5 grid size-6 place-items-center rounded-full bg-warn/15 font-mono text-xs font-semibold text-warn">{i + 1}</span>
                  <div className="grid min-w-0 gap-1.5">
                    <Input value={s.title} onChange={(e) => setStep(i, { title: e.target.value })} placeholder="Step name (optional)" aria-label={`Step ${i + 1} name`} className="h-8 touch:h-10" />
                    <Textarea value={s.prompt} onChange={(e) => setStep(i, { prompt: e.target.value })} aria-label={`Step ${i + 1} instructions`} className="min-h-20 font-sans text-[13.5px]"
                      placeholder={i === 0 ? 'What should shmakk do? Write it so it makes sense on its own, e.g. “List the commits from the last 24 hours and summarise them in five bullets.”' : 'What happens next?'} />
                  </div>
                  <div className="grid content-start gap-0.5">
                    <Button variant="ghost" size="icon-sm" aria-label="Move step up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp /></Button>
                    <Button variant="ghost" size="icon-sm" aria-label="Move step down" disabled={i === d.steps.length - 1} onClick={() => move(i, 1)}><ArrowDown /></Button>
                    <Button variant="ghost" size="icon-sm" aria-label="Remove step" disabled={d.steps.length === 1} onClick={() => set({ steps: d.steps.filter((_x, j) => j !== i) })}><X /></Button>
                  </div>
                </div>
              ))}
              {d.steps.length < 12 ? <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => set({ steps: [...d.steps, { title: '', prompt: '' }] })}><Plus />Add step</Button> : null}
            </div>

            <div className="grid gap-2">
              <span className="text-[12.5px] font-medium text-dim">When does it run?</span>
              <div className="grid grid-cols-3 gap-2 max-sm:grid-cols-1" role="radiogroup" aria-label="Trigger">
                {TRIGGERS.map((t) => (
                  <button key={t.id} type="button" role="radio" aria-checked={d.trigger === t.id} onClick={() => set({ trigger: t.id })}
                    className={cn('grid gap-0.5 rounded-xl border border-line bg-raised p-3 text-left', d.trigger === t.id && 'border-accent/50 bg-accent/10 ring-1 ring-accent/30')}>
                    <span className="flex items-center gap-2 font-semibold [&_svg]:size-4">{t.icon}{t.label}</span><span className="text-[12.5px] text-dim">{t.hint}</span>
                  </button>
                ))}
              </div>
              {d.trigger === 'schedule' ? <ScheduleBuilder value={d.schedule} onChange={(schedule) => set({ schedule })} timezone={d.timezone} onTimezone={(timezone) => set({ timezone })} /> : null}
              {d.trigger === 'webhook' ? <p className="m-0 text-[13px] text-dim">After saving you get a private URL. A POST to it starts a run, and the request body is handed to the first step.</p> : null}
            </div>

            <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
              <Field label="Without you watching, it may…" hint={d.approval === 'full' ? 'Includes deleting files and running any command. Only for automations you fully trust.' : d.approval === 'ask' ? 'The run pauses until you answer in its chat (up to an hour).' : 'Anything risky is skipped and noted in the run.'}>
                <Select value={d.approval} onValueChange={(v) => set({ approval: v as Draft['approval'] })}>
                  <SelectTrigger aria-label="Permissions"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Read, edit files and run safe commands</SelectItem>
                    <SelectItem value="ask">Ask me before anything that needs approval</SelectItem>
                    <SelectItem value="full">Do everything, including risky commands</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Project">
                <Select value={d.projectId || '__none'} onValueChange={(v) => set({ projectId: v === '__none' ? null : v })}>
                  <SelectTrigger aria-label="Project"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="__none">No project</SelectItem>{projects.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
              <Field label="Workspace folder (optional)" htmlFor="au-ws" hint="Where the run works. Empty = the project’s folder, or the current workspace." className="col-span-full">
                <Input id="au-ws" value={d.workspace} onChange={(e) => set({ workspace: e.target.value })} className="font-mono text-[13px]" spellCheck={false} autoCapitalize="off" />
              </Field>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant="primary" type="submit" disabled={!valid || save.isPending}>{d.id ? 'Save' : 'Create automation'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Card({ a, onEdit }: { a: Automation; onEdit(): void }) {
  const qc = useQueryClient();
  const openConv = useApp((s) => s.openConv);
  const project = useApp((s) => s.projects.find((p) => p.id === a.projectId));
  const [open, setOpen] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['automations'] });
  const patch = useMutation({ mutationFn: (body: Record<string, unknown>) => api.patch(`/api/automations/${a.id}`, body), onSuccess: refresh, onError: (e: Error) => toast.error(e.message) });
  const run = useMutation({ mutationFn: () => api.post<{ convId: string }>(`/api/automations/${a.id}/run`), onSuccess: () => { toast(`${a.name} started`); void refresh(); }, onError: (e: Error) => toast.error(e.message) });
  const remove = useMutation({ mutationFn: () => api.del(`/api/automations/${a.id}`), onSuccess: () => { toast('Automation deleted'); void refresh(); } });
  const copyHook = async () => {
    try { const r = await api.get<{ path: string }>(`/api/automations/${a.id}/webhook`); if (await copyText(`${location.origin}${r.path}`)) toast.success('Webhook URL copied — treat it like a password'); }
    catch (e) { toast.error((e as Error).message); }
  };
  const last = a.runs[0];
  const icon = a.trigger.type === 'schedule' ? <CalendarClock /> : a.trigger.type === 'webhook' ? <Webhook /> : <Hand />;

  return (
    <article className={cn('grid gap-3 rounded-2xl border border-line bg-raised p-4', !a.enabled && 'opacity-70')}>
      <header className="flex items-start gap-3">
        <span className="mt-0.5 grid size-10 shrink-0 place-items-center rounded-xl bg-warn/12 text-warn [&_svg]:size-5"><Zap /></span>
        <div className="min-w-0 flex-1">
          <h3 className="m-0 truncate text-[15.5px] font-semibold">{a.name}</h3>
          <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] text-dim [&_svg]:size-3.5">
            <span className="inline-flex items-center gap-1.5">{icon}{a.trigger.type === 'schedule' ? a.schedule : a.trigger.type === 'webhook' ? 'When its webhook is called' : 'When you run it'}</span>
            {a.trigger.type === 'schedule' ? <span className="text-faint">· {a.trigger.timezone}</span> : null}
            <span className="text-faint">· {a.steps.length} step{a.steps.length === 1 ? '' : 's'}</span>
            {project ? <span className="text-faint">· {project.name}</span> : null}
          </p>
        </div>
        <Switch checked={a.enabled} onCheckedChange={(v) => patch.mutate({ enabled: v })} aria-label={`${a.name} enabled`} className="mt-1.5" />
      </header>

      {a.description ? <p className="m-0 text-[13.5px] text-dim">{a.description}</p> : null}

      <div className="flex flex-wrap items-center gap-2">
        {a.running ? <Badge tone="info"><Spinner className="size-3 text-info" />running{last ? ` · step ${last.step}/${last.steps}` : ''}</Badge>
          : last ? <Badge tone={STATUS[last.status]?.tone}>{STATUS[last.status]?.label ?? last.status} · {relTime(last.at)}</Badge> : <Badge>never run</Badge>}
        {a.enabled && a.nextRunAt ? <span className="text-[13px] text-dim">Next: <span className="text-fg">{when(a.nextRunAt)}</span></span> : null}
        {!a.enabled ? <span className="text-[13px] text-faint">Paused</span> : null}
        <span className="flex-1" />
        <Button size="sm" variant="primary" disabled={a.running || run.isPending} onClick={() => run.mutate()}><Play />Run now</Button>
        <Button size="sm" onClick={onEdit}><Pencil />Edit</Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`More for ${a.name}`}><MoreHorizontal /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {a.trigger.type === 'webhook' ? <><DropdownMenuLabel>Webhook</DropdownMenuLabel><DropdownMenuItem onSelect={() => void copyHook()}><Copy />Copy webhook URL</DropdownMenuItem><DropdownMenuSeparator /></> : null}
            <DropdownMenuItem danger onSelect={() => { if (confirm(`Delete “${a.name}”? Past runs stay in your chats.`)) remove.mutate(); }}><Trash2 />Delete</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {a.runs.length ? (
        <div className="border-t border-line pt-2">
          <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="inline-flex items-center gap-1.5 text-[13px] text-dim hover:text-fg">
            <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />Run history · {a.runs.length}
          </button>
          {open ? (
            <ul className="m-0 mt-2 grid list-none gap-1 p-0">
              {a.runs.slice(0, 10).map((r) => (
                <li key={r.id}>
                  <button type="button" onClick={() => void openConv(r.convId)} className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-hover">
                    <Badge tone={STATUS[r.status]?.tone}>{STATUS[r.status]?.label ?? r.status}</Badge>
                    <span className="shrink-0 text-[13px]">{when(r.at)}</span>
                    <span className="shrink-0 font-mono text-[11.5px] text-faint">{r.trigger}{r.durationMs ? ` · ${dur(r.durationMs)}` : ''}</span>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-dim">{r.summary}</span>
                    <ChevronRight className="size-3.5 shrink-0 text-faint" />
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

export function AutomationsView() {
  const { data, isLoading } = useQuery({ queryKey: ['automations'], queryFn: () => api.get<Data>('/api/automations'), refetchInterval: 30000 });
  const pendingProject = useApp((s) => (s.view === 'automations' ? s.projectId : null));
  const setDraftText = useApp((s) => s.setDraft);
  const [draft, setDraft] = useState<Draft | null>(null);
  const tz = data?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const list = data?.automations ?? [];
  const scheduled = list.filter((a) => a.enabled && a.nextRunAt).sort((a, b) => (a.nextRunAt || 0) - (b.nextRunAt || 0));

  return (
    <Page
      lead="Jobs shmakk does for you — on a schedule, when a webhook is called, or when you press Run. You can also just ask for one in a Cowork chat."
      actions={<Button variant="primary" onClick={() => setDraft(blank(Intl.DateTimeFormat().resolvedOptions().timeZone || tz, null))}><Plus />New automation</Button>}
    >
      {isLoading ? <Loading /> : list.length === 0 ? (
        <Empty icon={<Zap />} title="No automations yet">
          Create one here, or describe it in a Cowork chat.
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            <Button size="sm" variant="primary" onClick={() => setDraft(blank(tz, pendingProject))}><Plus />New automation</Button>
            <Button size="sm" onClick={() => { useApp.getState().newChat({ mode: 'cowork' }); setDraftText('Every weekday at 9, summarise what changed in this repo since yesterday'); }}>Ask in chat instead</Button>
          </div>
        </Empty>
      ) : (
        <>
          {scheduled.length ? (
            <div className="flex items-center gap-3 rounded-2xl border border-line bg-raised px-4 py-3">
              <CalendarClock className="size-5 shrink-0 text-warn" />
              <span className="min-w-0 flex-1 text-[13.5px]">Up next: <strong>{scheduled[0].name}</strong> <span className="text-dim">— {when(scheduled[0].nextRunAt!)} ({until(scheduled[0].nextRunAt!)})</span></span>
              <span className="shrink-0 font-mono text-xs text-faint">{scheduled.length} scheduled</span>
            </div>
          ) : null}
          <div className="grid gap-3">{list.map((a) => <Card key={a.id} a={a} onEdit={() => setDraft(toDraft(a, tz))} />)}</div>
        </>
      )}
      <Editor draft={draft} setDraft={setDraft} templates={data?.templates ?? []} onClose={() => setDraft(null)} />
    </Page>
  );
}

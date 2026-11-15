import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderKanban, Link2, Link2Off, Plus, Settings2, Trash2, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { MODES, PROJECT_COLORS } from "@/lib/modes";
import type { Automation, ConvMeta, Mode, Project } from '@/lib/types';
import { cn, relTime, tildify } from '@/lib/utils';
import { useApp } from '@/store/app';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/input';
import { Empty, Spinner } from '@/components/ui/misc';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Loading, Page, Row, Rows, Section } from './Page';

interface ProjectData { project: Project; conversations: ConvMeta[]; automations: Automation[] }

function SettingsDialog({ project, open, onOpenChange }: { project: Project; open: boolean; onOpenChange(o: boolean): void }) {
  const qc = useQueryClient();
  const home = useApp((s) => s.home);
  const [form, setForm] = useState(project);
  useEffect(() => { if (open) setForm(project); }, [open, project]);
  const save = useMutation({
    mutationFn: () => api.patch(`/api/projects/${project.id}`, { name: form.name, description: form.description, instructions: form.instructions, color: form.color, workspace: form.workspace || '' }),
    onSuccess: () => { toast.success('Project saved'); onOpenChange(false); void qc.invalidateQueries({ queryKey: ['project'] }); },
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/api/projects/${project.id}`),
    onSuccess: () => { toast('Project deleted — its chats were kept'); onOpenChange(false); useApp.getState().newChat(); },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="md:w-[min(620px,calc(100vw-32px))]">
        <form className="flex min-h-0 flex-col" onSubmit={(e) => { e.preventDefault(); if (form.name.trim()) save.mutate(); }}>
          <DialogHeader><DialogTitle>Project settings</DialogTitle><DialogDescription>Applies to every chat in this project, whatever its mode.</DialogDescription></DialogHeader>
          <DialogBody>
            <Field label="Name" htmlFor="ps-name"><Input id="ps-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label="Description" htmlFor="ps-desc"><Input id="ps-desc" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
            <Field label="System prompt" htmlFor="ps-inst" hint="Prepended to every chat in this project, after your global prompt: brand voice, tech stack, do’s and don’ts.">
              <Textarea id="ps-inst" value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} className="min-h-32 font-sans" placeholder="We use TypeScript and Tailwind. Tone: warm and plain-spoken. Never touch the billing module." />
            </Field>
            <Field label="Workspace folder (optional)" htmlFor="ps-ws" hint={`Code and Cowork chats in this project start here${home ? `, e.g. ${tildify(`${home}/code/site`, home)}` : ''}. Leave empty to use the current workspace.`}>
              <Input id="ps-ws" value={form.workspace || ''} onChange={(e) => setForm({ ...form, workspace: e.target.value })} className="font-mono text-[13px]" spellCheck={false} autoCapitalize="off" />
            </Field>
            <Field label="Colour">
              <div className="flex gap-2">{Object.entries(PROJECT_COLORS).map(([id, cls]) => (
                <button key={id} type="button" aria-label={id} aria-pressed={form.color === id} onClick={() => setForm({ ...form, color: id })} className={cn('size-7 rounded-full ring-offset-2 ring-offset-raised', cls, form.color === id && 'ring-2 ring-fg')} />
              ))}</div>
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="danger" className="md:mr-auto" onClick={() => { if (confirm(`Delete the project “${project.name}”? Its chats are kept.`)) remove.mutate(); }}><Trash2 />Delete project</Button>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button variant="primary" type="submit" disabled={!form.name.trim() || save.isPending}>Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ProjectView() {
  const qc = useQueryClient();
  const id = useApp((s) => s.projectId);
  const runs = useApp((s) => s.runs);
  const convTick = useApp((s) => s.convs.length);
  const { newChat, openConv, setView } = useApp.getState();
  const [settings, setSettings] = useState(false);
  const { data, isLoading, error } = useQuery({ queryKey: ['project', id, convTick], queryFn: () => api.get<ProjectData>(`/api/projects/${id}`), enabled: !!id, placeholderData: (p) => p });
  const share = useMutation({
    mutationFn: (v: boolean) => api.patch(`/api/projects/${id}`, { shareContext: v }),
    onSuccess: (_r, v) => { toast(v ? 'Chats in this project now share context' : 'Chats in this project are now isolated'); void qc.invalidateQueries({ queryKey: ['project'] }); },
  });

  if (error) return <Page><Empty icon={<FolderKanban />} title="Project not found">It may have been deleted.</Empty></Page>;
  if (isLoading || !data) return <Page><Loading /></Page>;
  const { project, conversations, automations } = data;
  const byMode = (m: Mode) => conversations.filter((c) => c.mode === m);

  return (
    <Page>
      <header className="flex items-start gap-4">
        <span className={cn('mt-1 grid size-12 shrink-0 place-items-center rounded-2xl text-bg [&_svg]:size-6', PROJECT_COLORS[project.color] || 'bg-accent')}><FolderKanban /></span>
        <div className="min-w-0 flex-1">
          <h2 className="m-0 truncate text-[26px] font-semibold tracking-tight max-md:text-[22px]">{project.name}</h2>
          <p className="m-0 text-dim">{project.description || 'Chats from every mode, in one place.'}</p>
        </div>
        <Button onClick={() => setSettings(true)}><Settings2 /><span className="max-sm:hidden">Settings</span></Button>
      </header>

      {/* The one decision a project makes */}
      <label className={cn('flex items-center gap-3.5 rounded-2xl border px-4 py-3.5', project.shareContext ? 'border-accent/35 bg-accent/10' : 'border-line bg-raised')}>
        {project.shareContext ? <Link2 className="size-5 shrink-0 text-accent" /> : <Link2Off className="size-5 shrink-0 text-faint" />}
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="font-semibold">{project.shareContext ? 'Chats share context' : 'Chats are isolated'}</span>
          <span className="text-[13.5px] text-dim">
            {project.shareContext
              ? 'Every chat here can see what the others decided and made — a Code chat can read the designs, a Cowork task knows what was built.'
              : 'Each chat only knows the project’s system prompt. Nothing said or made in one chat reaches another.'}
          </span>
        </span>
        <Switch checked={project.shareContext} onCheckedChange={(v) => share.mutate(v)} aria-label="Share context between chats" />
      </label>

      <Section title="Start something in this project">
        <div className="grid grid-cols-4 gap-2.5 max-md:grid-cols-2">
          {MODES.map((m) => (
            <button key={m.id} type="button" onClick={() => newChat({ mode: m.id, projectId: project.id })}
              className="grid content-start gap-1 rounded-2xl border border-line bg-raised p-3.5 text-left transition-[border-color,transform] hover:-translate-y-px hover:border-accent/40">
              <span className={cn('flex items-center gap-2 font-semibold [&_svg]:size-4', m.tone)}>{m.icon}{m.label}<Plus className="ml-auto !size-3.5 text-faint" /></span>
              <span className="text-[12.5px] text-dim">{m.tagline}</span>
            </button>
          ))}
        </div>
      </Section>

      {project.instructions ? (
        <Section title="System prompt"><p className="m-0 line-clamp-4 whitespace-pre-wrap rounded-2xl border border-line bg-raised px-4 py-3 text-[13.5px] text-dim">{project.instructions}</p></Section>
      ) : null}

      <Section title={`Chats · ${conversations.length}`}>
        {conversations.length === 0 ? (
          <Empty icon={<FolderKanban />} title="No chats yet">Start one above, or move an existing chat here from its menu in the sidebar.</Empty>
        ) : MODES.filter((m) => byMode(m.id).length).map((m) => (
          <div key={m.id} className="grid gap-1.5">
            <div className={cn('flex items-center gap-1.5 font-mono text-[10.5px] font-semibold uppercase tracking-wider [&_svg]:size-3.5', m.tone)}>{m.icon}{m.label}</div>
            <Rows>
              {byMode(m.id).map((c) => (
                <Row key={c.id} title={<button type="button" className="max-w-full truncate text-left hover:text-accent" onClick={() => void openConv(c.id)}>{c.title}</button>} sub={<span className="line-clamp-1">{c.preview || 'No messages yet'}</span>}>
                  {c.id in runs ? <Badge tone="ok"><Spinner className="size-3" />working</Badge> : <span className="shrink-0 text-xs text-faint">{relTime(c.updatedAt)}</span>}
                  <Button size="sm" onClick={() => void openConv(c.id)}>Open</Button>
                </Row>
              ))}
            </Rows>
          </div>
        ))}
      </Section>

      {automations.length ? (
        <Section title={`Automations · ${automations.length}`} aside={<Button variant="ghost" size="sm" onClick={() => setView('automations')}>Manage</Button>}>
          <Rows>
            {automations.map((a) => (
              <Row key={a.id} title={<span className="inline-flex items-center gap-2"><Zap className="size-4 text-warn" />{a.name}</span>} sub={a.schedule || (a.trigger.type === 'webhook' ? 'Runs when its webhook is called' : 'Runs when you start it')}>
                <Badge tone={a.enabled ? 'ok' : 'neutral'}>{a.enabled ? 'on' : 'off'}</Badge>
              </Row>
            ))}
          </Rows>
        </Section>
      ) : null}

      <SettingsDialog project={project} open={settings} onOpenChange={setSettings} />
    </Page>
  );
}

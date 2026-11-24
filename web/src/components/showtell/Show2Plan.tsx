import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, FileCode2, ListChecks, Loader2, Mic, MicOff, MonitorPlay, Play, Plus, RotateCcw, Save, SkipForward, Square, Trash2, Workflow } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useApp } from '@/store/app';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Segmented, Spinner } from '@/components/ui/misc';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { TaskDrafts } from '@/components/work/TaskDrafts';
import { speechRecognitionAvailable, type LiveSegment } from '@/lib/recorder';
import { useRecording, type Deliverable } from '@/lib/recordingStore';
import { useSessionStatus } from './RecordingBar';
import type { PlanFull, ProposedTask } from '@/lib/work';

/** One replay action, as normalized by src/services/automation.js. */
interface AutomationStep {
  index: number;
  surface: 'browser' | 'desktop';
  action: string;
  target?: string | null;
  name?: string | null;
  role?: string | null;
  value?: string | null;
  key?: string | null;
  input?: string | null;
  detail?: string | null;
  expected?: string | null;
  evidence?: string[];
}
interface AutomationInput { name: string; label?: string | null; example?: string | null }
interface AutomationResult {
  surface: 'browser' | 'desktop';
  url: string | null;
  app: string | null;
  goal: string | null;
  summary: string | null;
  inputs: AutomationInput[];
  steps: AutomationStep[];
  warnings: string[];
  uncertain?: string[];
}

/** One request found in a clip, with the tasks written for it. */
interface Topic {
  title: string;
  kind: 'bug' | 'change' | 'feature' | 'question';
  summary: string;
  quote: string | null;
  start: number;
  end: number;
  frames: { file: string; t: number; transcript: string | null }[];
  tasks: ProposedTask[];
  filesRead: string[];
  toolCalls: number;
}
type TopicDraft = Topic & { include: boolean };

interface ClipResult {
  mode: Deliverable;
  title: string;
  summary: string;
  topics?: Topic[];
  automation?: AutomationResult;
  transcript: { text: string; segments: LiveSegment[]; source: string };
  uncertain: string[];
}
interface ClipStatus {
  n: number; stage: string; error: string | null; warnings: string[]; durationSec: number; result: ClipResult | null;
  progress: { done: number; total: number; topic: string | null; note: string | null } | null;
}

const STAGE_LABEL: Record<string, string> = {
  recording: 'Uploading', queued: 'Queued', transcribing: 'Transcribing what you said', topics: 'Understanding the request', investigating: 'Reading the code',
};

/** One line for a replay step, in the words the run itself will use. */
function stepLabel(s: AutomationStep): string {
  const on = s.target ? ` on "${s.target}"` : '';
  switch (s.action) {
    case 'click': return `Click ${s.target || s.name || 'the control'}`;
    case 'dblclick': case 'rightclick': return `${s.action === 'dblclick' ? 'Double click' : 'Right click'} ${s.target || s.name || 'the control'}`;
    case 'type': return `Type "${s.value ?? (s.input ? `{{${s.input}}}` : '')}"${on}`;
    case 'press': return `Press ${s.key || 'Enter'}${on}`;
    case 'select': return `Select "${s.value ?? ''}"${on}`;
    case 'navigate': return `Open ${s.value || s.target || 'the page'}`;
    case 'launch': return `Launch ${s.value || s.target || 'the app'}`;
    case 'scroll': return `Scroll${s.target ? ` in ${s.target}` : ''}${s.value ? ` ${s.value}` : ''}`;
    case 'wait': return `Wait for ${s.target || 'the element'}`;
    default: return s.detail || s.target || s.action;
  }
}

const fmt = (sec: number) => { const s = Math.max(0, Math.floor(sec)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/**
 * Show & tell. Record your screen and talk; press "Next task" whenever you
 * move on to something else. Each task is analysed in the background while
 * you keep recording: the request is understood from what you said and
 * showed, then investigated in the codebase. After Stop you review the tasks
 * and send them to Plans, where every task is reviewed before it counts.
 */
export function Show2Plan() {
  const open = useApp((s) => s.show2planOpen);
  const setOpen = useApp((s) => s.setShow2plan);
  const openPlan = useApp((s) => s.openPlan);
  const voiceLanguage = useApp((s) => s.settings.voiceLanguage);
  const rec = useRecording();

  const [deliverable, setDeliverable] = useState<Deliverable>('tasks');
  const [useMic, setUseMic] = useState(true);
  const [drafts, setDrafts] = useState<Record<number, TopicDraft[]>>({});
  const [steps, setSteps] = useState<AutomationStep[] | null>(null);
  const [planPerTopic, setPlanPerTopic] = useState(false);
  const [title, setTitle] = useState('');
  const [signoff, setSignoff] = useState(true);
  const [creating, setCreating] = useState(false);

  const reviewing = rec.phase === 'review';
  const sessionId = rec.sessionId;
  const status = useSessionStatus(reviewing ? sessionId : null, reviewing);
  const serverClips = (status.data?.clips ?? []) as unknown as ClipStatus[];
  const clips = rec.clips.filter((c) => c.state !== 'skipped').map((c) => ({ local: c, srv: serverClips.find((x) => x.n === c.n) }));
  const pending = clips.filter(({ local, srv }) => local.state !== 'failed' && (!srv || (srv.stage !== 'done' && srv.stage !== 'error')));

  // Take each clip's tasks into the editable drafts when its analysis lands.
  useEffect(() => {
    const next: Record<number, TopicDraft[]> = {};
    let changed = false;
    for (const c of serverClips) {
      if (c.stage === 'done' && c.result && drafts[c.n] === undefined) {
        next[c.n] = (c.result.topics ?? []).map((t) => ({ ...t, include: true }));
        if (c.result.automation && steps === null) setSteps(c.result.automation.steps);
        if (!title && c.result.title) setTitle(c.result.title);
        changed = true;
      }
    }
    if (changed) setDrafts((d) => ({ ...d, ...next }));
  }, [serverClips, drafts, steps, title]);

  // A fresh dialog for a fresh recording.
  useEffect(() => { if (rec.phase === 'idle' || rec.phase === 'starting') { setDrafts({}); setSteps(null); setTitle(''); setPlanPerTopic(false); } }, [rec.phase]);

  const allTopics = useMemo(() => Object.keys(drafts).map(Number).sort((a, b) => a - b).flatMap((n) => drafts[n].map((t) => ({ clip: n, topic: t }))), [drafts]);
  const included = allTopics.filter(({ topic }) => topic.include && topic.tasks.length && topic.kind !== 'question');
  const taskCount = included.reduce((n, { topic }) => n + topic.tasks.length, 0);
  const questions = serverClips.flatMap((c) => c.result?.uncertain ?? []);
  const automation = serverClips.find((c) => c.result?.mode === 'automation')?.result ?? null;

  const close = () => {
    if (rec.phase === 'recording' || rec.phase === 'finishing' || rec.phase === 'starting') { setOpen(false); return; }
    if (reviewing && (taskCount || pending.length) && !window.confirm('Close and discard these tasks?')) return;
    if (reviewing) rec.discard();
    setOpen(false);
  };

  const start = async () => {
    const lang = voiceLanguage && /^[a-z]{2}(-[A-Z]{2})?$/.test(voiceLanguage) ? voiceLanguage : navigator.language || 'en-US';
    const ok = await rec.start({ microphone: useMic, deliverable, lang });
    if (ok) setOpen(false);
  };

  const retryClip = async (n: number) => {
    if (!sessionId) return;
    try { await api.post(`/api/show2plan/${sessionId}/process`, { clip: n, mode: rec.deliverable, oneRequest: true }); void status.refetch(); }
    catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
  };

  const createPlan = async (startNow: boolean) => {
    if (!sessionId) return;
    setCreating(true);
    try {
      const tagged = (t: Topic) => t.tasks.map((x) => ({ ...x, instructions: `_Request: ${t.title}_\n\n${x.instructions}` }));
      const groups = planPerTopic
        ? included.map(({ topic: t }) => ({ title: t.title, summary: [t.summary, t.quote ? `In their words: "${t.quote}"` : null].filter(Boolean).join('\n\n'), tasks: t.tasks }))
        : [{ title: title || included[0]?.topic.title || 'Show & tell', summary: included.map(({ topic: t }, i) => `${i + 1}. ${t.title}: ${t.summary}`).join('\n'), tasks: included.flatMap(({ topic }) => tagged(topic)) }];
      const plans: PlanFull[] = [];
      for (const g of groups) plans.push(await api.post<PlanFull>('/api/plans', { title: g.title, source: 'show2plan', requireSignoff: signoff, show2planId: sessionId, tasks: g.tasks, summary: g.summary }));
      // Plans running side by side would edit the same workspace at once.
      if (startNow && plans.length === 1) await api.post(`/api/plans/${plans[0].id}/run`);
      rec.discard();
      setOpen(false);
      toast.success(plans.length > 1 ? `${plans.length} plans created. Start them one at a time in Plans.` : startNow ? 'Plan started' : 'Plan created', { action: { label: 'Open', onClick: () => openPlan(plans[0].id) } });
      openPlan(plans[0].id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const saveAutomation = async () => {
    const spec = automation?.automation;
    if (!automation || !spec || !steps?.length) return;
    setCreating(true);
    try {
      // Save the spec, not a prose description of it: a playback automation
      // replays these exact actions, so nothing has to reinterpret them later.
      await api.post('/api/automations', {
        name: title || spec.goal || 'Recorded automation', description: spec.summary || '',
        playback: {
          surface: spec.surface, url: spec.url, app: spec.app,
          goal: spec.goal, inputs: spec.inputs, steps,
        },
        approval: 'ask', projectId: null, workspace: null, trigger: { type: 'manual' },
      });
      rec.discard();
      setOpen(false);
      useApp.getState().setMode('cowork');
      useApp.getState().setView('automations');
      toast.success('Automation saved to Cowork');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const frameSrc = (file: string) => `/api/show2plan/${sessionId}/frames/${file}`;
  const recordingNow = rec.phase === 'recording' || rec.phase === 'finishing' || rec.phase === 'starting';

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className={cn(reviewing && 'md:w-[min(780px,calc(100vw-32px))]')}>
        <DialogHeader>
          <DialogTitle>{reviewing ? (automation ? 'Review the automation' : 'Review the tasks') : recordingNow ? 'Recording' : 'Show & tell'}</DialogTitle>
          <DialogDescription>
            {reviewing
              ? automation ? 'The steps you did and said, in order. Edit or remove any, then save it to Cowork.' : 'One section per task you recorded. Edit anything that is off; each task is reviewed against its acceptance criteria before it counts as done.'
              : recordingNow ? 'Use the recording controls at the bottom of the screen.' : 'Record your screen and talk through what should change. Press Next task whenever you move on to something else.'}
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          {!reviewing && !recordingNow ? (
            <div className="grid gap-3.5">
              {deliverable === 'tasks' ? (
                <ol className="m-0 grid gap-1.5 pl-5 text-[13px] text-dim">
                  <li>Choose the screen, window or tab to share. A control bar appears with <b className="font-semibold text-fg">Pause</b>, <b className="font-semibold text-fg">Next task</b> and <b className="font-semibold text-fg">Stop</b>; pop it out to keep it on top while you show other apps.</li>
                  <li>Show and tell one thing: "this button is too small", "saving here throws an error".</li>
                  <li>Press <b className="font-semibold text-fg">Next task</b> and go on with the next thing. The previous task is analysed in the background, against the code, while you keep recording.</li>
                  <li>Press <b className="font-semibold text-fg">Stop</b> and review the tasks before they go to Plans.</li>
                </ol>
              ) : null}
              <Segmented<Deliverable>
                label="Deliverable" value={deliverable} onChange={setDeliverable} fullWidth
                options={[
                  { value: 'tasks', label: <span className="inline-flex items-center gap-1.5"><ListChecks className="size-3.5" />Tasks</span> },
                  { value: 'automation', label: <span className="inline-flex items-center gap-1.5"><Workflow className="size-3.5" />Automation</span> },
                ]}
              />
              {deliverable === 'automation' ? <p className="m-0 text-[12.5px] text-dim">Do the steps while you say them ("click Export, choose CSV, save"). They become a Cowork automation you can rerun. Needs a vision-capable model.</p> : null}
              <label className="inline-flex items-center gap-2 text-[13px] text-dim">
                <Switch checked={useMic} onCheckedChange={setUseMic} />
                {useMic ? <Mic className="size-4" /> : <MicOff className="size-4" />}Record my microphone
              </label>
              {useMic && !speechRecognitionAvailable() ? <p className="m-0 text-[12px] text-faint">This browser has no live speech recognition, so transcription relies on the server's speech-to-text.</p> : null}
              {rec.error ? <p className="m-0 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{rec.error}</p> : null}
            </div>
          ) : null}

          {recordingNow ? (
            <div className="grid gap-2 text-[13px] text-dim">
              <p className="m-0">Recording task {rec.clip + 1}. Close this dialog; the controls stay at the bottom of the screen.</p>
            </div>
          ) : null}

          {reviewing ? (
            <div className="grid gap-3">
              {pending.length ? (
                <p className="m-0 flex items-center gap-2 text-[12.5px] text-dim"><Spinner className="size-3.5" />{pending.length} task{pending.length === 1 ? ' is' : 's are'} still being analysed. You can start editing the finished ones.</p>
              ) : null}

              {automation ? (
                <AutomationEditor result={automation} steps={steps ?? []} onChange={setSteps} />
              ) : (
                <>
                  {clips.length > 1 && !planPerTopic ? (
                    <div className="grid gap-1.5">
                      <label htmlFor="s2p-title" className="text-[12px] font-medium text-dim">Plan title</label>
                      <Input id="s2p-title" value={title} onChange={(e) => setTitle(e.target.value)} />
                    </div>
                  ) : null}
                  {clips.map(({ local, srv }) => {
                    const ds = drafts[local.n];
                    const failed = local.state === 'failed' || srv?.stage === 'error';
                    return (
                      <div key={local.n} className="grid gap-2">
                        <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wide text-faint after:h-px after:flex-1 after:bg-line">
                          Task {local.n + 1}<span className="font-normal normal-case tracking-normal">· {fmt(local.durationSec)} recorded</span>
                        </div>
                        {(srv?.warnings ?? []).map((w) => <p key={w} className="m-0 flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-[12.5px] text-warn"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" />{w}</p>)}
                        {failed ? (
                          <div className="flex items-start gap-2 rounded-xl border border-danger/40 bg-danger/10 px-3 py-2.5 text-[12.5px] text-danger">
                            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /><span className="flex-1">{local.error || srv?.error || 'Analysis failed.'}</span>
                            {srv ? <Button size="sm" onClick={() => void retryClip(local.n)}><RotateCcw />Try again</Button> : null}
                          </div>
                        ) : ds ? (
                          ds.length ? ds.map((t, i) => (
                            <TopicCard key={`${local.n}-${i}`} index={local.n} topic={t} frameSrc={frameSrc}
                              onChange={(next) => setDrafts((d) => ({ ...d, [local.n]: d[local.n].map((x, j) => (j === i ? next : x)) }))} />
                          )) : <p className="m-0 text-[12.5px] text-dim">Nothing to do was found in this part.</p>
                        ) : (
                          <div className="flex items-center gap-2 rounded-xl border border-line px-3 py-3 text-[13px] text-dim">
                            <Loader2 className="size-4 animate-spin text-accent" />
                            <span className="min-w-0 truncate">
                              {STAGE_LABEL[srv?.stage || 'recording'] || 'Working'}
                              {srv?.stage === 'investigating' && srv.progress?.note ? ` · ${srv.progress.note}` : ''}
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {!clips.length ? <p className="m-0 text-[13px] text-dim">Nothing was recorded.</p> : null}
                  {questions.length ? (
                    <div className="grid gap-1 rounded-lg border border-line px-3 py-2">
                      <span className="text-[12px] font-semibold text-dim">Questions to answer first</span>
                      <ul className="m-0 grid gap-0.5 pl-4 text-[12.5px] text-dim">{questions.map((u) => <li key={u}>{u}</li>)}</ul>
                    </div>
                  ) : null}
                  {included.length > 1 ? <label className="inline-flex items-center gap-2 text-[12.5px] text-dim"><Switch checked={planPerTopic} onCheckedChange={setPlanPerTopic} />A separate plan per task (created as drafts; start them one at a time)</label> : null}
                  <label className="inline-flex items-center gap-2 text-[12.5px] text-dim"><Switch checked={signoff} onCheckedChange={setSignoff} />Tasks need my sign-off after they pass review</label>
                </>
              )}
            </div>
          ) : null}
        </DialogBody>

        <DialogFooter>
          {!reviewing && !recordingNow ? (
            <>
              <Button variant="ghost" onClick={close}>Cancel</Button>
              <Button variant="primary" disabled={rec.phase === 'starting'} onClick={() => void start()}>{rec.phase === 'starting' ? <Spinner className="size-4" /> : <MonitorPlay />}Choose screen and start</Button>
            </>
          ) : null}
          {recordingNow ? (
            <>
              <Button variant="ghost" onClick={() => setOpen(false)}>Close</Button>
              {rec.deliverable === 'tasks' ? <Button onClick={() => void rec.next()}><SkipForward />Next task</Button> : null}
              <Button variant="primary" onClick={() => void rec.stop()}><Square />Stop</Button>
            </>
          ) : null}
          {reviewing ? (
            <>
              <Button variant="ghost" onClick={close}><Trash2 />Discard</Button>
              {automation ? (
                <Button variant="primary" disabled={!steps?.length || creating} onClick={() => void saveAutomation()}>{creating ? <Spinner className="size-4" /> : <Save />}Save to Cowork</Button>
              ) : planPerTopic && included.length > 1 ? (
                <Button variant="primary" disabled={!taskCount || creating || pending.length > 0} onClick={() => void createPlan(false)}>{creating ? <Spinner className="size-4" /> : <Plus />}Create {included.length} plans</Button>
              ) : (
                <>
                  <Button disabled={!taskCount || creating || pending.length > 0} onClick={() => void createPlan(false)}><Plus />Create plan</Button>
                  <Button variant="primary" disabled={!taskCount || creating || pending.length > 0} onClick={() => void createPlan(true)}>{creating ? <Spinner className="size-4" /> : pending.length ? <Loader2 className="animate-spin" /> : <Play />}{pending.length ? 'Waiting for analysis' : 'Create and start'}</Button>
                </>
              )}
            </>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AutomationEditor({ result, steps, onChange }: { result: ClipResult; steps: AutomationStep[]; onChange: (a: AutomationStep[]) => void }) {
  const spec = result.automation;
  const patch = (i: number, next: Partial<AutomationStep>) => onChange(steps.map((x, j) => (j === i ? { ...x, ...next } : x)));
  const needsTarget = (a: string) => ['click', 'dblclick', 'rightclick', 'hover', 'type', 'select', 'press'].includes(a);
  return (
    <div className="grid gap-2">
      {result.summary ? <p className="m-0 text-[13.5px] text-fg">{result.summary}</p> : null}
      {spec?.surface ? (
        <p className="m-0 text-[12px] text-faint">
          {spec.surface === 'browser' ? 'Replays in the browser' : 'Replays on the desktop'}
          {spec.url ? ` · starts at ${spec.url}` : spec.app ? ` · in ${spec.app}` : ''}
        </p>
      ) : null}
      {(spec?.warnings ?? []).map((w) => <p key={w} className="m-0 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-[12.5px] text-warn">{w}</p>)}
      {steps.length ? (
        <>
          <ol className="m-0 grid list-none gap-1.5 p-0">
            {steps.map((s, i) => (
              <li key={i} className="flex items-start gap-2 rounded-xl border border-line bg-raised px-3 py-2">
                <span className="mt-1.5 shrink-0 rounded-md bg-accent/15 px-1.5 text-[11px] font-semibold uppercase text-accent">{s.action}</span>
                <div className="grid min-w-0 flex-1 gap-1">
                  <span className="truncate text-[13px] text-fg" title={stepLabel(s)}>{stepLabel(s)}</span>
                  {needsTarget(s.action) ? (
                    <Input
                      value={s.target ?? ''}
                      onChange={(e) => patch(i, { target: e.target.value })}
                      placeholder="What to act on (the control's text or label)"
                      aria-label={`Step ${i + 1} target`}
                      className="h-7 text-[12.5px]"
                    />
                  ) : null}
                  {s.value && s.action !== 'type' && s.action !== 'select' ? <span className="text-[12px] text-faint">value "{s.value}"</span> : null}
                  {s.detail && s.detail !== s.target ? <span className="text-[12px] text-faint">{s.detail}</span> : null}
                </div>
                <Button variant="ghost" size="icon-sm" aria-label="Remove step" onClick={() => onChange(steps.filter((_, j) => j !== i))}><Trash2 /></Button>
              </li>
            ))}
          </ol>
          {spec?.inputs?.length ? (
            <p className="m-0 text-[12px] text-faint">
              Asked for on every run: {spec.inputs.map((i) => `${i.label || i.name}${i.example ? ` (was "${i.example}")` : ''}`).join(', ')}
            </p>
          ) : null}
        </>
      ) : <p className="m-0 text-[13px] text-dim">The recording was understood, but no replayable action came out of it. Do the steps again and name each one out loud as you do it.</p>}
    </div>
  );
}

const KIND_LABEL: Record<Topic['kind'], string> = { bug: 'Bug', change: 'Change', feature: 'Feature', question: 'Question' };

/** One request from the recording: its words, its screenshots, the code read, its tasks. */
function TopicCard({ index, topic, onChange, frameSrc }: { index: number; topic: TopicDraft; onChange: (t: TopicDraft) => void; frameSrc: (file: string) => string }) {
  const [showFiles, setShowFiles] = useState(false);
  return (
    <section className={cn('grid gap-2.5 rounded-2xl border p-3', topic.include ? 'border-line-strong bg-panel' : 'border-line opacity-60')} aria-label={`Request ${index + 1}`}>
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-accent/15 text-[12px] font-semibold text-accent">{index + 1}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <h3 className="m-0 text-[14px] font-semibold text-fg">{topic.title}</h3>
            <span className="text-[11.5px] text-faint">{KIND_LABEL[topic.kind]} · {fmt(topic.start)}-{fmt(topic.end)}</span>
          </div>
          <p className="m-0 mt-0.5 text-[12.5px] text-dim">{topic.summary}</p>
          {topic.quote ? <p className="m-0 mt-1 text-[12px] italic text-faint">"{topic.quote}"</p> : null}
        </div>
        <label className="inline-flex shrink-0 items-center gap-1.5 text-[12px] text-dim"><Switch checked={topic.include} onCheckedChange={(v) => onChange({ ...topic, include: v })} aria-label={`Include request ${index + 1}`} />Include</label>
      </div>
      {topic.include ? (
        <>
          {topic.frames.length ? (
            <div className="flex gap-1.5 overflow-x-auto pb-0.5">
              {topic.frames.map((f) => (
                <a key={f.file} href={frameSrc(f.file)} target="_blank" rel="noreferrer" className="relative shrink-0" title={f.transcript || undefined}>
                  <img src={frameSrc(f.file)} alt={`Screenshot at ${fmt(f.t)}`} loading="lazy" className="h-24 w-auto rounded-md border border-line object-contain" />
                  <span className="absolute bottom-0.5 left-0.5 rounded bg-black/65 px-1 text-[10.5px] text-white">{fmt(f.t)}</span>
                </a>
              ))}
            </div>
          ) : null}
          {topic.filesRead.length ? (
            <div>
              <button type="button" onClick={() => setShowFiles((v) => !v)} aria-expanded={showFiles} className="inline-flex items-center gap-1 text-[12px] text-dim hover:text-fg">
                {showFiles ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}Read {topic.filesRead.length} file{topic.filesRead.length === 1 ? '' : 's'} in the codebase
              </button>
              {showFiles ? (
                <ul className="m-0 mt-1 grid list-none gap-0.5 p-0">
                  {topic.filesRead.map((f) => <li key={f} className="flex items-center gap-1.5 text-[12px] text-faint"><FileCode2 className="size-3 shrink-0" /><span className="truncate">{f}</span></li>)}
                </ul>
              ) : null}
            </div>
          ) : <p className="m-0 text-[12px] text-warn">The code was not investigated for this request; its task has no file references.</p>}
          <TaskDrafts tasks={topic.tasks} onChange={(next) => onChange({ ...topic, tasks: next })} />
        </>
      ) : null}
    </section>
  );
}

export default Show2Plan;

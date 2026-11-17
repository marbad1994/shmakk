import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Camera, Check, ChevronDown, ChevronRight, FileCode2, ListChecks, Mic, MicOff, MonitorPlay, Pause, Play, Plus, Save, Square, Trash2, Workflow, X } from 'lucide-react';
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
import { ScreenRecorder, speechRecognitionAvailable, toWav16k, type LiveSegment } from '@/lib/recorder';
import type { PlanFull, ProposedTask } from '@/lib/work';

type Phase = 'setup' | 'recording' | 'uploading' | 'processing' | 'review';
type Deliverable = 'tasks' | 'automation';

interface AutomationAction { action: string; description: string; target?: string; value?: string | null; key?: string | null }
interface AutomationResult { summary: string; goal: string; actions: AutomationAction[]; warnings: string[] }

/** One distinct request found in the recording, with the tasks written for it. */
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

interface S2PResult {
  mode: Deliverable;
  topics?: Topic[];
  automation?: AutomationResult;
  title: string;
  summary: string;
  app: string | null;
  transcript: { text: string; segments: LiveSegment[]; source: string };
  frames: { file: string; t: number; reason: string; transcript: string | null }[];
  allFrames: number;
  tasks: ProposedTask[];
  via: 'model' | 'fallback';
  uncertain: string[];
}
interface S2PStatus { id: string; stage: string; error: string | null; warnings: string[]; frames: number; result: S2PResult | null; progress: { done: number; total: number; topic: string | null; note: string | null } | null }

const STAGES: { id: string; label: string }[] = [
  { id: 'uploading', label: 'Uploading audio' },
  { id: 'transcribing', label: 'Transcribing what you said' },
  { id: 'topics', label: 'Finding the separate requests' },
  { id: 'investigating', label: 'Reading the code for each request' },
];

/** The prompt a Cowork automation step runs, from one recorded action. */
function stepPrompt(a: AutomationAction): string {
  const on = a.target ? ` on "${a.target}"` : '';
  switch (a.action) {
    case 'click': return `Click ${a.target || a.description}`;
    case 'type': return `Type "${a.value ?? ''}"${on}`;
    case 'press': return `Press ${a.key || 'Enter'}${on}`;
    case 'select': return `Select "${a.value ?? ''}"${on}`;
    case 'navigate': return `Open ${a.value || a.target || 'the page'}`;
    case 'wait': case 'waitSelector': return `Wait for ${a.target || 'the element'}`;
    default: return a.description || a.action;
  }
}

const fmt = (sec: number) => { const s = Math.max(0, Math.floor(sec)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/**
 * Show & tell: record the screen and talk through bugs, changes or tasks.
 * shmakk samples the screen across the whole recording (and on every visual
 * changes), reads them with the transcript, and drafts tasks grounded in the
 * workspace. You review them, then they go to Plans, where every task is
 * reviewed before it counts as done.
 */
export function Show2Plan() {
  const open = useApp((s) => s.show2planOpen);
  const setOpen = useApp((s) => s.setShow2plan);
  const openPlan = useApp((s) => s.openPlan);
  const voiceLanguage = useApp((s) => s.settings.voiceLanguage);

  const [phase, setPhase] = useState<Phase>('setup');
  const [deliverable, setDeliverable] = useState<Deliverable>('tasks');
  const [actions, setActions] = useState<AutomationAction[]>([]);
  const [useMic, setUseMic] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [paused, setPaused] = useState(false);
  const [frames, setFrames] = useState(0);
  const [level, setLevel] = useState(0);
  const [segments, setSegments] = useState<LiveSegment[]>([]);
  const [interim, setInterim] = useState('');
  const [micNote, setMicNote] = useState<string | null>(null);
  const [tasks, setTasks] = useState<ProposedTask[]>([]);
  const [topics, setTopics] = useState<TopicDraft[]>([]);
  const [planPerTopic, setPlanPerTopic] = useState(false);
  const [title, setTitle] = useState('');
  const [signoff, setSignoff] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const recRef = useRef<ScreenRecorder | null>(null);
  const previewRef = useRef<HTMLVideoElement>(null);
  const stoppingRef = useRef(false);
  const sessionRef = useRef<string | null>(null);
  sessionRef.current = sessionId;

  const status = useQuery({
    queryKey: ['show2plan', sessionId],
    queryFn: () => api.get<S2PStatus>(`/api/show2plan/${sessionId}`),
    enabled: !!sessionId && phase === 'processing',
    refetchInterval: 1200,
  });

  const reset = useCallback(() => {
    recRef.current?.release();
    recRef.current = null;
    stoppingRef.current = false;
    setPhase('setup'); setError(null); setSessionId(null); setElapsed(0); setPaused(false); setFrames(0);
    setLevel(0); setSegments([]); setInterim(''); setMicNote(null); setTasks([]); setTopics([]); setTitle(''); setShowTranscript(false);
  }, []);

  useEffect(() => { if (open) { reset(); setActions([]); } }, [open, reset]);

  const discard = useCallback(() => {
    const id = sessionId;
    recRef.current?.release();
    recRef.current = null;
    if (id) void api.del(`/api/show2plan/${id}`).catch(() => {});
  }, [sessionId]);

  const close = () => { discard(); setOpen(false); };

  // Timer while recording.
  useEffect(() => {
    if (phase !== 'recording') return;
    const t = window.setInterval(() => setElapsed(recRef.current?.elapsed() ?? 0), 250);
    return () => window.clearInterval(t);
  }, [phase]);

  // Show what is being shared once the preview element exists.
  useEffect(() => {
    if (phase !== 'recording') return;
    const v = previewRef.current;
    const stream = recRef.current?.stream;
    if (v && stream && v.srcObject !== stream) { v.srcObject = stream; void v.play().catch(() => {}); }
  }, [phase]);

  // Done processing → review.
  useEffect(() => {
    const d = status.data;
    if (!d || phase !== 'processing') return;
    if (d.stage === 'done' && d.result) {
      setTasks(d.result.tasks);
      setTopics((d.result.topics ?? []).map((t) => ({ ...t, include: true })));
      setActions(d.result.automation?.actions ?? []);
      setTitle(d.result.title);
      setPhase('review');
    } else if (d.stage === 'error') {
      setError(d.error || 'Processing failed');
    }
  }, [status.data, phase]);

  const start = async () => {
    setError(null);
    let id: string | null = null;
    try {
      const s = await api.post<{ id: string }>('/api/show2plan');
      id = s.id;
      sessionRef.current = id;
      setSessionId(id);
      const rec = new ScreenRecorder(id, {
        onFrame: (n) => setFrames(n),
        onLevel: setLevel,
        onTranscript: (segs, live) => { setSegments(segs); setInterim(live); },
        onEnded: () => { void stop(); },
        onError: setMicNote,
      }, voiceLanguage && /^[a-z]{2}(-[A-Z]{2})?$/.test(voiceLanguage) ? voiceLanguage : navigator.language || 'en-US');
      await rec.start({ microphone: useMic });
      recRef.current = rec;
      setPhase('recording');
    } catch (e) {
      if (id) void api.del(`/api/show2plan/${id}`).catch(() => {});
      setSessionId(null);
      const msg = e instanceof Error ? e.message : String(e);
      setError(/denied|NotAllowed|Permission/i.test(msg) ? 'Screen sharing was cancelled or blocked. Click Start and choose a screen, window or tab to share.' : msg);
    }
  };

  const stop = async () => {
    const rec = recRef.current;
    const sessionId = sessionRef.current;
    if (!rec || !sessionId || stoppingRef.current) return;
    stoppingRef.current = true;
    setPhase('uploading');
    try {
      const r = await rec.stop();
      recRef.current = null;
      if (r.audio && r.audio.size > 2000) {
        try {
          const wav = await toWav16k(r.audio);
          await api.upload(`/api/show2plan/${sessionId}/audio`, wav, 'audio/wav');
        } catch {
          toast.message('The audio could not be converted; using the live transcript instead.');
        }
      }
      await api.post(`/api/show2plan/${sessionId}/process`, {
        mode: deliverable,
        durationSec: r.durationSec,
        liveTranscript: { segments: r.segments },
      });
      setPhase('processing');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('processing');
    }
  };

  const retry = async () => {
    if (!sessionId) return;
    setError(null);
    try {
      await api.post(`/api/show2plan/${sessionId}/process`, { mode: deliverable, liveTranscript: { segments } });
      void status.refetch();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const togglePause = () => {
    const rec = recRef.current;
    if (!rec) return;
    if (rec.paused) rec.resume(); else rec.pause();
    setPaused(rec.paused);
  };


  const included = topics.filter((t) => t.include && t.tasks.length);
  const taskCount = topics.length ? included.reduce((n, t) => n + t.tasks.length, 0) : tasks.length;

  const createPlan = async (startNow: boolean) => {
    if (!sessionId) return;
    setCreating(true);
    try {
      const result = status.data?.result;
      const narration = result?.transcript.text ? `Narration: "${result.transcript.text.slice(0, 1500)}"` : null;
      // Each task says which request it belongs to: plans hold tasks from several.
      const tagged = (t: Topic) => t.tasks.map((x) => ({ ...x, instructions: `_Request: ${t.title}_\n\n${x.instructions}` }));
      const groups = !topics.length
        ? [{ title, summary: result?.summary || '', tasks }]
        : planPerTopic
          ? included.map((t) => ({ title: t.title, summary: [t.summary, t.quote ? `In their words: "${t.quote}"` : null].filter(Boolean).join('\n\n'), tasks: t.tasks }))
          : [{ title, summary: [result?.summary, ...included.map((t, i) => `${i + 1}. ${t.title}: ${t.summary}`)].filter(Boolean).join('\n'), tasks: included.flatMap(tagged) }];
      const plans: PlanFull[] = [];
      for (const g of groups) {
        plans.push(await api.post<PlanFull>('/api/plans', { title: g.title, source: 'show2plan', requireSignoff: signoff, show2planId: sessionId, tasks: g.tasks, summary: [g.summary, narration].filter(Boolean).join('\n\n') }));
      }
      // Plans running side by side would edit the same workspace at once, so
      // only a single plan is started; separate plans are left as drafts.
      if (startNow && plans.length === 1) await api.post(`/api/plans/${plans[0].id}/run`);
      discard();
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
    const r = status.data?.result;
    if (!r) return;
    setCreating(true);
    try {
      await api.post('/api/automations', {
        name: title || r.title || 'Recorded automation',
        description: r.summary || '',
        steps: actions.map((a) => ({ title: a.description || a.target || a.action, prompt: stepPrompt(a) })),
        approval: 'ask', projectId: null, workspace: null, trigger: { type: 'manual' },
      });
      discard();
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
  const result = status.data?.result ?? null;
  const warnings = status.data?.warnings ?? [];
  const stageIdx = phase === 'uploading' ? 0 : Math.max(0, STAGES.findIndex((s) => s.id === status.data?.stage));
  const hasSpeech = speechRecognitionAvailable();

  const header: Record<Phase, { title: string; desc: string }> = {
    setup: { title: 'Show & tell', desc: 'Record your screen and talk through bugs, changes or tasks. shmakk keeps the key moments and turns what you say into tasks for this workspace.' },
    recording: { title: 'Recording', desc: 'Click through the product and say what is wrong or should change, as you show it. Keep the shared window visible.' },
    uploading: { title: 'Finishing up', desc: 'Sending the recording to shmakk.' },
    processing: { title: 'Making tasks', desc: 'This usually takes under a minute.' },
    review: status.data?.result?.mode === 'automation'
      ? { title: 'Review the automation', desc: 'The steps you did and said, in order. Edit or remove any, then save it to Cowork.' }
      : { title: 'Review the tasks', desc: 'Edit anything that is off. Each task is reviewed against its acceptance criteria before it counts as done.' },
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className={cn(phase === 'review' && 'md:w-[min(760px,calc(100vw-32px))]')} onInteractOutside={(e) => { if (phase === 'recording' || phase === 'uploading') e.preventDefault(); }}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">{phase === 'recording' ? <span className={cn('size-2.5 rounded-full bg-danger', !paused && 'animate-pulse')} /> : null}{header[phase].title}</DialogTitle>
          <DialogDescription>{header[phase].desc}</DialogDescription>
        </DialogHeader>

        <DialogBody>
          {phase === 'setup' ? (
            <div className="grid gap-3.5">
              {deliverable === 'tasks' ? <ol className="m-0 grid gap-1.5 pl-5 text-[13px] text-dim">
                <li>Choose the screen, window or tab that shows the problem.</li>
                <li>Talk while you click around: "this button is too small", "this should show the date", "saving here throws an error".</li>
                <li>Stop. You get tasks with instructions and acceptance criteria to check before they go to Plans.</li>
              </ol> : null}
              <Segmented<Deliverable>
                label="Deliverable"
                value={deliverable}
                onChange={setDeliverable}
                fullWidth
                options={[
                  { value: 'tasks', label: <span className="inline-flex items-center gap-1.5"><ListChecks className="size-3.5" />Tasks</span> },
                  { value: 'automation', label: <span className="inline-flex items-center gap-1.5"><Workflow className="size-3.5" />Automation</span> },
                ]}
              />
              {deliverable === 'automation' ? <p className="m-0 text-[12.5px] text-dim">Do the steps while you say them ("click Export, choose CSV, save"). They become a Cowork automation you can rerun. Needs a vision-capable model.</p> : null}
              <label className="inline-flex items-center gap-2 text-[13px] text-dim">
                <Switch checked={useMic} onCheckedChange={setUseMic} />
                {useMic ? <Mic className="size-4" /> : <MicOff className="size-4" />}
                Record my microphone
              </label>
              {useMic && !hasSpeech ? <p className="m-0 text-[12px] text-faint">This browser has no live speech recognition, so transcription relies on the server's speech-to-text (npm run setup:voice).</p> : null}
              {error ? <p className="m-0 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</p> : null}
            </div>
          ) : null}

          {phase === 'recording' ? (
            <div className="grid gap-3">
              <div className="relative overflow-hidden rounded-xl border border-line bg-black">
                <video ref={previewRef} muted playsInline className="aspect-video w-full object-contain" />
                <div className="absolute left-2 top-2 rounded-md bg-black/65 px-2 py-0.5 text-[13px] font-semibold tabular-nums text-white">{fmt(elapsed)}</div>
                {paused ? <div className="absolute inset-0 grid place-items-center bg-black/50 text-[14px] font-semibold text-white">Paused</div> : null}
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-dim">
                {useMic ? (
                  <span className="inline-flex items-center gap-2"><Mic className="size-3.5" />
                    <span className="h-1.5 w-20 overflow-hidden rounded-full bg-line"><span className="block h-full rounded-full bg-accent transition-[width] duration-75" style={{ width: `${Math.round(level * 100)}%` }} /></span>
                  </span>
                ) : null}
                <span>{frames} moment{frames === 1 ? '' : 's'} kept</span>
              </div>
              {micNote ? <p className="m-0 text-[12px] text-warn">{micNote}</p> : null}
              {segments.length || interim ? (
                <div className="max-h-28 overflow-y-auto rounded-lg border border-line bg-sunken px-3 py-2 text-[12.5px] text-dim">
                  {segments.slice(-6).map((s, i) => <span key={i}>{s.text} </span>)}
                  {interim ? <span className="text-faint">{interim}</span> : null}
                </div>
              ) : useMic && hasSpeech ? <p className="m-0 text-[12px] text-faint">Start talking: the live transcript shows up here.</p> : null}
            </div>
          ) : null}

          {phase === 'uploading' || phase === 'processing' ? (
            <div className="grid gap-2.5">
              <ol className="m-0 grid list-none gap-1.5 p-0">
                {STAGES.map((s, i) => {
                  const done = i < stageIdx || status.data?.stage === 'done';
                  const active = i === stageIdx && !error;
                  return (
                    <li key={s.id} className={cn('flex items-center gap-2.5 rounded-lg border px-3 py-2 text-[13px]', active ? 'border-line-strong bg-panel' : 'border-transparent')}>
                      {done ? <Check className="size-4 text-accent" /> : active ? <Spinner className="size-4" /> : <span className={cn('size-4 rounded-full border-2', error && i === stageIdx ? 'border-danger' : 'border-line')} />}
                      <span className="grid min-w-0">
                        <span className={done ? 'text-fg' : 'text-dim'}>{s.label}</span>
                        {active && s.id === 'investigating' && status.data?.progress?.total ? (
                          <span className="truncate text-[12px] text-faint">
                            Request {Math.min(status.data.progress.done + 1, status.data.progress.total)} of {status.data.progress.total}{status.data.progress.topic ? `: ${status.data.progress.topic}` : ''}{status.data.progress.note ? ` · ${status.data.progress.note}` : ''}
                          </span>
                        ) : null}
                      </span>
                    </li>
                  );
                })}
              </ol>
              {error ? <p className="m-0 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</p> : null}
            </div>
          ) : null}

          {phase === 'review' && result ? (
            <div className="grid gap-3">
              {result.summary ? <p className="m-0 text-[13.5px] text-fg">{result.summary}</p> : null}
              {warnings.map((w) => <p key={w} className="m-0 flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-[12.5px] text-warn"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" />{w}</p>)}

              {result.transcript.text ? (
                <div>
                  <button type="button" className="inline-flex items-center gap-1 text-[12.5px] text-dim hover:text-fg" onClick={() => setShowTranscript((v) => !v)} aria-expanded={showTranscript}>
                    {showTranscript ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}What you said ({result.transcript.source === 'browser' ? 'live transcript' : result.transcript.source === 'xai' ? 'xAI speech-to-text' : result.transcript.source === 'deepseek' ? 'DeepSeek speech-to-text' : 'Whisper'})
                  </button>
                  {showTranscript ? <p className="m-0 mt-1.5 rounded-lg border border-line bg-sunken px-3 py-2 text-[12.5px] text-dim">{result.transcript.text}</p> : null}
                </div>
              ) : null}

              {result.mode !== 'automation' && !planPerTopic ? (
                <div className="grid gap-1.5">
                  <label htmlFor="s2p-title" className="text-[12px] font-medium text-dim">Plan title</label>
                  <Input id="s2p-title" value={title} onChange={(e) => setTitle(e.target.value)} />
                </div>
              ) : null}
              {result.mode === 'automation' ? (
                <div className="grid gap-2">
                  {(result.automation?.warnings ?? []).map((w) => <p key={w} className="m-0 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-[12.5px] text-warn">{w}</p>)}
                  {actions.length ? (
                    <ol className="m-0 grid list-none gap-1.5 p-0">
                      {actions.map((a, i) => (
                        <li key={i} className="flex items-start gap-2 rounded-xl border border-line bg-raised px-3 py-2">
                          <span className="mt-1.5 shrink-0 rounded-md bg-accent/15 px-1.5 text-[11px] font-semibold uppercase text-accent">{a.action}</span>
                          <div className="grid min-w-0 flex-1 gap-1">
                            <Input value={a.description} onChange={(e) => setActions(actions.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} aria-label={`Step ${i + 1}`} className="h-8 text-[13px]" />
                            {a.target || a.value ? <span className="text-[12px] text-faint">{[a.target && `on ${a.target}`, a.value && `value "${a.value}"`].filter(Boolean).join(' · ')}</span> : null}
                          </div>
                          <Button variant="ghost" size="icon-sm" aria-label="Remove step" onClick={() => setActions(actions.filter((_, j) => j !== i))}><Trash2 /></Button>
                        </li>
                      ))}
                    </ol>
                  ) : <p className="m-0 text-[13px] text-dim">No steps were recognised. Record again and say each action as you do it.</p>}
                </div>
              ) : topics.length ? (
                <div className="grid gap-3">
                  <p className="m-0 text-[12.5px] font-medium text-dim">{topics.length === 1 ? '1 request in this recording' : `${topics.length} separate requests in this recording`}</p>
                  {topics.map((t, i) => (
                    <TopicCard key={`${i}-${t.title}`} index={i} topic={t} frameSrc={frameSrc}
                      onChange={(next) => setTopics(topics.map((x, j) => (j === i ? next : x)))} />
                  ))}
                  {topics.length > 1 ? (
                    <label className="inline-flex items-center gap-2 text-[12.5px] text-dim"><Switch checked={planPerTopic} onCheckedChange={setPlanPerTopic} />A separate plan per request (created as drafts; start them one at a time)</label>
                  ) : null}
                </div>
              ) : tasks.length ? <TaskDrafts tasks={tasks} onChange={setTasks} frameSrc={frameSrc} /> : (
                <div className="grid gap-2 rounded-lg border border-dashed border-line-strong px-3 py-4 text-center text-[13px] text-dim">
                  No tasks came out of this recording.
                  <div><Button size="sm" onClick={() => setTasks([{ key: 'n1', title: '', kind: 'change', layer: 'frontend', priority: 'normal', instructions: '', acceptance: [], files: [], dependsOn: [], questions: [] }])}><Plus />Write one</Button></div>
                </div>
              )}
              {result.uncertain.length ? (
                <div className="grid gap-1 rounded-lg border border-line px-3 py-2">
                  <span className="text-[12px] font-semibold text-dim">Questions to answer first</span>
                  <ul className="m-0 grid gap-0.5 pl-4 text-[12.5px] text-dim">{result.uncertain.map((u) => <li key={u}>{u}</li>)}</ul>
                </div>
              ) : null}
              {result.mode !== 'automation' ? <label className="inline-flex items-center gap-2 text-[12.5px] text-dim"><Switch checked={signoff} onCheckedChange={setSignoff} />Tasks need my sign-off after they pass review</label> : null}
            </div>
          ) : null}
        </DialogBody>

        <DialogFooter>
          {phase === 'setup' ? (
            <>
              <Button variant="ghost" onClick={close}>Cancel</Button>
              <Button variant="primary" onClick={() => void start()}><MonitorPlay />Choose screen and start</Button>
            </>
          ) : null}
          {phase === 'recording' ? (
            <>
              <Button variant="ghost" onClick={() => { discard(); reset(); }}><X />Discard</Button>
              <Button onClick={togglePause}>{paused ? <Play /> : <Pause />}{paused ? 'Resume' : 'Pause'}</Button>
              <Button variant="primary" onClick={() => void stop()}><Square />Stop and make tasks</Button>
            </>
          ) : null}
          {phase === 'processing' && error ? (
            <>
              <Button variant="ghost" onClick={() => { discard(); reset(); }}><Camera />Record again</Button>
              <Button variant="primary" onClick={() => void retry()}>Try again</Button>
            </>
          ) : null}
          {phase === 'review' ? (
            <>
              <Button variant="ghost" onClick={() => { discard(); reset(); }}><Camera />Record again</Button>
              {result?.mode === 'automation' ? (
                <Button variant="primary" disabled={!actions.length || creating} onClick={() => void saveAutomation()}>{creating ? <Spinner className="size-4" /> : <Save />}Save to Cowork</Button>
              ) : (
                <>
                  {planPerTopic && included.length > 1 ? (
                    <Button variant="primary" disabled={!taskCount || creating} onClick={() => void createPlan(false)}>{creating ? <Spinner className="size-4" /> : <Plus />}Create {included.length} plans</Button>
                  ) : (
                    <>
                      <Button disabled={!taskCount || creating} onClick={() => void createPlan(false)}><Plus />Create plan</Button>
                      <Button variant="primary" disabled={!taskCount || creating} onClick={() => void createPlan(true)}>{creating ? <Spinner className="size-4" /> : <Play />}Create and start</Button>
                    </>
                  )}
                </>
              )}
            </>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
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

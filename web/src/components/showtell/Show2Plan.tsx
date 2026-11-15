import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Bookmark, Camera, Check, ChevronDown, ChevronRight, Mic, MicOff, MonitorPlay, Pause, Play, Plus, Square, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useApp } from '@/store/app';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/misc';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { TaskDrafts } from '@/components/work/TaskDrafts';
import { ScreenRecorder, speechRecognitionAvailable, toWav16k, type LiveSegment } from '@/lib/recorder';
import type { PlanFull, ProposedTask } from '@/lib/work';

type Phase = 'setup' | 'recording' | 'uploading' | 'processing' | 'review';

interface S2PResult {
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
interface S2PStatus { id: string; stage: string; error: string | null; warnings: string[]; frames: number; result: S2PResult | null }

const STAGES: { id: string; label: string }[] = [
  { id: 'uploading', label: 'Uploading audio' },
  { id: 'transcribing', label: 'Transcribing what you said' },
  { id: 'selecting', label: 'Picking the key moments' },
  { id: 'analyzing', label: 'Reading the screenshots' },
  { id: 'planning', label: 'Turning it into tasks for this codebase' },
];

const fmt = (sec: number) => { const s = Math.max(0, Math.floor(sec)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const field = 'w-full rounded-[10px] border border-line-strong bg-sunken px-3 py-2 font-sans text-[13px] leading-relaxed text-fg outline-none placeholder:text-faint focus:border-accent/45 focus:ring-[3px] focus:ring-accent/15';

/**
 * Show & tell: record the screen and talk through bugs, changes or tasks.
 * shmakk keeps the moments that matter (speech cues, your marks, visual
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
  const [note, setNote] = useState('');
  const [useMic, setUseMic] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [paused, setPaused] = useState(false);
  const [frames, setFrames] = useState(0);
  const [marks, setMarks] = useState(0);
  const [level, setLevel] = useState(0);
  const [segments, setSegments] = useState<LiveSegment[]>([]);
  const [interim, setInterim] = useState('');
  const [micNote, setMicNote] = useState<string | null>(null);
  const [tasks, setTasks] = useState<ProposedTask[]>([]);
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
    setPhase('setup'); setError(null); setSessionId(null); setElapsed(0); setPaused(false); setFrames(0); setMarks(0);
    setLevel(0); setSegments([]); setInterim(''); setMicNote(null); setTasks([]); setTitle(''); setShowTranscript(false);
  }, []);

  useEffect(() => { if (open) { reset(); setNote(''); } }, [open, reset]);

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
        onFrame: (n, marked) => { setFrames(n); if (marked) setMarks((m) => m + 1); },
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
        instructions: note,
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
      await api.post(`/api/show2plan/${sessionId}/process`, { instructions: note, liveTranscript: { segments } });
      void status.refetch();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const togglePause = () => {
    const rec = recRef.current;
    if (!rec) return;
    if (rec.paused) rec.resume(); else rec.pause();
    setPaused(rec.paused);
  };

  // M marks the moment while recording (when the dialog has focus).
  useEffect(() => {
    if (phase !== 'recording') return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'm' || e.key === 'M') && !(e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement)) { e.preventDefault(); recRef.current?.mark(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase]);

  const createPlan = async (startNow: boolean) => {
    if (!sessionId) return;
    setCreating(true);
    try {
      const result = status.data?.result;
      const plan = await api.post<PlanFull>('/api/plans', {
        title, source: 'show2plan', requireSignoff: signoff, show2planId: sessionId, tasks,
        summary: [result?.summary, result?.transcript.text ? `Narration: "${result.transcript.text.slice(0, 1500)}"` : null].filter(Boolean).join('\n\n'),
      });
      if (startNow) await api.post(`/api/plans/${plan.id}/run`);
      discard();
      setOpen(false);
      toast.success(startNow ? 'Plan started' : 'Plan created', { action: { label: 'Open', onClick: () => openPlan(plan.id) } });
      openPlan(plan.id);
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
    recording: { title: 'Recording', desc: 'Point at things and say what is wrong or what should change. Press Mark when the screen shows exactly what you mean.' },
    uploading: { title: 'Finishing up', desc: 'Sending the recording to shmakk.' },
    processing: { title: 'Making tasks', desc: 'This usually takes under a minute.' },
    review: { title: 'Review the tasks', desc: 'Edit anything that is off. Each task is reviewed against its acceptance criteria before it counts as done.' },
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
              <ol className="m-0 grid gap-1.5 pl-5 text-[13px] text-dim">
                <li>Choose the screen, window or tab that shows the problem.</li>
                <li>Talk while you click around: "this button is too small", "this should show the date", "saving here throws an error".</li>
                <li>Stop. You get tasks with instructions and acceptance criteria to check before they go to Plans.</li>
              </ol>
              <div className="grid gap-1.5">
                <label htmlFor="s2p-note" className="text-[12.5px] font-medium text-dim">Anything to say up front? <span className="text-faint">(optional)</span></label>
                <textarea id="s2p-note" className={cn(field, 'min-h-16 resize-y')} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Checkout flow on mobile, the bugs we saw in yesterday's demo" />
              </div>
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
                {marks ? <span className="text-violet">{marks} marked</span> : null}
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
                      <span className={done ? 'text-fg' : 'text-dim'}>{s.label}</span>
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

              {result.frames.length ? (
                <div className="grid gap-1.5">
                  <span className="text-[12px] font-medium text-dim">Key moments ({result.frames.length} of {result.allFrames} kept)</span>
                  <div className="flex gap-1.5 overflow-x-auto pb-1">
                    {result.frames.map((f) => (
                      <a key={f.file} href={frameSrc(f.file)} target="_blank" rel="noreferrer" className="relative shrink-0" title={f.transcript || f.reason}>
                        <img src={frameSrc(f.file)} alt={`Moment at ${fmt(f.t)}`} loading="lazy" className="h-20 w-auto rounded-md border border-line object-contain" />
                        <span className="absolute bottom-0.5 left-0.5 rounded bg-black/65 px-1 text-[10.5px] text-white">{fmt(f.t)}{f.reason === 'marked' ? ' · marked' : ''}</span>
                      </a>
                    ))}
                  </div>
                </div>
              ) : null}

              {result.transcript.text ? (
                <div>
                  <button type="button" className="inline-flex items-center gap-1 text-[12.5px] text-dim hover:text-fg" onClick={() => setShowTranscript((v) => !v)} aria-expanded={showTranscript}>
                    {showTranscript ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}What you said ({result.transcript.source === 'whisper' ? 'server transcription' : 'live transcript'})
                  </button>
                  {showTranscript ? <p className="m-0 mt-1.5 rounded-lg border border-line bg-sunken px-3 py-2 text-[12.5px] text-dim">{result.transcript.text}</p> : null}
                </div>
              ) : null}

              <div className="grid gap-1.5">
                <label htmlFor="s2p-title" className="text-[12px] font-medium text-dim">Plan title</label>
                <Input id="s2p-title" value={title} onChange={(e) => setTitle(e.target.value)} />
              </div>
              {tasks.length ? <TaskDrafts tasks={tasks} onChange={setTasks} frameSrc={frameSrc} /> : (
                <div className="grid gap-2 rounded-lg border border-dashed border-line-strong px-3 py-4 text-center text-[13px] text-dim">
                  No tasks came out of this recording.
                  <div><Button size="sm" onClick={() => setTasks([{ key: 'n1', title: '', kind: 'change', layer: 'frontend', priority: 'normal', instructions: '', acceptance: [], files: [], dependsOn: [], questions: [] }])}><Plus />Write one</Button></div>
                </div>
              )}
              {result.uncertain.length ? (
                <div className="grid gap-1 rounded-lg border border-line px-3 py-2">
                  <span className="text-[12px] font-semibold text-dim">Unclear from the recording</span>
                  <ul className="m-0 grid gap-0.5 pl-4 text-[12.5px] text-dim">{result.uncertain.map((u) => <li key={u}>{u}</li>)}</ul>
                </div>
              ) : null}
              <label className="inline-flex items-center gap-2 text-[12.5px] text-dim"><Switch checked={signoff} onCheckedChange={setSignoff} />Tasks need my sign-off after they pass review</label>
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
              <Button onClick={() => recRef.current?.mark()} title="Shortcut: M"><Bookmark />Mark moment</Button>
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
              <Button disabled={!tasks.length || creating} onClick={() => void createPlan(false)}><Plus />Create plan</Button>
              <Button variant="primary" disabled={!tasks.length || creating} onClick={() => void createPlan(true)}>{creating ? <Spinner className="size-4" /> : <Play />}Create and start</Button>
            </>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default Show2Plan;

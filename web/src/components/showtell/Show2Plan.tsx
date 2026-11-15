import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, Camera, Check, ChevronLeft, ImagePlus, ListChecks, MapPin, Mic, MonitorPlay, Pencil, Play, Plus, RefreshCw, Save, Send, Square, Trash2, Workflow, X,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useApp } from '@/store/app';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Card, Empty, Segmented, Spinner } from '@/components/ui/misc';
import { Input, Textarea } from '@/components/ui/input';

// ── wire types (mirror src/webui/api.js capture routes) ──────────────────────

export type Show2PlanMode = 'plan' | 'automation';
export type Show2PlanPhase = 'setup' | 'recording' | 'processing' | 'review';

export interface CaptureVideo {
  backend: string;
  label: string;
  note?: string | null;
  display?: string;
}

export interface CaptureAudio {
  backend: string;
  label: string;
  device?: string;
}

export interface CaptureCapabilities {
  available: boolean;
  platform: string;
  sessionType: string | null;
  ffmpeg: string | null;
  ffprobe: string | null;
  video: CaptureVideo | null;
  audio: CaptureAudio | null;
  reasons: string[];
}

export interface CaptureSession {
  id: string;
  state: 'idle' | 'recording' | 'paused' | 'stopping' | 'done' | 'error';
  fps: number;
  width: number | null;
  height: number | null;
  traceAudio: boolean;
  video: { backend: string; label: string; note?: string | null } | null;
  audio: { backend: string; label: string } | null;
  startedAt: string | null;
  stoppedAt: string | null;
  frameCount: number;
  audioBlocks: number;
  durationSec: number;
  paths: Record<string, string>;
  error: string | null;
}

export interface FrameEntry {
  index: number;
  t: number;
  path: string;
  file: string;
  bytes: number;
  transcript?: string | null;
  width?: number | null;
  height?: number | null;
  [k: string]: unknown;
}

export interface FramesSummary {
  id: string;
  mediaPath: string;
  durationSec: number;
  fps: number | null;
  budget: number;
  requested: number;
  extracted: number;
  frames: FrameEntry[];
  skipped: unknown[];
  createdAt: string;
}

export interface PlanTask {
  id: string;
  /** Location line, "page > element". */
  title: string;
  /** What the user said needs to change. */
  description: string;
  page: string | null;
  element: string | null;
  evidence?: { frames?: number[]; transcript?: string | null; confidence?: number | null };
}

export interface PlanResult {
  id: string;
  kind: 'plan';
  title: string;
  goal: string;
  summary: string;
  app: string | null;
  page: string | null;
  status: string;
  createdAt: string;
  tasks: PlanTask[];
  uncertain: string[];
  notes: string[];
  sourceAnalysis?: unknown;
}

export interface AutomationAction {
  action: string;
  description: string;
  target?: string;
  value?: string | null;
  key?: string | null;
  confidence?: number | null;
  frames?: number[];
}

export interface AutomationResult {
  id: string;
  kind: 'automation';
  summary: string;
  goal: string;
  app: string | null;
  status: string;
  createdAt: string;
  actions: AutomationAction[];
  script: string;
  warnings: string[];
  uncertain: string[];
  notes: string[];
  sourceAnalysis?: unknown;
}

export type Show2PlanResult = PlanResult | AutomationResult;

export interface Show2PlanProps {
  /** Override the default plan → Code chat handoff. */
  onSendPlan?: (result: PlanResult) => void | Promise<void>;
  /** Override the default automation → Cowork handoff. */
  onSaveAutomation?: (result: AutomationResult) => void | Promise<void>;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function errMsg(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  return String(e ?? 'Something went wrong');
}

function fmtElapsed(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  return `${m}:${String(ss).padStart(2, '0')}`;
}

function stateLabel(state: CaptureSession['state']): string {
  switch (state) {
    case 'idle': return 'Idle';
    case 'recording': return 'Recording';
    case 'paused': return 'Paused';
    case 'stopping': return 'Stopping';
    case 'done': return 'Done';
    case 'error': return 'Error';
    default: return state;
  }
}

function actionVerb(action: string): string {
  const v: Record<string, string> = {
    click: 'Click', type: 'Type into', press: 'Press', select: 'Select', scroll: 'Scroll',
    hover: 'Hover over', drag: 'Drag', navigate: 'Open', wait: 'Wait for', waitSelector: 'Wait for', other: 'Act on',
  };
  return v[action] || 'Act on';
}

function automationPrompt(a: AutomationAction): string {
  const target = a.target ? ` on "${a.target}"` : '';
  switch (a.action) {
    case 'click': return `Click ${a.target || a.description}`;
    case 'type': return `Type "${a.value ?? ''}"${target}`;
    case 'press': return `Press ${a.key || 'Enter'}${target}`;
    case 'select': return `Select "${a.value ?? ''}"${target}`;
    case 'scroll': return `Scroll to ${a.target || 'the target element'}`;
    case 'hover': return `Hover over ${a.target || 'the target element'}`;
    case 'drag': return `Drag ${a.target || 'the element'}`;
    case 'navigate': return `Open ${a.value || a.target || 'the page'}`;
    case 'wait':
    case 'waitSelector': return `Wait for ${a.target || 'the element'}`;
    default: return a.description || a.action;
  }
}

function planMessage(p: PlanResult): string {
  const head = p.title || p.summary || 'Show and tell notes';
  const lines = [head];
  if (p.summary && p.summary !== head) lines.push(p.summary);
  if (p.page) lines.push(`Page: ${p.page}`);
  lines.push('', 'What needs changing:');
  p.tasks.forEach((t, i) => {
    lines.push(`${i + 1}. ${t.title || t.description}`);
    if (t.description && t.description !== t.title) lines.push(`   ${t.description}`);
    const said = t.evidence?.transcript;
    if (said) lines.push(`   said: "${said}"`);
  });
  if (p.uncertain && p.uncertain.length) {
    lines.push('', 'Open questions:');
    p.uncertain.forEach((u) => lines.push(`- ${u}`));
  }
  return lines.join('\n');
}

// ── editable evidence helpers ───────────────────────────────────────────────

function taskFrameNumbers(t: PlanTask): number[] {
  return Array.isArray(t.evidence?.frames) ? t.evidence.frames : [];
}
function withTaskFrames(t: PlanTask, frames: number[]): PlanTask {
  return { ...t, evidence: { ...t.evidence, frames } };
}
function actionFrameNumbers(a: AutomationAction): number[] {
  return Array.isArray(a.frames) ? a.frames : [];
}
function withActionFrames(a: AutomationAction, frames: number[]): AutomationAction {
  return { ...a, frames };
}

// ── small review pieces ─────────────────────────────────────────────────────

function EvidenceStrip({
  entries, frameSrc, onRemove, onPickerToggle, canAdd,
}: {
  entries: { n: number; file: string }[];
  frameSrc: (file: string) => string;
  onRemove: (n: number) => void;
  onPickerToggle: () => void;
  canAdd: boolean;
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {entries.map((e) => (
        <span key={e.file} className="relative">
          <img
            src={frameSrc(e.file)}
            alt={`Context screenshot ${e.n}`}
            loading="lazy"
            className="h-16 w-auto rounded-md border border-line object-contain"
          />
          <button
            type="button"
            onClick={() => onRemove(e.n)}
            aria-label={`Remove context screenshot ${e.n}`}
            className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full border border-line bg-raised text-dim hover:border-danger hover:bg-danger hover:text-white"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      {canAdd ? (
        <button
          type="button"
          onClick={onPickerToggle}
          aria-label="Add context screenshot"
          className="inline-flex h-16 w-16 flex-col items-center justify-center gap-0.5 rounded-md border border-dashed border-line text-[11px] text-dim hover:border-accent hover:text-accent"
        >
          <ImagePlus className="size-4" />
          Add
        </button>
      ) : null}
    </div>
  );
}

function FramePicker({
  frames, frameSrc, selected, onToggle, onClose,
}: {
  frames: FrameEntry[];
  frameSrc: (file: string) => string;
  selected: number[];
  onToggle: (n: number) => void;
  onClose: () => void;
}) {
  return (
    <div className="mt-2 rounded-lg border border-line-strong bg-sunken p-2">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-[12px] text-dim">Attach screenshots as context</span>
        <Button variant="ghost" size="icon-sm" aria-label="Close screenshot picker" onClick={onClose}>
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="grid max-h-56 grid-cols-4 gap-1.5 overflow-y-auto sm:grid-cols-5">
        {frames.map((f, idx) => {
          const n = idx + 1;
          const on = selected.includes(n);
          return (
            <button
              key={f.file}
              type="button"
              onClick={() => onToggle(n)}
              aria-pressed={on}
              aria-label={`Frame ${n}`}
              className={cn(
                'relative overflow-hidden rounded-md border transition-colors',
                on ? 'border-accent ring-2 ring-accent/40' : 'border-line hover:border-line-strong',
              )}
            >
              <img src={frameSrc(f.file)} alt={`Frame ${n}`} loading="lazy" className="aspect-video w-full object-cover" />
              <span className="absolute bottom-0.5 left-0.5 rounded bg-black/60 px-1 text-[10px] text-white">{n}</span>
              {on ? <Check className="absolute right-0.5 top-0.5 size-3.5 text-accent" /> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── default handoffs (used when the parent does not pass an override) ────────

async function defaultSendPlan(result: PlanResult) {
  const app = useApp.getState();
  app.newChat({ mode: 'code' });
  await app.send(planMessage(result), 'ask');
}

async function defaultSaveAutomation(result: AutomationResult) {
  const steps = result.actions.map((a) => ({
    title: a.description || a.target || actionVerb(a.action),
    prompt: automationPrompt(a),
  }));
  await api.post('/api/automations', {
    name: result.goal || result.summary || 'Recorded automation',
    description: result.summary || result.goal || '',
    steps,
    approval: 'ask',
    projectId: null,
    workspace: null,
    trigger: { type: 'manual' },
  });
  const app = useApp.getState();
  app.setMode('cowork');
  app.setView('automations');
}

// ── component ────────────────────────────────────────────────────────────────

export function Show2Plan({ onSendPlan, onSaveAutomation }: Show2PlanProps = {}) {
  const open = useApp((s) => s.show2planOpen);
  const setOpen = useApp((s) => s.setShow2plan);

  const [phase, setPhase] = useState<Show2PlanPhase>('setup');
  const [mode, setMode] = useState<Show2PlanMode>('plan');
  const [capabilities, setCapabilities] = useState<CaptureCapabilities | null>(null);
  const [capError, setCapError] = useState<string | null>(null);
  const [loadingCapabilities, setLoadingCapabilities] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [session, setSession] = useState<CaptureSession | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [progressIndex, setProgressIndex] = useState(0);
  const [result, setResult] = useState<Show2PlanResult | null>(null);
  const [frames, setFrames] = useState<FramesSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [draftTasks, setDraftTasks] = useState<PlanTask[]>([]);
  const [draftActions, setDraftActions] = useState<AutomationAction[]>([]);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [pickerIndex, setPickerIndex] = useState<number | null>(null);

  const phaseRef = useRef(phase);
  const sessionIdRef = useRef(sessionId);
  const abortRef = useRef<AbortController | null>(null);
  phaseRef.current = phase;
  sessionIdRef.current = sessionId;

  const progressSteps = useMemo(
    () => [
      { id: 'stop', label: 'Stop recording' },
      { id: 'transcribe', label: 'Transcribe audio' },
      { id: 'analyze', label: 'Analyze recording' },
      { id: 'generate', label: mode === 'plan' ? 'Collect notes' : 'Generate automation' },
    ],
    [mode],
  );

  const close = useCallback(() => {
    abortRef.current?.abort();
    if (phaseRef.current === 'recording' && sessionIdRef.current) {
      void api.del(`/api/capture/${sessionIdRef.current}`).catch(() => {});
    }
    setOpen(false);
  }, [setOpen]);

  const loadCapabilities = useCallback(async () => {
    setLoadingCapabilities(true);
    setCapError(null);
    try {
      const r = await api.get<{ capabilities: CaptureCapabilities; sessions: CaptureSession[] }>('/api/capture');
      setCapabilities(r.capabilities);
    } catch (e) {
      setCapError(errMsg(e));
    } finally {
      setLoadingCapabilities(false);
    }
  }, []);

  // Reset to a clean slate each time the modal opens.
  useEffect(() => {
    if (!open) return;
    setPhase('setup');
    setMode('plan');
    setSessionId(null);
    setSession(null);
    setElapsed(0);
    setProgressIndex(0);
    setResult(null);
    setFrames(null);
    setError(null);
    setBusy(false);
    setSending(false);
    setDraftTasks([]);
    setDraftActions([]);
    setEditingIndex(null);
    setPickerIndex(null);
    setCapabilities(null);
    void loadCapabilities();
  }, [open, loadCapabilities]);

  // Abort in-flight work on unmount and stop an orphaned recording.
  useEffect(() => () => {
    abortRef.current?.abort();
    if (phaseRef.current === 'recording' && sessionIdRef.current) {
      void api.del(`/api/capture/${sessionIdRef.current}`).catch(() => {});
    }
  }, []);

  const startRecording = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const m = await api.post<CaptureSession>('/api/capture', {});
      setSessionId(m.id);
      setSession(m);
      setElapsed(m.durationSec || 0);
      setPhase('recording');
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }, []);

  // Live status + elapsed timer while recording.
  useEffect(() => {
    if (phase !== 'recording' || !sessionId) return;
    const id = sessionId;
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      try {
        const m = await api.get<CaptureSession>(`/api/capture/${id}`);
        if (!alive) return;
        setSession(m);
        setElapsed(m.durationSec || 0);
      } catch {
        // Keep ticking locally even if a poll fails; the next one may recover.
      }
    };
    const t = window.setInterval(() => { void tick(); }, 1000);
    void tick();
    return () => { alive = false; window.clearInterval(t); };
  }, [phase, sessionId]);

  const runProcessing = useCallback(async (id: string, chosen: Show2PlanMode) => {
    setPhase('processing');
    setProgressIndex(0);
    setError(null);
    try {
      await api.post(`/api/capture/${id}/stop`);
      setProgressIndex(1);
      await api.post(`/api/capture/${id}/transcribe`);
      setProgressIndex(2);
      await api.post(`/api/capture/${id}/analyze`, {});
      setProgressIndex(3);
      const res = chosen === 'plan'
        ? await api.post<PlanResult>(`/api/capture/${id}/plan`, {})
        : await api.post<AutomationResult>(`/api/capture/${id}/automation`, {});
      setResult(res);
      if (res.kind === 'plan') {
        setDraftTasks(res.tasks.map((t) => ({ ...t, page: t.page || res.page, evidence: { ...t.evidence } })));
        setDraftActions([]);
      } else {
        setDraftActions(res.actions.map((a) => ({ ...a })));
        setDraftTasks([]);
      }
      setEditingIndex(null);
      setPickerIndex(null);
      try {
        setFrames(await api.get<FramesSummary>(`/api/capture/${id}/frames`));
      } catch {
        setFrames(null); // degrade gracefully: no evidence thumbnails
      }
      setPhase('review');
    } catch (e) {
      setError(errMsg(e));
      // Stay in the processing phase so the user can retry or back out.
    }
  }, []);

  const stopRecording = useCallback(async () => {
    if (!sessionId) return;
    setBusy(true);
    setError(null);
    const id = sessionId;
    const chosen = mode;
    try {
      await runProcessing(id, chosen);
    } finally {
      setBusy(false);
    }
  }, [sessionId, mode, runProcessing]);

  const backToSetup = useCallback(() => {
    if (sessionIdRef.current) {
      void api.del(`/api/capture/${sessionIdRef.current}`).catch(() => {});
    }
    setPhase('setup');
    setSessionId(null);
    setSession(null);
    setElapsed(0);
    setProgressIndex(0);
    setResult(null);
    setFrames(null);
    setError(null);
    setDraftTasks([]);
    setDraftActions([]);
    setEditingIndex(null);
    setPickerIndex(null);
    void loadCapabilities();
  }, [loadCapabilities]);

  // The reviewed, editable payload. Drafts start as a copy of the model result
  // and diverge as the user edits, reorders frames, or discards steps.
  const editedResult = useMemo<Show2PlanResult | null>(() => {
    if (!result) return null;
    return result.kind === 'plan'
      ? { ...result, tasks: draftTasks }
      : { ...result, actions: draftActions };
  }, [result, draftTasks, draftActions]);

  const updateTask = useCallback((i: number, next: PlanTask) => {
    setDraftTasks((prev) => prev.map((t, idx) => (idx === i ? next : t)));
  }, []);
  const updateAction = useCallback((i: number, next: AutomationAction) => {
    setDraftActions((prev) => prev.map((a, idx) => (idx === i ? next : a)));
  }, []);
  const discardTask = useCallback((i: number) => {
    setDraftTasks((prev) => prev.filter((_, idx) => idx !== i));
    // Indices shift after a discard, so close any open editor rather than
    // risk editing the wrong note.
    setEditingIndex(null);
    setPickerIndex(null);
  }, []);
  const addFinding = useCallback(() => {
    const page = result && result.kind === 'plan' ? result.page : null;
    setDraftTasks((prev) => [...prev, { id: `note-${Date.now()}`, title: '', description: '', page, element: null, evidence: {} }]);
    setEditingIndex(draftTasks.length);
    setPickerIndex(null);
  }, [draftTasks.length, result]);
  const discardAction = useCallback((i: number) => {
    setDraftActions((prev) => prev.filter((_, idx) => idx !== i));
    setEditingIndex(null);
    setPickerIndex(null);
  }, []);
  const toggleTaskFrame = useCallback((i: number, n: number) => {
    setDraftTasks((prev) => prev.map((t, idx) => {
      if (idx !== i) return t;
      const cur = taskFrameNumbers(t);
      const next = cur.includes(n) ? cur.filter((x) => x !== n) : [...cur, n].sort((a, b) => a - b);
      return withTaskFrames(t, next);
    }));
  }, []);
  const toggleActionFrame = useCallback((i: number, n: number) => {
    setDraftActions((prev) => prev.map((a, idx) => {
      if (idx !== i) return a;
      const cur = actionFrameNumbers(a);
      const next = cur.includes(n) ? cur.filter((x) => x !== n) : [...cur, n].sort((x, y) => x - y);
      return withActionFrames(a, next);
    }));
  }, []);

  const frameSrc = useCallback((file: string) => `/api/capture/${sessionId}/frames/${file}`, [sessionId]);
  const frameEntries = useCallback((numbers?: number[]): { n: number; file: string }[] => {
    if (!frames || !Array.isArray(numbers)) return [];
    return numbers
      .map((n) => ({ n, file: frames.frames[n - 1]?.file ?? '' }))
      .filter((e) => Boolean(e.file));
  }, [frames]);

  const handleSendPlan = useCallback(async () => {
    if (!editedResult || editedResult.kind !== 'plan') return;
    setSending(true);
    try {
      if (onSendPlan) await onSendPlan(editedResult);
      else await defaultSendPlan(editedResult);
      close();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSending(false);
    }
  }, [editedResult, onSendPlan, close]);

  const handleSaveAutomation = useCallback(async () => {
    if (!editedResult || editedResult.kind !== 'automation') return;
    setSending(true);
    try {
      if (onSaveAutomation) await onSaveAutomation(editedResult);
      else await defaultSaveAutomation(editedResult);
      close();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSending(false);
    }
  }, [editedResult, onSaveAutomation, close]);

  const canStart = Boolean(capabilities?.available) && !busy;

  const header = {
    setup: { title: 'Show & tell', desc: 'Show the screen and say what needs to change. You get a reference of what to fix and where.' },
    recording: { title: 'Recording…', desc: 'Show the screen and point at what you mean. Say what is wrong or what should change.' },
    processing: { title: 'Processing…', desc: 'Transcribing, extracting frames and collecting your notes.' },
    review: mode === 'plan'
      ? { title: 'What needs changing', desc: 'What you pointed out and where. Edit it, attach screenshots as context, then send it to Code.' }
      : { title: 'Your automation', desc: 'The spoken steps turned into executable actions. Review them before saving.' },
  }[phase];

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{header.title}</DialogTitle>
          <DialogDescription>{header.desc}</DialogDescription>
        </DialogHeader>

        <DialogBody>
          {phase === 'setup' ? (
            <div className="grid gap-4">
              <Segmented<Show2PlanMode>
                label="Deliverable"
                value={mode}
                onChange={setMode}
                fullWidth
                options={[
                  { value: 'plan', label: <span className="inline-flex items-center gap-1.5"><ListChecks className="size-3.5" />Tasks</span> },
                  { value: 'automation', label: <span className="inline-flex items-center gap-1.5"><Workflow className="size-3.5" />Automation</span> },
                ]}
              />

              {loadingCapabilities ? (
                <div className="flex items-center gap-2 text-[13px] text-dim"><Spinner className="size-4" />Checking capture support…</div>
              ) : capError ? (
                <Empty icon={<AlertTriangle />} title="Could not reach the recorder">
                  <p>{capError}</p>
                </Empty>
              ) : capabilities ? (
                <div className="grid gap-2.5">
                  <Card className="p-3">
                    <div className="grid gap-2 text-[13px]">
                      <div className="flex items-center justify-between gap-3">
                        <span className="inline-flex items-center gap-2 text-dim"><MonitorPlay className="size-4" />Screen</span>
                        <span className={cn('font-medium', capabilities.video ? 'text-fg' : 'text-danger')}>{capabilities.video?.label ?? 'Unavailable'}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="inline-flex items-center gap-2 text-dim"><Mic className="size-4" />Microphone</span>
                        <span className={cn('font-medium', capabilities.audio ? 'text-fg' : 'text-danger')}>{capabilities.audio?.label ?? 'Unavailable'}</span>
                      </div>
                    </div>
                  </Card>

                  {capabilities.video?.note ? (
                    <p className="m-0 flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-[12.5px] text-warn">
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                      <span>{capabilities.video.note}</span>
                    </p>
                  ) : null}

                  {!capabilities.available && capabilities.reasons.length ? (
                    <p className="m-0 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[12.5px] text-danger">
                      {capabilities.reasons.join(' · ')}
                    </p>
                  ) : null}
                </div>
              ) : null}

              {error ? <p className="m-0 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</p> : null}
            </div>
          ) : null}

          {phase === 'recording' ? (
            <div className="grid gap-4">
              <div className="grid grid-cols-2 gap-3 text-center">
                <Card className="p-4">
                  <div className="font-mono text-3xl tabular-nums">{fmtElapsed(elapsed)}</div>
                  <div className="mt-1 text-[12px] text-dim">elapsed</div>
                </Card>
                <Card className="p-4">
                  <div className="flex items-center justify-center gap-2 text-fg">
                    <span className="size-2.5 animate-pulse rounded-full bg-danger" />
                    <span className="text-[14px] font-semibold">{stateLabel(session?.state ?? 'recording')}</span>
                  </div>
                  <div className="mt-1 text-[12px] text-dim">{session ? `${session.frameCount} frames` : 'starting…'}</div>
                </Card>
              </div>
              {session?.video?.label || session?.audio?.label ? (
                <p className="m-0 text-center text-[12.5px] text-dim">
                  {[session.video?.label, session.audio?.label].filter(Boolean).join(' · ')}
                </p>
              ) : null}
              {session?.error ? <p className="m-0 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{session.error}</p> : null}
              {error ? <p className="m-0 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</p> : null}
            </div>
          ) : null}

          {phase === 'processing' ? (
            <div className="grid gap-2.5">
              <ol className="grid gap-1.5">
                {progressSteps.map((s, i) => {
                  const done = i < progressIndex;
                  const active = i === progressIndex && !error;
                  return (
                    <li key={s.id} className={cn('flex items-center gap-2.5 rounded-lg border px-3 py-2 text-[13px]', active ? 'border-line-strong bg-panel' : 'border-transparent')}>
                      {done ? (
                        <Check className="size-4 text-accent" />
                      ) : active ? (
                        <Spinner className="size-4" />
                      ) : (
                        <span className={cn('size-4 rounded-full border-2', error ? 'border-danger' : 'border-line')} />
                      )}
                      <span className={cn(done ? 'text-fg' : 'text-dim', error && i >= progressIndex && 'text-danger')}>{s.label}</span>
                    </li>
                  );
                })}
              </ol>
              <p className="m-0 text-[12.5px] text-dim">This can take a minute, especially the vision analysis step.</p>
              {error ? <p className="m-0 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</p> : null}
            </div>
          ) : null}

          {phase === 'review' && result ? (
            <div className="grid gap-3">
              {result.app ? <p className="m-0 text-[12.5px] text-dim">Captured in <span className="font-medium text-fg">{result.app}</span></p> : null}
              {result.summary ? <p className="m-0 text-[13.5px] text-fg">{result.summary}</p> : null}

              {result.kind === 'plan' && (
                <div className="grid gap-2">
                  {draftTasks.length ? (
                    <ol className="grid gap-2">
                      {draftTasks.map((t, i) => {
                        const entries = frameEntries(taskFrameNumbers(t));
                        const editing = editingIndex === i;
                        const picking = pickerIndex === i;
                        const page = t.page || result.page;
                        return (
                          <li key={t.id ?? i}>
                            <Card className="p-3">
                              <div className="flex items-start gap-2">
                                <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-accent/15 text-[11px] font-semibold text-accent">{i + 1}</span>
                                <div className="min-w-0 flex-1">
                                  {editing ? (
                                    <div className="grid gap-2">
                                      <Input
                                        value={t.element ?? ''}
                                        onChange={(e) => updateTask(i, { ...t, element: e.target.value, title: [page, e.target.value].filter(Boolean).join(' > ') })}
                                        aria-label="Where on screen"
                                        placeholder="Where on screen (element)"
                                      />
                                      <Textarea
                                        className="min-h-16 resize-y font-sans text-[13px]"
                                        value={t.description}
                                        onChange={(e) => updateTask(i, { ...t, description: e.target.value })}
                                        aria-label="What needs to change"
                                        placeholder="What needs to change"
                                      />
                                    </div>
                                  ) : (
                                    <>
                                      <div className="flex items-center gap-1 text-[11.5px] text-faint">
                                        <MapPin className="size-3 shrink-0" />
                                        <span className="truncate">{page || 'Unknown page'}</span>
                                      </div>
                                      <div className="mt-0.5 text-[13.5px] font-medium text-fg">{t.element || t.title || 'Untitled note'}</div>
                                      {t.description ? <div className="mt-1 text-[12.5px] text-dim">{t.description}</div> : null}
                                      {t.evidence?.transcript ? <div className="mt-1 text-[12px] italic text-faint">said: "{t.evidence.transcript}"</div> : null}
                                    </>
                                  )}
                                  <EvidenceStrip
                                    entries={entries}
                                    frameSrc={frameSrc}
                                    canAdd={Boolean(frames?.frames?.length)}
                                    onRemove={(n) => toggleTaskFrame(i, n)}
                                    onPickerToggle={() => setPickerIndex(picking ? null : i)}
                                  />
                                  {picking ? (
                                    <FramePicker
                                      frames={frames?.frames ?? []}
                                      frameSrc={frameSrc}
                                      selected={taskFrameNumbers(t)}
                                      onToggle={(n) => toggleTaskFrame(i, n)}
                                      onClose={() => setPickerIndex(null)}
                                    />
                                  ) : null}
                                </div>
                                <div className="flex shrink-0 items-center gap-1">
                                  {editing ? (
                                    <Button variant="ghost" size="sm" onClick={() => setEditingIndex(null)}>
                                      <Check className="size-3.5" />Done
                                    </Button>
                                  ) : (
                                    <Button variant="ghost" size="icon-sm" aria-label="Edit note" onClick={() => { setEditingIndex(i); setPickerIndex(null); }}>
                                      <Pencil className="size-3.5" />
                                    </Button>
                                  )}
                                  <Button variant="ghost" size="icon-sm" aria-label="Discard note" onClick={() => discardTask(i)}>
                                    <Trash2 className="size-3.5" />
                                  </Button>
                                </div>
                              </div>
                            </Card>
                          </li>
                        );
                      })}
                    </ol>
                  ) : (
                    <Empty icon={<ListChecks />} title="Nothing pointed out">The recording did not capture any notes. Record again and say what should change.</Empty>
                  )}
                  <div className="flex items-center justify-between gap-2">
                    <p className="m-0 text-[12px] text-faint">Screenshots are context for where this is, not steps to follow.</p>
                    <Button variant="ghost" size="sm" onClick={addFinding}>
                      <Plus className="size-3.5" />Add note
                    </Button>
                  </div>
                </div>
              )}

              {result.kind === 'automation' && (
                draftActions.length ? (
                  <ol className="grid gap-2">
                    {draftActions.map((a, i) => {
                      const entries = frameEntries(actionFrameNumbers(a));
                      const editing = editingIndex === i;
                      const picking = pickerIndex === i;
                      return (
                        <li key={i}>
                          <Card className="p-3">
                            <div className="flex items-start gap-2">
                              <span className="mt-0.5 shrink-0 rounded-md bg-accent/15 px-1.5 py-0.5 font-mono text-[11px] font-semibold uppercase text-accent">{a.action}</span>
                              <div className="min-w-0 flex-1">
                                {editing ? (
                                  <div className="grid gap-2">
                                    <Textarea
                                      className="min-h-16 resize-y font-sans text-[13px]"
                                      value={a.description}
                                      onChange={(e) => updateAction(i, { ...a, description: e.target.value })}
                                      aria-label="Action description"
                                    />
                                    <Input
                                      value={a.target ?? ''}
                                      onChange={(e) => updateAction(i, { ...a, target: e.target.value })}
                                      aria-label="Action target"
                                      placeholder="Target element"
                                    />
                                  </div>
                                ) : (
                                  <>
                                    <div className="text-[13.5px] font-medium text-fg">{a.description}</div>
                                    {a.target || a.value != null || a.key != null ? (
                                      <div className="mt-0.5 text-[12px] text-dim">
                                        {[a.target ? `target: ${a.target}` : null, a.value != null ? `value: "${a.value}"` : null, a.key != null ? `key: ${a.key}` : null].filter(Boolean).join(' · ')}
                                      </div>
                                    ) : null}
                                  </>
                                )}
                                <EvidenceStrip
                                  entries={entries}
                                  frameSrc={frameSrc}
                                  canAdd={Boolean(frames?.frames?.length)}
                                  onRemove={(n) => toggleActionFrame(i, n)}
                                  onPickerToggle={() => setPickerIndex(picking ? null : i)}
                                />
                                {picking ? (
                                  <FramePicker
                                    frames={frames?.frames ?? []}
                                    frameSrc={frameSrc}
                                    selected={actionFrameNumbers(a)}
                                    onToggle={(n) => toggleActionFrame(i, n)}
                                    onClose={() => setPickerIndex(null)}
                                  />
                                ) : null}
                              </div>
                              <div className="flex shrink-0 items-center gap-1">
                                {editing ? (
                                  <Button variant="ghost" size="sm" onClick={() => setEditingIndex(null)}>
                                    <Check className="size-3.5" />Done
                                  </Button>
                                ) : (
                                  <Button variant="ghost" size="icon-sm" aria-label="Edit action" onClick={() => { setEditingIndex(i); setPickerIndex(null); }}>
                                    <Pencil className="size-3.5" />
                                  </Button>
                                )}
                                <Button variant="ghost" size="icon-sm" aria-label="Discard action" onClick={() => discardAction(i)}>
                                  <Trash2 className="size-3.5" />
                                </Button>
                              </div>
                            </div>
                          </Card>
                        </li>
                      );
                    })}
                  </ol>
                ) : (
                  <Empty icon={<Workflow />} title="No actions extracted">The recording did not produce any executable steps.</Empty>
                )
              )}

              {result.kind === 'automation' && result.warnings.length ? (
                <div className="grid gap-1.5 rounded-lg border border-warn/40 bg-warn/10 p-3">
                  <div className="flex items-center gap-2 text-[13px] font-semibold text-warn"><AlertTriangle className="size-4" />Warnings</div>
                  <ul className="m-0 grid gap-1 pl-0 text-[12.5px] text-warn">
                    {result.warnings.map((w, i) => <li key={i} className="list-inside list-disc">{w}</li>)}
                  </ul>
                </div>
              ) : null}

              {result.uncertain?.length ? (
                <div className="grid gap-1.5 rounded-lg border border-line p-3">
                  <div className="text-[13px] font-semibold text-fg">Open questions</div>
                  <ul className="m-0 grid gap-1 pl-0 text-[12.5px] text-dim">
                    {result.uncertain.map((u, i) => <li key={i} className="list-inside list-disc">{u}</li>)}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </DialogBody>

        <DialogFooter>
          {phase === 'setup' ? (
            <>
              <Button variant="ghost" onClick={close}>Cancel</Button>
              <Button variant="primary" disabled={!canStart || loadingCapabilities} onClick={() => void startRecording()}>
                {busy ? <Spinner className="size-4" /> : <Play className="size-4" />}Start recording
              </Button>
            </>
          ) : null}

          {phase === 'recording' ? (
            <>
              <Button variant="ghost" onClick={close}>Cancel</Button>
              <Button variant="danger" disabled={busy} onClick={() => void stopRecording()}>
                {busy ? <Spinner className="size-4" /> : <Square className="size-4" />}Stop &amp; process
              </Button>
            </>
          ) : null}

          {phase === 'processing' ? (
            <>
              <Button variant="ghost" onClick={backToSetup}><ChevronLeft className="size-4" />Back</Button>
              {error ? <Button variant="primary" disabled={!sessionId} onClick={() => sessionId && void runProcessing(sessionId, mode)}><RefreshCw className="size-4" />Retry</Button> : null}
            </>
          ) : null}

          {phase === 'review' ? (
            <>
              <Button variant="ghost" onClick={backToSetup}><Camera className="size-4" />Record again</Button>
              <Button variant="ghost" onClick={close}>Close</Button>
              {result?.kind === 'plan' ? (
                <Button variant="primary" disabled={sending || draftTasks.length === 0} onClick={() => void handleSendPlan()}>
                  {sending ? <Spinner className="size-4" /> : <Send className="size-4" />}Send to Code
                </Button>
              ) : (
                <Button variant="primary" disabled={sending || draftActions.length === 0} onClick={() => void handleSaveAutomation()}>
                  {sending ? <Spinner className="size-4" /> : <Save className="size-4" />}Save to Cowork
                </Button>
              )}
            </>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default Show2Plan;

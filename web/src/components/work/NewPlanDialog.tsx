import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, Play, Sparkles, Waypoints, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Segmented, Spinner } from '@/components/ui/misc';
import { Switch } from '@/components/ui/switch';
import { planToMeta, type PlanFull, type PlanMeta, type ProposedTask, type TranslateResult } from '@/lib/work';
import { TaskDrafts } from './TaskDrafts';

const field = 'w-full rounded-[10px] border border-line-strong bg-sunken px-3 py-2 font-sans text-[13px] leading-relaxed text-fg outline-none placeholder:text-faint focus:border-accent/45 focus:ring-[3px] focus:ring-accent/15';

const MAX_REQUESTS = 30;

type Mode = 'brief' | 'tasks';

const BULLET = /^(?:[-*+•]|\d+[.)])\s+/;

/**
 * Split a brief into one request per bullet. A brief written as prose stays one
 * request; anything else gets a request per bullet, with wrapped lines folded
 * back into the bullet above them.
 */
export function briefToRequests(brief: string): string[] {
  const text = brief.trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.some((l) => BULLET.test(l))) return [text];
  const out: string[] = [];
  for (const line of lines) {
    if (BULLET.test(line)) out.push(line.replace(BULLET, '').trim());
    else if (out.length) out[out.length - 1] = `${out[out.length - 1]} ${line}`.trim();
    else out.push(line);
  }
  return out.filter(Boolean).slice(0, MAX_REQUESTS);
}

/** One task per line, bullets stripped. Titles only; the draft step fills the rest. */
export function linesToTasks(text: string): ProposedTask[] {
  return text.split(/\r?\n/)
    .map((l) => l.trim().replace(BULLET, '').trim())
    .filter(Boolean)
    .slice(0, MAX_REQUESTS)
    .map((title, i) => ({
      key: `t${i + 1}`,
      title: title.slice(0, 120),
      kind: 'change',
      layer: 'unknown',
      priority: 'normal',
      instructions: '',
      acceptance: [],
      files: [],
      dependsOn: [],
      questions: [],
    }));
}

/**
 * Create a plan either from a brief (bullets or prose, run through intake:
 * the model grounds it in the codebase and writes the tasks) or from a list of
 * task titles you already know. Both arrive at the same editable draft, so the
 * instructions and acceptance criteria can be reviewed before anything runs.
 */
export function NewPlan({ onCreated }: { onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('brief');
  const [step, setStep] = useState<'input' | 'draft'>('input');
  const [brief, setBrief] = useState('');
  const [taskLines, setTaskLines] = useState('');
  const [tasks, setTasks] = useState<ProposedTask[]>([]);
  const [title, setTitle] = useState('');
  const [signoff, setSignoff] = useState(true);
  const [result, setResult] = useState<TranslateResult | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setMode('brief'); setStep('input'); setBrief(''); setTaskLines(''); setTasks([]);
    setTitle(''); setSignoff(true); setResult(null); setError(null);
  };
  const close = (next: boolean) => {
    setOpen(next);
    if (!next) reset();
  };

  const draftFromBrief = async () => {
    const requests = briefToRequests(brief);
    if (!requests.length) return;
    setDrafting(true);
    setError(null);
    try {
      const r = await api.post<TranslateResult>('/api/intake/translate', {
        source: 'manual',
        context: requests.length > 1 ? brief.trim() : undefined,
        requests: requests.map((text, i) => ({ id: `b${i + 1}`, text })),
      });
      if (!r.tasks.length) {
        setError('The planner returned no tasks. Add detail to the brief and try again.');
        return;
      }
      setResult(r);
      setTasks(r.tasks);
      setTitle((r.summary || r.tasks[0]?.title || 'New plan').slice(0, 200));
      setStep('draft');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDrafting(false);
    }
  };

  const draftFromTasks = () => {
    const next = linesToTasks(taskLines);
    if (!next.length) return;
    setResult(null);
    setTasks(next);
    setTitle(next[0].title.slice(0, 200));
    setStep('draft');
  };

  const createPlan = async (start: boolean) => {
    setCreating(true);
    try {
      const plan = await api.post<PlanFull>('/api/plans', {
        title: title.trim() || tasks[0]?.title || 'New plan',
        summary: (result?.summary || brief.trim() || taskLines.trim()).slice(0, 4000),
        source: 'manual',
        requireSignoff: signoff,
        tasks,
      });
      qc.setQueryData<{ plans: PlanMeta[] }>(['plans'], (old) => ({ plans: [planToMeta(plan), ...(old?.plans ?? []).filter((p) => p.id !== plan.id)] }));
      if (start) await api.post(`/api/plans/${plan.id}/run`);
      close(false);
      onCreated(plan.id);
      toast.success(start ? 'Plan started' : 'Plan created', { action: { label: 'Open', onClick: () => onCreated(plan.id) } });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const requests = mode === 'brief' ? briefToRequests(brief) : [];
  const canDraft = mode === 'brief' ? requests.length > 0 : taskLines.trim().length > 0;
  const stack = result ? [...result.stack.frontend, ...result.stack.backend, ...result.stack.database] : [];

  if (!open) {
    return (
      <Button variant="default" className="w-full justify-start" onClick={() => setOpen(true)}><Sparkles />New plan</Button>
    );
  }

  return (
    <Dialog open onOpenChange={close}>
      <DialogContent className="md:w-[min(780px,calc(100vw-32px))] md:max-h-[88vh]">
        <DialogHeader>
          <DialogTitle>{step === 'input' ? 'New plan' : 'Check the draft'}</DialogTitle>
          <DialogDescription>
            {step === 'input'
              ? 'Describe the work in a brief with bullets, or list the tasks yourself. Either way you review the tasks before the agent runs them.'
              : 'Every task runs on its own, then its diff is checked against the acceptance criteria. Edit anything that is vague before you start.'}
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          {step === 'input' ? (
            <>
              <Segmented<Mode>
                value={mode}
                onChange={(m) => { setMode(m); setError(null); }}
                label="How to start"
                fullWidth
                options={[
                  { value: 'brief', label: <span className="inline-flex items-center gap-1.5"><Waypoints className="size-3.5" />Start from a brief</span> },
                  { value: 'tasks', label: <span className="inline-flex items-center gap-1.5"><Wrench className="size-3.5" />Write the tasks</span> },
                ]}
              />

              {mode === 'brief' ? (
                <>
                  <div className="grid gap-1.5">
                    <label htmlFor="plan-brief" className="text-[12px] font-medium text-dim">Brief</label>
                    <textarea
                      id="plan-brief"
                      autoFocus
                      className={cn(field, 'min-h-52 resize-y')}
                      value={brief}
                      onChange={(e) => setBrief(e.target.value)}
                      aria-describedby="plan-brief-hint"
                      placeholder={'- Let people sign in with Google on the login page\n- Remember the last folder each project was opened from\n- Show the current plan status with a colour instead of text'}
                    />
                  </div>
                  <p id="plan-brief-hint" className="m-0 text-[12px] text-faint">
                    One bullet per change. The planner reads the codebase, splits each change into the layers it really touches (database, backend, frontend) and writes the instructions and acceptance criteria for you.
                    {requests.length > 1 ? <span className="text-dim"> {requests.length} bullet{requests.length === 1 ? '' : 's'} detected.</span> : null}
                    {' '}Prose without bullets is treated as one request.
                  </p>
                </>
              ) : (
                <>
                  <div className="grid gap-1.5">
                    <label htmlFor="plan-task-lines" className="text-[12px] font-medium text-dim">Tasks, one per line</label>
                    <textarea
                      id="plan-task-lines"
                      autoFocus
                      className={cn(field, 'min-h-52 resize-y')}
                      value={taskLines}
                      onChange={(e) => setTaskLines(e.target.value)}
                      aria-describedby="plan-task-hint"
                      placeholder={'Add a sign-in button with Google to the login page\nStore the provider on the user record\nShow the provider in the account settings'}
                    />
                  </div>
                  <p id="plan-task-hint" className="m-0 text-[12px] text-faint">
                    Each line becomes a task in that order. Instructions, acceptance criteria and files are filled in on the next step.
                  </p>
                </>
              )}

              {error ? <p className="m-0 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</p> : null}
            </>
          ) : (
            <>
              {result?.via === 'fallback' ? (
                <p className="m-0 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-[12.5px] text-warn">
                  Drafted without the model ({result.error}). One task per bullet, layer guessed from keywords: tighten the instructions before you start.
                </p>
              ) : null}
              {stack.length ? <p className="m-0 text-[12px] text-faint">Detected: {stack.join(' · ')}</p> : null}
              <div className="grid gap-1.5">
                <label htmlFor="new-plan-title" className="text-[12px] font-medium text-dim">Plan title</label>
                <Input id="new-plan-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What the plan delivers" />
              </div>
              {tasks.length ? (
                <TaskDrafts tasks={tasks} onChange={setTasks} />
              ) : (
                <p className="m-0 rounded-lg border border-dashed border-line-strong px-3 py-6 text-center text-[12.5px] text-faint">No tasks left. Go back and describe the work again.</p>
              )}
              <label className="inline-flex items-center gap-2 text-[12.5px] text-dim">
                <Switch checked={signoff} onCheckedChange={setSignoff} />Tasks need my sign-off after they pass review
              </label>
            </>
          )}
        </DialogBody>

        <DialogFooter>
          {step === 'input' ? (
            <>
              <Button variant="ghost" onClick={() => close(false)}>Cancel</Button>
              <Button variant="primary" disabled={!canDraft || drafting} onClick={() => (mode === 'brief' ? void draftFromBrief() : draftFromTasks())}>
                {drafting ? <Spinner className="size-4" /> : <Sparkles />}
                {mode === 'brief' ? 'Draft tasks' : 'Continue'}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setStep('input')} disabled={creating}><ArrowLeft />Back</Button>
              <Button variant="default" disabled={!tasks.length || creating || !title.trim()} onClick={() => void createPlan(false)}><Check />Create plan</Button>
              <Button variant="primary" disabled={!tasks.length || creating || !title.trim()} onClick={() => void createPlan(true)}>{creating ? <Spinner className="size-4" /> : <Play />}Create and start</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

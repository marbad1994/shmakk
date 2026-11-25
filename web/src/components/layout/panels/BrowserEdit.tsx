import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { ChevronDown, ChevronUp, Code2, Layers, ListPlus, Paintbrush, Play, Plus, Sparkles, Trash2, X } from 'lucide-react';
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
import type { PlanFull, ProposedTask, TranslateResult } from '@/lib/work';

export interface PickedDetail {
  tag: string;
  selector: string;
  text: string;
  html: string;
  attrs: Record<string, string>;
  styles: Record<string, string>;
  rect: { x: number; y: number; w: number; h: number };
  landmarks: string[];
  component: { framework: string; name: string | null; chain?: string[]; file: string | null; line?: number | null; approx?: boolean } | null;
  page: { href: string; path: string; title: string };
}
export interface PickedElement { id: string; detail: PickedDetail }

interface Tweak { text?: string; styles?: Record<string, string> }
export interface EditRequest {
  id: string;
  text: string;
  tweaks: Tweak | null;
  label: string;
  where: {
    url: string; page: string; selector: string; text: string; html: string; attrs: Record<string, string>;
    landmarks: string[]; component: PickedDetail['component'];
  };
}

// The tray survives switching panes and re-picking elements.
const useTray = create<{ items: EditRequest[]; add(r: EditRequest): void; remove(id: string): void; clear(): void }>((set) => ({
  items: [],
  add: (r) => set((s) => ({ items: [...s.items, r] })),
  remove: (id) => set((s) => ({ items: s.items.filter((x) => x.id !== id) })),
  clear: () => set({ items: [] }),
}));

const field = 'w-full rounded-[10px] border border-line-strong bg-sunken px-3 py-2 font-sans text-[13px] leading-relaxed text-fg outline-none placeholder:text-faint focus:border-accent/45 focus:ring-[3px] focus:ring-accent/15';
const TWEAKABLE = ['color', 'background-color', 'font-size', 'font-weight', 'padding', 'border-radius'] as const;

function labelFor(d: PickedDetail) {
  const name = d.component?.name;
  const text = d.text ? `"${d.text.slice(0, 40)}${d.text.length > 40 ? '…' : ''}"` : '';
  return [name, `<${d.tag}>`, text].filter(Boolean).join(' ');
}

function sourceLabel(c: PickedDetail['component']) {
  if (!c || !c.file) return null;
  const f = c.file.replace(/^.*?\/(src|app|pages|components|lib)\//, '$1/');
  return `${f}${c.line && !c.approx ? `:${c.line}` : ''}`;
}

/** Panel at the bottom of the browser pane while Edit is on. */
export function BrowserEdit({ picked, pageUrl, onTweak, onClear, onReload }: {
  picked: PickedElement | null;
  pageUrl: string;
  previewOrigin: string | null;
  onTweak: (id: string, tweak: Tweak) => void;
  onClear: () => void;
  onReload: () => void;
}) {
  const tray = useTray();
  const [note, setNote] = useState('');
  const [tweakOpen, setTweakOpen] = useState(false);
  const [tweak, setTweak] = useState<Tweak>({});
  const [reviewOpen, setReviewOpen] = useState(false);

  // New element, new note.
  useEffect(() => { setNote(''); setTweak({}); setTweakOpen(false); }, [picked?.id]);

  const setStyle = (prop: string, value: string) => {
    if (!picked) return;
    const next = { ...tweak, styles: { ...(tweak.styles || {}), [prop]: value } };
    if (!value) delete next.styles![prop];
    setTweak(next);
    onTweak(picked.id, { styles: { [prop]: value } });
  };
  const setText = (value: string) => {
    if (!picked) return;
    setTweak({ ...tweak, text: value });
    onTweak(picked.id, { text: value });
  };

  const addToTray = () => {
    if (!picked) return;
    const d = picked.detail;
    const hasTweak = !!(tweak.text !== undefined || (tweak.styles && Object.keys(tweak.styles).length));
    if (!note.trim() && !hasTweak) { toast.error('Say what should change, or preview a tweak.'); return; }
    tray.add({
      id: `e${Date.now().toString(36)}`,
      text: note.trim(),
      tweaks: hasTweak ? tweak : null,
      label: labelFor(d),
      where: { url: (() => { try { return new URL(d.page.path, pageUrl).href; } catch { return pageUrl; } })(), page: d.page.title, selector: d.selector, text: d.text, html: d.html, attrs: d.attrs, landmarks: d.landmarks, component: d.component },
    });
    setNote('');
    setTweak({});
    onClear();
  };

  const d = picked?.detail;
  const leaf = d && d.text && !/<(div|section|ul|ol|table|form|nav|header|main)\b/i.test(d.html.slice(d.html.indexOf('>') + 1));

  return (
    <div className="shrink-0 border-t border-line bg-panel">
      {d ? (
        <div className="grid max-h-[55vh] gap-2.5 overflow-y-auto px-3 py-2.5">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
                {d.component?.name ? <span className="inline-flex items-center gap-1 rounded-md bg-violet/10 px-1.5 py-0.5 font-medium text-violet"><Layers className="size-3" />{d.component.name}</span> : null}
                <span className="text-dim">&lt;{d.tag}&gt;</span>
                {sourceLabel(d.component) ? <span className="inline-flex min-w-0 items-center gap-1 text-faint"><Code2 className="size-3 shrink-0" /><span className="truncate">{sourceLabel(d.component)}</span></span> : null}
              </div>
              {d.text ? <p className="m-0 mt-0.5 line-clamp-2 text-[12.5px] text-dim">"{d.text}"</p> : null}
            </div>
            <Button variant="ghost" size="icon-sm" aria-label="Deselect element" onClick={onClear}><X /></Button>
          </div>

          <textarea
            className={cn(field, 'min-h-16 resize-y')}
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); addToTray(); } }}
            placeholder="What should change? e.g. show the user's last login date here, sorted newest first"
            aria-label="What should change"
          />

          <div>
            <button type="button" onClick={() => setTweakOpen((v) => !v)} className="inline-flex items-center gap-1 text-[12px] text-dim hover:text-fg" aria-expanded={tweakOpen}>
              <Paintbrush className="size-3.5" />Preview a visual tweak{tweakOpen ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
            </button>
            {tweakOpen ? (
              <div className="mt-2 grid gap-2">
                <p className="m-0 text-[11.5px] text-faint">Applied to the live page only, to show what you mean. The real change is made in the source by the plan.</p>
                {leaf ? <Input value={tweak.text ?? d.text} onChange={(e) => setText(e.target.value)} aria-label="Text" className="h-8 text-[12.5px]" /> : null}
                <div className="grid grid-cols-2 gap-1.5">
                  {TWEAKABLE.map((p) => (
                    <label key={p} className="grid gap-0.5 text-[11px] text-faint">
                      {p}
                      <input className={cn(field, 'h-7 px-2 py-0.5 text-[12px]')} value={tweak.styles?.[p] ?? ''} placeholder={d.styles[p] || ''} onChange={(e) => setStyle(p, e.target.value)} />
                    </label>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            <Button size="sm" variant="primary" onClick={addToTray}><ListPlus />Add change</Button>
            <span className="text-[11.5px] text-faint">Ctrl+Enter</span>
          </div>
        </div>
      ) : (
        <p className="m-0 px-3 py-2 text-[12.5px] text-dim">Click an element in the page to describe a change. Links and buttons do not fire while picking. Esc deselects.</p>
      )}

      {tray.items.length ? (
        <div className="grid gap-1.5 border-t border-line px-3 py-2">
          <ul className="m-0 grid max-h-32 list-none gap-1 overflow-y-auto p-0">
            {tray.items.map((r) => (
              <li key={r.id} className="flex items-start gap-2 text-[12.5px]">
                <span className="mt-0.5 size-1.5 shrink-0 rounded-full bg-violet" />
                <span className="min-w-0 flex-1"><span className="text-faint">{r.label}: </span><span className="text-fg">{r.text || 'visual tweak'}</span></span>
                <button type="button" aria-label="Remove change" className="text-faint hover:text-danger" onClick={() => tray.remove(r.id)}><Trash2 className="size-3.5" /></button>
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="primary" onClick={() => setReviewOpen(true)}><Sparkles />Turn {tray.items.length} change{tray.items.length === 1 ? '' : 's'} into tasks</Button>
            <Button size="sm" variant="ghost" onClick={() => { tray.clear(); onReload(); }}>Discard</Button>
          </div>
        </div>
      ) : null}

      <ReviewDialog open={reviewOpen} onOpenChange={setReviewOpen} requests={tray.items} pageUrl={pageUrl} onCreated={() => { tray.clear(); onReload(); }} />
    </div>
  );
}

function ReviewDialog({ open, onOpenChange, requests, pageUrl, onCreated }: {
  open: boolean; onOpenChange: (o: boolean) => void; requests: EditRequest[]; pageUrl: string; onCreated: () => void;
}) {
  const openPlan = useApp((s) => s.openPlan);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TranslateResult | null>(null);
  const [tasks, setTasks] = useState<ProposedTask[]>([]);
  const [title, setTitle] = useState('');
  const [signoff, setSignoff] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !requests.length) return;
    let alive = true;
    setLoading(true);
    setError(null);
    setResult(null);
    api.post<TranslateResult>('/api/intake/translate', {
      source: 'browser',
      context: `The person was looking at ${pageUrl} in the live preview of the app and picked elements on it.`,
      requests: requests.map((r) => ({ id: r.id, text: r.text, tweaks: r.tweaks, where: { ...r.where, page: r.where.page || null, element: r.label } })),
    }).then((r) => {
      if (!alive) return;
      setResult(r);
      setTasks(r.tasks.map((t) => {
        const req = requests.find((x) => (t.requestIds || []).includes(x.id)) || (requests.length === 1 ? requests[0] : null);
        const src = req?.where.component?.file ? `${req.where.component.file}${req.where.component.line && !req.where.component.approx ? `:${req.where.component.line}` : ''}` : null;
        return { ...t, evidence: req ? { url: req.where.url, selector: req.where.selector, element: req.label, source: src } : undefined };
      }));
      setTitle(r.summary || (r.tasks[0]?.title ?? 'Changes from the browser'));
    }).catch((e: Error) => { if (alive) setError(e.message); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [open, requests, pageUrl]);

  const createPlan = async (start: boolean) => {
    setCreating(true);
    try {
      const plan = await api.post<PlanFull>('/api/plans', { title, summary: requests.map((r) => `- ${r.label}: ${r.text || 'visual tweak'}`).join('\n'), source: 'browser', tasks, requireSignoff: signoff });
      if (start) await api.post(`/api/plans/${plan.id}/run`);
      onCreated();
      onOpenChange(false);
      toast.success(start ? 'Plan started' : 'Plan created', { action: { label: 'Open', onClick: () => openPlan(plan.id) } });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="md:w-[min(720px,calc(100vw-32px))]">
        <DialogHeader>
          <DialogTitle>Tasks for these changes</DialogTitle>
          <DialogDescription>Each change was placed in the codebase and split by layer. Check the instructions and acceptance criteria: the reviewer holds every task to them.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {loading ? (
            <div className="flex items-center gap-2 py-6 text-[13px] text-dim"><Spinner className="size-4" />Reading the codebase and drafting tasks…</div>
          ) : error ? (
            <p className="m-0 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</p>
          ) : result ? (
            <>
              {result.via === 'fallback' ? <p className="m-0 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-[12.5px] text-warn">Drafted without the model ({result.error}). One task per change, layer guessed from keywords: review before you start.</p> : null}
              {[...result.stack.frontend, ...result.stack.backend, ...result.stack.database].length ? (
                <p className="m-0 text-[12px] text-faint">Detected: {[...result.stack.frontend, ...result.stack.backend, ...result.stack.database].join(' · ')}</p>
              ) : null}
              <div className="grid gap-1.5">
                <label htmlFor="edit-plan-title" className="text-[12px] font-medium text-dim">Plan title</label>
                <Input id="edit-plan-title" value={title} onChange={(e) => setTitle(e.target.value)} />
              </div>
              <TaskDrafts tasks={tasks} onChange={setTasks} />
              <label className="inline-flex items-center gap-2 text-[12.5px] text-dim"><Switch checked={signoff} onCheckedChange={setSignoff} />Tasks need my sign-off after they pass review</label>
            </>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!tasks.length || creating || loading} onClick={() => void createPlan(false)}><Plus />Create plan</Button>
          <Button variant="primary" disabled={!tasks.length || creating || loading} onClick={() => void createPlan(true)}>{creating ? <Spinner className="size-4" /> : <Play />}Create and start</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

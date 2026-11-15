import { useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, CircleHelp, FileCode2, GitBranch, Plus, Trash2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LAYER_LABEL, LAYER_TONE, pill, type Layer, type ProposedTask, type TaskKind } from '@/lib/work';

const LAYERS: Layer[] = ['database', 'backend', 'frontend', 'infra', 'tests', 'unknown'];
const KINDS: TaskKind[] = ['bug', 'change', 'feature', 'chore'];

const field = 'w-full rounded-[10px] border border-line-strong bg-sunken px-3 py-2 font-sans text-[13px] leading-relaxed text-fg outline-none placeholder:text-faint focus:border-accent/45 focus:ring-[3px] focus:ring-accent/15';

export function LayerPill({ layer, className }: { layer: Layer; className?: string }) {
  return <span className={cn(pill, LAYER_TONE[layer] || LAYER_TONE.unknown, className)}>{LAYER_LABEL[layer] || layer}</span>;
}

/**
 * Review-and-edit list for tasks proposed by intake. Every field the agent and
 * the reviewer will rely on is editable here: layer, instructions, acceptance
 * criteria and files. Order is execution order.
 */
export function TaskDrafts({ tasks, onChange, frameSrc }: {
  tasks: ProposedTask[];
  onChange: (next: ProposedTask[]) => void;
  frameSrc?: (file: string) => string;
}) {
  const [open, setOpen] = useState<string | null>(tasks[0]?.key ?? null);
  const update = (i: number, patch: Partial<ProposedTask>) => onChange(tasks.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const remove = (i: number) => {
    const key = tasks[i].key;
    onChange(tasks.filter((_, j) => j !== i).map((t) => ({ ...t, dependsOn: t.dependsOn.filter((d) => d !== key) })));
  };
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= tasks.length) return;
    const next = [...tasks];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const add = () => {
    const key = `n${Date.now().toString(36)}`;
    onChange([...tasks, { key, title: '', kind: 'change', layer: 'frontend', priority: 'normal', instructions: '', acceptance: [], files: [], dependsOn: [], questions: [] }]);
    setOpen(key);
  };
  const titleOf = (key: string) => tasks.find((t) => t.key === key)?.title || key;

  return (
    <div className="grid gap-2">
      <ol className="m-0 grid list-none gap-2 p-0">
        {tasks.map((t, i) => {
          const expanded = open === t.key;
          return (
            <li key={t.key} className="overflow-hidden rounded-xl border border-line bg-raised">
              <div className="flex items-start gap-2 px-3 py-2.5">
                <button type="button" onClick={() => setOpen(expanded ? null : t.key)} aria-expanded={expanded} aria-label={expanded ? 'Collapse task' : 'Expand task'} className="mt-0.5 grid size-5 shrink-0 place-items-center rounded text-faint hover:text-fg">
                  {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                </button>
                <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-hover text-[11px] font-semibold tabular-nums text-dim">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <LayerPill layer={t.layer} />
                    <span className={cn(pill, 'border-line-strong text-dim')}>{t.kind}</span>
                    {t.priority === 'high' ? <span className={cn(pill, 'border-danger/40 text-danger')}>high</span> : null}
                    {t.dependsOn.length ? <span className="inline-flex items-center gap-1 text-[11.5px] text-faint"><GitBranch className="size-3" />after {t.dependsOn.map(titleOf).join(', ')}</span> : null}
                  </div>
                  <button type="button" onClick={() => setOpen(expanded ? null : t.key)} className="mt-1 block w-full text-left text-[13.5px] font-medium text-fg">{t.title || <span className="text-faint">Untitled task</span>}</button>
                  {!expanded && t.instructions ? <p className="m-0 mt-0.5 line-clamp-2 text-[12.5px] text-dim">{t.instructions.replace(/[#*`>]/g, '')}</p> : null}
                </div>
                <div className="flex shrink-0 items-center">
                  <Button variant="ghost" size="icon-sm" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp /></Button>
                  <Button variant="ghost" size="icon-sm" aria-label="Move down" disabled={i === tasks.length - 1} onClick={() => move(i, 1)}><ArrowDown /></Button>
                  <Button variant="ghost" size="icon-sm" aria-label="Remove task" onClick={() => remove(i)}><Trash2 /></Button>
                </div>
              </div>

              {expanded ? (
                <div className="grid gap-3 border-t border-line bg-panel px-3 py-3">
                  <div className="grid gap-1.5">
                    <label className="text-[12px] font-medium text-dim" htmlFor={`title-${t.key}`}>Title</label>
                    <Input id={`title-${t.key}`} value={t.title} onChange={(e) => update(i, { title: e.target.value })} placeholder="Short, imperative" />
                  </div>
                  <div className="flex flex-wrap gap-3">
                    <div className="grid gap-1.5">
                      <span className="text-[12px] font-medium text-dim">Layer</span>
                      <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Layer">
                        {LAYERS.map((l) => (
                          <button key={l} type="button" role="radio" aria-checked={t.layer === l} onClick={() => update(i, { layer: l })}
                            className={cn(pill, 'cursor-pointer py-0.5', t.layer === l ? LAYER_TONE[l] : 'border-line text-faint hover:text-fg')}>{LAYER_LABEL[l]}</button>
                        ))}
                      </div>
                    </div>
                    <div className="grid gap-1.5">
                      <span className="text-[12px] font-medium text-dim">Kind</span>
                      <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Kind">
                        {KINDS.map((k) => (
                          <button key={k} type="button" role="radio" aria-checked={t.kind === k} onClick={() => update(i, { kind: k })}
                            className={cn(pill, 'cursor-pointer py-0.5', t.kind === k ? 'border-accent/40 bg-accent/10 text-accent' : 'border-line text-faint hover:text-fg')}>{k}</button>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="grid gap-1.5">
                    <label className="text-[12px] font-medium text-dim" htmlFor={`ins-${t.key}`}>Instructions for the agent</label>
                    <textarea id={`ins-${t.key}`} className={cn(field, 'min-h-28 resize-y')} value={t.instructions} onChange={(e) => update(i, { instructions: e.target.value })} placeholder="What to change, where, and how" />
                  </div>
                  <ListField
                    label="Acceptance criteria (the reviewer checks the diff against these)"
                    items={t.acceptance}
                    placeholder="e.g. The Save button uses the large size on every screen"
                    onChange={(acceptance) => update(i, { acceptance })}
                  />
                  {t.files.length ? (
                    <div className="grid gap-1">
                      <span className="text-[12px] font-medium text-dim">Files likely involved</span>
                      <ul className="m-0 grid list-none gap-1 p-0">
                        {t.files.map((f, fi) => (
                          <li key={f.path} className="flex items-center gap-2 text-[12.5px]">
                            <FileCode2 className="size-3.5 shrink-0 text-faint" />
                            <span className="min-w-0 truncate text-fg">{f.path}</span>
                            {f.why ? <span className="min-w-0 truncate text-faint">{f.why}</span> : null}
                            <button type="button" aria-label={`Remove ${f.path}`} className="ml-auto text-faint hover:text-danger" onClick={() => update(i, { files: t.files.filter((_, k) => k !== fi) })}><X className="size-3.5" /></button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {t.questions.length ? (
                    <div className="grid gap-1 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2">
                      <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-warn"><CircleHelp className="size-3.5" />Open questions: answer them in the instructions</span>
                      <ul className="m-0 grid gap-0.5 pl-4 text-[12.5px] text-warn">{t.questions.map((q) => <li key={q}>{q}</li>)}</ul>
                    </div>
                  ) : null}
                  {t.evidence && (t.evidence.quote || (t.evidence.frames && t.evidence.frames.length)) ? (
                    <div className="grid gap-1.5">
                      <span className="text-[12px] font-medium text-dim">Context from the recording</span>
                      {t.evidence.quote ? <p className="m-0 text-[12.5px] italic text-dim">"{t.evidence.quote}"</p> : null}
                      {frameSrc && t.evidence.frames && t.evidence.frames.length ? (
                        <div className="flex flex-wrap gap-1.5">
                          {t.evidence.frames.map((f) => (
                            <span key={f} className="relative">
                              <img src={frameSrc(f)} alt="Screenshot from the recording" loading="lazy" className="h-16 w-auto rounded-md border border-line object-contain" />
                              <button type="button" aria-label="Remove screenshot" onClick={() => update(i, { evidence: { ...t.evidence, frames: (t.evidence?.frames || []).filter((x) => x !== f) } })}
                                className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full border border-line bg-raised text-dim hover:bg-danger hover:text-white"><X className="size-3" /></button>
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
      <div><Button variant="ghost" size="sm" onClick={add}><Plus />Add task</Button></div>
    </div>
  );
}

function ListField({ label, items, onChange, placeholder }: { label: string; items: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const [draft, setDraft] = useState('');
  const commit = () => { const v = draft.trim(); if (v) { onChange([...items, v]); setDraft(''); } };
  return (
    <div className="grid gap-1.5">
      <span className="text-[12px] font-medium text-dim">{label}</span>
      {items.length ? (
        <ul className="m-0 grid list-none gap-1 p-0">
          {items.map((a, i) => (
            <li key={`${i}-${a}`} className="flex items-start gap-2">
              <input className={cn(field, 'h-8 py-1')} value={a} aria-label={`Criterion ${i + 1}`} onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value : x)))} />
              <Button variant="ghost" size="icon-sm" aria-label="Remove criterion" onClick={() => onChange(items.filter((_, j) => j !== i))}><X /></Button>
            </li>
          ))}
        </ul>
      ) : <p className="m-0 text-[12px] text-warn">No criteria yet. The reviewer then only checks that the instructions were followed.</p>}
      <div className="flex gap-2">
        <input className={cn(field, 'h-8 py-1')} value={draft} placeholder={placeholder} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }} />
        <Button size="sm" onClick={commit} disabled={!draft.trim()}><Plus />Add</Button>
      </div>
    </div>
  );
}

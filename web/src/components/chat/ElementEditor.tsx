import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { GripHorizontal, Plus, Send, Sparkles, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ColorField } from '@/components/ui/color';
import { Field, Input, Label, Textarea } from '@/components/ui/input';
import { Spinner } from '@/components/ui/misc';
import { Tip } from '@/components/ui/tooltip';

export interface SelectedDetail {
  tag: string;
  selector: string;
  text: string;
  hasChildren: boolean;
  /** Inline styles as kebab-case property -> value. */
  styles: Record<string, string>;
  /** Computed values for common properties (editable hints). */
  computed: Record<string, string>;
}
export interface Selection {
  id: string;
  detail: SelectedDetail;
}

type Row = { id: number; prop: string; value: string; inline: boolean };

const COLOR_PROPS = new Set([
  'color', 'background-color', 'border-color', 'border-top-color', 'border-right-color',
  'border-bottom-color', 'border-left-color', 'outline-color', 'text-decoration-color',
  'caret-color', 'column-rule-color', 'fill', 'stroke',
]);

// Common names as a fallback when the browser cannot enumerate its own props.
const FALLBACK_PROPS = (
  'align-content align-items align-self animation background background-color background-image ' +
  'background-position background-repeat background-size border border-color border-radius border-style ' +
  'border-width bottom box-shadow box-sizing color column-gap content cursor display filter flex flex-basis ' +
  'flex-direction flex-grow flex-shrink flex-wrap float font font-family font-size font-style font-weight gap ' +
  'grid grid-template-columns grid-template-rows height justify-content justify-items left letter-spacing ' +
  'line-height list-style margin margin-bottom margin-left margin-right margin-top max-height max-width ' +
  'min-height min-width object-fit opacity order outline overflow overflow-x overflow-y padding padding-bottom ' +
  'padding-left padding-right padding-top position right row-gap text-align text-decoration text-overflow ' +
  'text-transform top transform transition user-select vertical-align visibility white-space width word-break ' +
  'z-index'
).split(' ');

// Build the property-name list once for the datalist. Browsers expose every
// supported CSS property as an enumerable accessor on CSSStyleDeclaration.
const CSS_PROPERTIES: string[] = (() => {
  const seen = new Set<string>(FALLBACK_PROPS);
  if (typeof document === 'undefined') return [...seen].sort();
  try {
    const s = document.createElement('div').style as unknown as Record<string, unknown>;
    const toKebab = (k: string) => k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
    for (const key in s) {
      if (key === 'cssText' || key === 'length' || key === 'parentRule') continue;
      if (typeof s[key] !== 'string') continue;
      let name: string;
      if (key === 'cssFloat') name = 'float';
      else if (/^(webkit|moz|ms)[A-Z]/.test(key)) name = '-' + toKebab(key);
      else name = toKebab(key);
      if (/^[a-z-]+$/.test(name)) seen.add(name);
    }
  } catch { /* keep fallback */ }
  return [...seen].sort();
})();

function isColor(prop: string, value: string): boolean {
  if (COLOR_PROPS.has(prop)) return true;
  const v = value.trim();
  if (!v) return false;
  try { return typeof CSS !== 'undefined' && CSS.supports('color', v); } catch { return false; }
}

const LIST_ID = 'shmakk-css-props';

/** Compact floating editor for the element selected in the live design frame. */
export function ElementEditor({ convId, file, selection, running, postFrame, onClear }: {
  convId: string;
  file: string | null;
  selection: Selection;
  running: boolean;
  postFrame: (msg: Record<string, unknown>) => void;
  onClear: () => void;
}) {
  const [text, setText] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [prompt, setPrompt] = useState('');
  // Where the panel has been dragged to, in px inside the preview pane. Null
  // keeps it docked at the bottom centre, which is where it starts.
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const stopDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => stopDrag.current?.(), []);

  const id = selection.id;
  const seq = useRef(0);
  const pristine = useRef(true);
  // Values the element had when selected, used to send only real changes.
  const baseline = useRef<Map<string, string>>(new Map());

  // Re-seed the local fields only when a different element is selected, so a
  // user's in-progress edits are never clobbered by selection echoes.
  useEffect(() => {
    const inline = selection.detail.styles ?? {};
    const computed = selection.detail.computed ?? {};
    const next: Row[] = [];
    let n = 0;
    const base = new Map<string, string>();
    for (const [prop, value] of Object.entries(inline)) {
      next.push({ id: ++n, prop, value, inline: true });
      base.set(prop, value);
    }
    for (const [prop, value] of Object.entries(computed)) {
      if (prop in inline) continue;
      next.push({ id: ++n, prop, value, inline: false });
      base.set(prop, value);
    }
    seq.current = n;
    baseline.current = base;
    setText(selection.detail.text);
    setRows(next);
    setPrompt('');
    pristine.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Debounced: push text/style edits into the live frame as the user types.
  useEffect(() => {
    const t = setTimeout(() => {
      if (pristine.current) return; // nothing changed since selection
      const delta: Record<string, string | null> = {};
      const seen = new Set<string>();
      for (const r of rows) {
        const prop = r.prop.trim();
        if (!prop) continue;
        seen.add(prop);
        if (!r.value.trim()) {
          if (baseline.current.has(prop)) delta[prop] = null;
          continue;
        }
        if (r.value !== baseline.current.get(prop)) delta[prop] = r.value;
      }
      // A property whose row was removed must be explicitly cleared. Sending
      // null for a computed-only property is a harmless no-op.
      for (const prop of baseline.current.keys()) if (!seen.has(prop)) delta[prop] = null;
      if (Object.keys(delta).length === 0) return;
      postFrame({ type: 'update', id, text: selection.detail.hasChildren ? undefined : text, styles: delta });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, text, id, postFrame, selection.detail.hasChildren]);

  const ai = useMutation({
    mutationFn: (p: string) => api.post(`/api/design/${convId}/ai`, { file, prompt: p, element: selection.detail }),
    onSuccess: () => setPrompt(''),
    onError: (e: Error) => toast.error(e.message),
  });

  const editText = (v: string) => { pristine.current = false; setText(v); };
  const setRow = (i: number, patch: Partial<Row>) => {
    pristine.current = false;
    setRows((list) => list.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };
  const removeRow = (i: number) => { pristine.current = false; setRows((list) => list.filter((_, j) => j !== i)); };
  const addRow = () => {
    pristine.current = false;
    setRows((l) => [...l, { id: ++seq.current, prop: '', value: '', inline: false }]);
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (prompt.trim() && !running && !ai.isPending) ai.mutate(prompt.trim());
  };

  // The header is the drag grip, so the panel can be parked anywhere in the
  // canvas instead of covering the element being edited.
  const startDrag = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const box = boxRef.current;
    const parent = box?.offsetParent as HTMLElement | null;
    if (!box || !parent) return;
    if ((e.target as HTMLElement).closest('button, input, textarea, select, a')) return;
    e.preventDefault();
    const pRect = parent.getBoundingClientRect();
    const bRect = box.getBoundingClientRect();
    const from = { x: bRect.left - pRect.left, y: bRect.top - pRect.top };
    const startX = e.clientX;
    const startY = e.clientY;
    const clamp = (x: number, y: number) => ({
      x: Math.round(Math.min(Math.max(0, parent.clientWidth - bRect.width), Math.max(0, x))),
      y: Math.round(Math.min(Math.max(0, parent.clientHeight - bRect.height), Math.max(0, y))),
    });
    // Pin the panel where it currently floats so it does not jump on the first move.
    setPos(clamp(from.x, from.y));
    const move = (ev: PointerEvent) => setPos(clamp(from.x + ev.clientX - startX, from.y + ev.clientY - startY));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      stopDrag.current = null;
    };
    stopDrag.current = up;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  return (
    <div
      ref={boxRef}
      style={pos ? { left: pos.x, top: pos.y } : undefined}
      className={cn(
        'pointer-events-auto absolute z-20 flex w-[min(28rem,calc(100%-1.5rem))] flex-col overflow-hidden rounded-xl border border-line bg-panel/95 shadow-pop backdrop-blur',
        !pos && 'bottom-3 left-1/2 -translate-x-1/2',
      )}
    >
      <datalist id={LIST_ID}>
        {CSS_PROPERTIES.map((p) => <option key={p} value={p} />)}
      </datalist>

      <div
        onPointerDown={startDrag}
        onDoubleClick={() => setPos(null)}
        title="Drag to move · double-click to dock"
        className="flex cursor-grab touch-none select-none items-center gap-2 border-b border-line px-3 py-2 active:cursor-grabbing"
      >
        <GripHorizontal className="size-3.5 shrink-0 text-faint" />
        <span className="rounded-md bg-violet/10 px-1.5 py-0.5 font-mono text-[11px] leading-4 text-violet">&lt;{selection.detail.tag}&gt;</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-faint" title={selection.detail.selector}>{selection.detail.selector}</span>
        <Tip label="Delete element"><Button variant="ghost" size="icon-sm" aria-label="Delete element" onClick={() => postFrame({ type: 'remove', id: selection.id })}><Trash2 /></Button></Tip>
        <Tip label="Deselect"><Button variant="ghost" size="icon-sm" aria-label="Deselect" onClick={onClear}><X /></Button></Tip>
      </div>

      {!selection.detail.hasChildren ? (
        <div className="border-b border-line px-3 py-2.5">
          <Field label="Text">
            <Textarea value={text} onChange={(e) => editText(e.target.value)} rows={2} className="min-h-14" />
          </Field>
        </div>
      ) : null}

      <div className="max-h-44 overflow-y-auto border-b border-line px-3 py-2.5">
        <div className="mb-1.5 flex items-center justify-between">
          <Label>Styles</Label>
          <Button size="sm" variant="ghost" className="h-6 gap-1 px-1.5 font-mono text-[11px]" onClick={addRow}><Plus />Add</Button>
        </div>
        <div className="grid gap-1.5">
          {rows.length === 0 ? <p className="m-0 text-xs text-faint">No styles. Add a property to override.</p> : null}
          {rows.map((r, i) => (
            <div key={r.id} className="flex items-center gap-1.5">
              <Input
                value={r.prop}
                onChange={(e) => setRow(i, { prop: e.target.value })}
                placeholder="property"
                spellCheck={false}
                list={LIST_ID}
                title={r.inline ? 'Inline style' : 'Computed value (edit to override)'}
                className="h-7 w-[40%] min-w-0 px-2 font-mono text-xs"
              />
              <Input
                value={r.value}
                onChange={(e) => setRow(i, { value: e.target.value })}
                placeholder="value"
                spellCheck={false}
                className="h-7 min-w-0 flex-1 px-2 font-mono text-xs"
              />
              {isColor(r.prop.trim(), r.value) ? (
                <ColorField value={r.value} onChange={(v) => setRow(i, { value: v })} />
              ) : null}
              <Button variant="ghost" size="icon-sm" aria-label="Remove property" onClick={() => removeRow(i)}><X /></Button>
            </div>
          ))}
        </div>
      </div>

      <form onSubmit={submit} className="flex items-center gap-1.5 px-3 py-2">
        <Sparkles className={cn('size-4 shrink-0', ai.isPending ? 'text-violet' : 'text-faint')} />
        <Input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Ask AI to change this element…"
          className="h-8 min-w-0 flex-1 px-2.5 text-[13px]"
        />
        <Button type="submit" size="icon-sm" aria-label="Send to AI" disabled={!prompt.trim() || running || ai.isPending}>
          {ai.isPending ? <Spinner className="size-3.5" /> : <Send />}
        </Button>
      </form>
    </div>
  );
}

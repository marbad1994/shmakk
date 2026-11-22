import { useRef, useState } from 'react';
import { Eraser, Hand, MessageSquarePlus, Pencil, Send, SlidersHorizontal, Type } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tip } from '@/components/ui/tooltip';

export type BrowserTool = 'move' | 'comment' | 'draw' | 'text' | 'edit';

export interface InspectedElement {
  tag: string;
  selector: string;
  text: string;
  role: string | null;
  name: string | null;
  href: string | null;
  rect: { x: number; y: number; w: number; h: number };
  page: { href: string; title: string };
}

export interface Note {
  id: string;
  kind: 'comment' | 'text' | 'element';
  x: number;
  y: number;
  text: string;
  element?: InspectedElement;
}

export interface Stroke {
  id: string;
  points: { x: number; y: number }[];
}

export const TOOLS: { id: BrowserTool; label: string; icon: React.ReactNode }[] = [
  { id: 'move', label: 'Interact with the page', icon: <Hand /> },
  { id: 'comment', label: 'Drop a comment', icon: <MessageSquarePlus /> },
  { id: 'draw', label: 'Draw on the page', icon: <Pencil /> },
  { id: 'text', label: 'Write on the page', icon: <Type /> },
  { id: 'edit', label: 'Pick an element to change', icon: <SlidersHorizontal /> },
];

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Human description of where a note sits, for the prompt sent to the agent. */
export function describeNote(n: Note): string {
  const at = `${Math.round(n.x * 100)}% across, ${Math.round(n.y * 100)}% down`;
  if (n.kind === 'element' && n.element) {
    const e = n.element;
    const name = [e.name ? `name="${e.name}"` : '', e.href ? `href="${e.href}"` : '', e.role ? `role=${e.role}` : ''].filter(Boolean).join(' ');
    return `<${e.tag}>${name ? ` ${name}` : ''} (\`${e.selector}\`) at ${at}${n.text ? ` — ${n.text}` : ''}`;
  }
  return `${n.kind === 'text' ? 'note' : 'pin'} at ${at} — ${n.text}`;
}

/** A message the agent can act on, built from the marks on the streamed page. */
export function buildAnnotationPrompt(url: string, notes: Note[], strokes: Stroke[]): string {
  const lines: string[] = [];
  lines.push(`I marked up the page you have open (${url || 'the shared browser'}).`);
  if (notes.length) {
    lines.push('');
    notes.forEach((n, i) => lines.push(`${i + 1}. ${describeNote(n)}`));
  }
  if (strokes.length) {
    lines.push('');
    lines.push(`There ${strokes.length === 1 ? 'is' : 'are'} also ${strokes.length} freehand mark${strokes.length === 1 ? '' : 's'} on the page (see the browser pane) showing the area I mean.`);
  }
  lines.push('');
  lines.push('Make these changes in the source and reload the page when you are done.');
  return lines.join('\n');
}

/**
 * Sits exactly over the screencast frame. In `move` mode it is transparent to
 * pointer events (they go to the shared page); with any other tool it catches
 * them to place marks. Coordinates are fractions of the frame so they survive
 * a resize.
 */
export function AnnotationLayer({ dims, tool, notes, strokes, selected, onPlace, onDraw, onSelect }: {
  dims: { w: number; h: number };
  tool: BrowserTool;
  notes: Note[];
  strokes: Stroke[];
  selected: string | null;
  onPlace: (x: number, y: number) => void;
  onDraw: (stroke: Stroke) => void;
  onSelect: (id: string) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState<Stroke | null>(null);
  const drawing = tool === 'draw';

  const point = (e: React.PointerEvent) => {
    const r = boxRef.current?.getBoundingClientRect();
    if (!r || !r.width || !r.height) return null;
    return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (tool === 'move') return;
    const p = point(e);
    if (!p) return;
    if (drawing) {
      e.currentTarget.setPointerCapture?.(e.pointerId);
      setLive({ id: `s${Date.now().toString(36)}`, points: [p] });
      return;
    }
    onPlace(p.x, p.y);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drawing || !live) return;
    const p = point(e);
    if (!p) return;
    setLive((s) => (s ? { ...s, points: [...s.points, p] } : s));
  };

  const finish = () => {
    if (!live) return;
    if (live.points.length > 1) onDraw(live);
    setLive(null);
  };

  const all = live ? [...strokes, live] : strokes;

  return (
    <div
      ref={boxRef}
      className={cn('absolute inset-0 z-10', tool === 'move' ? 'pointer-events-none' : 'cursor-crosshair touch-none')}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      role={tool === 'move' ? undefined : 'application'}
      aria-label={tool === 'move' ? undefined : 'Annotate the page'}
    >
      <svg className="pointer-events-none absolute inset-0 size-full" viewBox={`0 0 ${dims.w} ${dims.h}`} preserveAspectRatio="none" aria-hidden>
        {all.map((s) => (
          <polyline
            key={s.id}
            points={s.points.map((p) => `${p.x * dims.w},${p.y * dims.h}`).join(' ')}
            fill="none"
            stroke="#f43f5e"
            strokeWidth={Math.max(2, dims.w / 320)}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>

      {notes.map((n, i) => (
        <button
          key={n.id}
          type="button"
          onClick={(e) => { e.stopPropagation(); onSelect(n.id); }}
          style={{ left: `${n.x * 100}%`, top: `${n.y * 100}%` }}
          className={cn(
            'pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 rounded-full text-[11px] font-medium shadow-pop outline-none',
            'grid size-6 place-items-center ring-2 transition-colors',
            n.kind === 'element' ? 'bg-violet text-white ring-violet/30' : 'bg-accent text-accent-ink ring-accent/30',
            selected === n.id && 'ring-4 ring-accent/40',
          )}
          aria-label={n.text || describeNote(n)}
          title={describeNote(n)}
        >
          {i + 1}
        </button>
      ))}

      {notes.filter((n) => n.kind === 'text' && n.text).map((n) => (
        <span
          key={`t-${n.id}`}
          style={{ left: `${n.x * 100}%`, top: `${n.y * 100}%` }}
          className="pointer-events-none absolute max-w-[60%] -translate-y-1/2 translate-x-3 rounded-md bg-accent px-1.5 py-0.5 text-[12px] text-accent-ink shadow-pop"
        >
          {n.text}
        </span>
      ))}
    </div>
  );
}

/** Floating toolbar over the page: pick a tool, send the marks, or wipe them. */
export function AnnotationToolbar({ tool, onTool, count, canSend, onSend, onClear }: {
  tool: BrowserTool;
  onTool: (t: BrowserTool) => void;
  count: number;
  canSend: boolean;
  onSend: () => void;
  onClear: () => void;
}) {
  return (
    <div className="pointer-events-auto flex items-center gap-0.5 rounded-full border border-line bg-panel/95 p-1 shadow-pop backdrop-blur">
      {TOOLS.map((t) => (
        <Tip key={t.id} label={t.label}>
          <button
            type="button"
            aria-label={t.label}
            aria-pressed={tool === t.id}
            onClick={() => onTool(t.id)}
            className={cn('grid size-8 place-items-center rounded-full text-dim outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/40 [&_svg]:size-4', tool === t.id && 'bg-accent text-accent-ink hover:bg-accent hover:text-accent-ink')}
          >
            {t.icon}
          </button>
        </Tip>
      ))}
      <span className="mx-0.5 h-5 w-px bg-line" aria-hidden />
      <Tip label={count ? `Send ${count} mark${count === 1 ? '' : 's'} to the agent` : 'Nothing marked yet'}>
        <button
          type="button"
          aria-label="Send marks to the agent"
          disabled={!canSend}
          onClick={onSend}
          className="relative grid size-8 place-items-center rounded-full text-dim outline-none transition-colors hover:bg-hover hover:text-fg disabled:opacity-40 [&_svg]:size-4"
        >
          <Send />
          {count ? <span className="absolute -right-0.5 -top-0.5 grid min-w-4 place-items-center rounded-full bg-accent px-1 text-[10px] font-medium text-accent-ink">{count}</span> : null}
        </button>
      </Tip>
      <Tip label="Clear the marks">
        <button
          type="button"
          aria-label="Clear the marks"
          disabled={!count}
          onClick={onClear}
          className="grid size-8 place-items-center rounded-full text-dim outline-none transition-colors hover:bg-hover hover:text-fg disabled:opacity-40 [&_svg]:size-4"
        >
          <Eraser />
        </button>
      </Tip>
    </div>
  );
}

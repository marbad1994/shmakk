import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, ArrowUpRight, RotateCw, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useApp } from '@/store/app';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/misc';
import { Tip } from '@/components/ui/tooltip';
import { AnnotationLayer, AnnotationToolbar, buildAnnotationPrompt, type BrowserTool, type InspectedElement, type Note, type Stroke } from './BrowserAnnotate';

interface FrameMsg { t: 'frame'; data: string; metadata: { deviceWidth: number; deviceHeight: number } | null; url: string }
interface StateMsg { t: 'state'; open: boolean; url: string }
interface UrlMsg { t: 'url'; url: string }
interface InspectedMsg { t: 'inspected'; id?: string; ok?: boolean; detail?: InspectedElement | null; error?: string }
interface NavigatedMsg { t: 'navigated'; id?: string; ok?: boolean; url?: string; error?: string }

type Msg = FrameMsg | StateMsg | UrlMsg | InspectedMsg | NavigatedMsg | { t: 'pong' };

interface Server { port: number; url: string; title: string | null }

// CDP `Input.dispatchKeyEvent` modifier bitmask (Alt=1, Ctrl=2, Meta=4, Shift=8).
const MOD = { ALT: 1, CTRL: 2, META: 4, SHIFT: 8 } as const;
const KEY_FORWARD_MAP: Record<string, { key: string; code: string }> = {
  [`${MOD.CTRL}:KeyR`]: { key: 'r', code: 'KeyR' },
  [`${MOD.CTRL | MOD.SHIFT}:KeyR`]: { key: 'r', code: 'KeyR' },
  [`${MOD.META}:KeyR`]: { key: 'r', code: 'KeyR' },
  [`${MOD.META | MOD.SHIFT}:KeyR`]: { key: 'r', code: 'KeyR' },
};
const KEY = 'shmakk.browser.url';

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const normalise = (raw: string) => {
  const v = raw.trim();
  if (!v) return '';
  if (/^[a-z]+:\/\//i.test(v)) return v;
  if (/^:?\d{2,5}(\/|$)/.test(v)) return `http://localhost:${v.replace(/^:/, '')}`;
  if (/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(v)) return `http://${v}`;
  return `https://${v}`;
};

const readSaved = () => { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } };
const save = (u: string) => { try { localStorage.setItem(KEY, u); } catch { /* private mode */ } };

function modifierMask(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (e.altKey ? MOD.ALT : 0) | (e.ctrlKey ? MOD.CTRL : 0) | (e.metaKey ? MOD.META : 0) | (e.shiftKey ? MOD.SHIFT : 0);
}

function isEditableTarget(el: EventTarget | null): boolean {
  if (!el || !('isContentEditable' in el)) return false;
  const node = el as HTMLElement;
  return node.isContentEditable || node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.tagName === 'SELECT';
}

/**
 * The one browser pane: a live screencast of the page the agent's `browser`
 * tool is driving, with the user's pointer and keyboard injected into that same
 * page. Nobody sees a copy. A floating toolbar annotates what is on screen
 * (pins, freehand, notes, element picks) and hands the result to the composer,
 * so "change this" always points at the exact thing the agent is looking at.
 */
export function BrowserPane() {
  const [url, setUrl] = useState('');
  const [text, setText] = useState(() => readSaved());
  const [open, setOpen] = useState(false);
  const [frame, setFrame] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(true);
  const [dims, setDims] = useState({ w: 1280, h: 720 });
  const [tool, setTool] = useState<BrowserTool>('move');
  const [notes, setNotes] = useState<Note[]>([]);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [navigating, setNavigating] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const pendingInspect = useRef<{ id: string; x: number; y: number } | null>(null);

  const servers = useQuery({ queryKey: ['preview-servers'], queryFn: () => api.get<{ servers: Server[] }>('/api/preview/servers'), staleTime: 15000 });

  // The page is laid out at the pane's size, so the site's own breakpoints
  // apply to the dock instead of a desktop canvas being scaled down. CDP
  // captures frames at the page's viewport size, so this is also what makes
  // the image fill the pane exactly, with no letterbox.
  const [paneSize, setPaneSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setPaneSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let closed = false;
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws/browser`);
      wsRef.current = ws;
      setConnecting(true);
      ws.onopen = () => { retryRef.current = 0; setConnecting(false); };
      ws.onmessage = (ev) => {
        let msg: Msg;
        try { msg = JSON.parse(String(ev.data)); } catch { return; }
        if (msg.t === 'frame') {
          setFrame(msg.data);
          if (msg.url) { setUrl(msg.url); setText((cur) => (cur && cur !== msg.url ? cur : msg.url)); }
          if (msg.metadata) setDims({ w: msg.metadata.deviceWidth || 1280, h: msg.metadata.deviceHeight || 720 });
        } else if (msg.t === 'state') {
          setOpen(!!msg.open);
          if (msg.url) { setUrl(msg.url); setText((cur) => cur || msg.url); }
        } else if (msg.t === 'url') {
          setUrl(msg.url);
        } else if (msg.t === 'navigated') {
          setNavigating(false);
          if (!msg.ok && msg.error) toast.error(`Could not open the page: ${msg.error}`);
        } else if (msg.t === 'inspected') {
          const pending = pendingInspect.current;
          if (!pending || (msg.id && msg.id !== pending.id)) return;
          pendingInspect.current = null;
          if (!msg.ok || !msg.detail) { toast.error(msg.error || 'Nothing to pick there'); return; }
          const id = uid();
          setNotes((n) => [...n, { id, kind: 'element', x: pending.x, y: pending.y, text: '', element: msg.detail as InspectedElement }]);
          setSelected(id);
        }
      };
      ws.onclose = () => {
        if (closed) return;
        setFrame(null);
        const delay = Math.min(8000, 400 * 2 ** retryRef.current++);
        setTimeout(connect, delay);
      };
      ws.onerror = () => ws.close();
    };
    connect();
    return () => { closed = true; try { wsRef.current?.close(); } catch { /* already gone */ } };
  }, []);

  const send = useCallback((msg: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  // Debounced so a drag-resize sends one viewport instead of sixty.
  const sentViewport = useRef({ w: 0, h: 0 });
  useEffect(() => {
    if (!open) { sentViewport.current = { w: 0, h: 0 }; return; }
    const { w, h } = paneSize;
    if (!w || !h) return;
    const last = sentViewport.current;
    if (Math.abs(last.w - w) < 8 && Math.abs(last.h - h) < 8) return;
    const t = setTimeout(() => {
      sentViewport.current = { w, h };
      send({ t: 'viewport', width: w, height: h });
    }, 220);
    return () => clearTimeout(t);
  }, [open, paneSize, send]);

  const forwardKey = useCallback((key: string, code: string, keyType: 'rawKeyDown' | 'keyDown' | 'keyUp', modifiers = 0, textValue = '') => {
    send({ t: 'input', event: { type: 'key', key, code, keyType, modifiers, text: textValue || undefined } });
  }, [send]);

  // Pointer/keyboard over the frame are mapped into the shared page's space.
  const normPoint = (e: { clientX: number; clientY: number }) => {
    const el = imgRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLImageElement>) => {
    if (tool !== 'move') return;
    const p = normPoint(e);
    if (!p) return;
    send({ t: 'input', event: { type: 'mouse', x: p.x, y: p.y, button: e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left' } });
  };

  const onWheel = (e: React.WheelEvent<HTMLImageElement>) => {
    if (tool !== 'move') return;
    const p = normPoint(e);
    if (!p) return;
    send({ t: 'input', event: { type: 'wheel', x: p.x, y: p.y, deltaX: e.deltaX, deltaY: e.deltaY } });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLImageElement>) => {
    if (tool !== 'move' || e.nativeEvent.isComposing || isEditableTarget(e.target)) return;
    const modifiers = modifierMask(e);
    const mapped = KEY_FORWARD_MAP[`${modifiers}:${e.code}`];
    if (mapped) {
      if (e.repeat) return;
      e.preventDefault();
      forwardKey(mapped.key, mapped.code, 'rawKeyDown', modifiers);
      forwardKey(mapped.key, mapped.code, 'keyUp', modifiers);
      return;
    }
    if (modifiers !== 0) return;
    if (!e.key || e.key.length > 1) return;
    forwardKey(e.key, `Key${e.key.toUpperCase()}`, 'keyDown', 0, e.key);
    forwardKey(e.key, `Key${e.key.toUpperCase()}`, 'keyUp', 0, e.key);
  };

  const go = (raw: string) => {
    const next = normalise(raw);
    if (!next) return;
    setText(next);
    save(next);
    setNavigating(true);
    send({ t: 'navigate', url: next, id: uid() });
    setTimeout(() => setNavigating(false), 8000);
  };

  const command = (name: 'back' | 'forward' | 'reload') => send({ t: 'command', name, id: uid() });

  // A mark lands where the user clicked: comments and notes immediately, an
  // element pick after the server reads the DOM under the point.
  const place = (x: number, y: number) => {
    if (tool === 'edit') {
      pendingInspect.current = { id: uid(), x, y };
      send({ t: 'inspect', x, y, id: pendingInspect.current.id });
      toast('Reading the element under the cursor…');
      return;
    }
    const id = uid();
    setNotes((n) => [...n, { id, kind: tool === 'text' ? 'text' : 'comment', x, y, text: '' }]);
    setSelected(id);
  };

  const selectedNote = notes.find((n) => n.id === selected) ?? null;

  const updateNote = (id: string, patch: Partial<Note>) => setNotes((list) => list.map((n) => (n.id === id ? { ...n, ...patch } : n)));

  const removeNote = (id: string) => {
    setNotes((list) => list.filter((n) => n.id !== id));
    setSelected((cur) => (cur === id ? null : cur));
    setTool('move');
  };

  const closeEditor = () => {
    // A pin or note with no words is not a mark; drop it.
    if (selectedNote && !selectedNote.text.trim() && selectedNote.kind !== 'element') removeNote(selectedNote.id);
    setSelected(null);
  };

  const clearMarks = () => { setNotes([]); setStrokes([]); setSelected(null); };

  const sendMarks = () => {
    const filled = notes.filter((n) => n.text.trim() || n.kind === 'element');
    if (!filled.length && !strokes.length) return;
    useApp.getState().setDraft(buildAnnotationPrompt(url, filled, strokes), 'ask');
    toast('Marks sent to the composer — add anything you want to say and send.');
    setSelected(null);
    setTool('move');
  };

  const markCount = notes.filter((n) => n.text.trim() || n.kind === 'element').length + strokes.length;
  const serverList = servers.data?.servers ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1.5">
        <Tip label="Back"><Button variant="ghost" size="icon-sm" aria-label="Back" disabled={!open} onClick={() => command('back')}><ArrowLeft /></Button></Tip>
        <Tip label="Forward"><Button variant="ghost" size="icon-sm" aria-label="Forward" disabled={!open} onClick={() => command('forward')}><ArrowRight /></Button></Tip>
        <Tip label="Reload"><Button variant="ghost" size="icon-sm" aria-label="Reload page" disabled={!open} onClick={() => command('reload')}><RotateCw /></Button></Tip>
        <form className="flex min-w-0 flex-1 items-center gap-1" onSubmit={(e) => { e.preventDefault(); go(text); }}>
          <Input value={text} onChange={(e) => setText(e.target.value)} onFocus={(e) => e.target.select()} aria-label="Address" placeholder="localhost:5173 or a full URL" spellCheck={false} className="h-8 min-w-0 flex-1 text-[12.5px]" />
        </form>
        {navigating ? <Spinner className="size-3.5 shrink-0" /> : null}
        <Tip label="Open in a real tab"><Button variant="ghost" size="icon-sm" aria-label="Open in a new tab" disabled={!url} onClick={() => url && window.open(url, '_blank', 'noopener')}><ArrowUpRight /></Button></Tip>
      </div>

      <div ref={wrapRef} className="relative min-h-0 flex-1 overflow-hidden bg-sunken">
        {!connecting && !open ? (
          <div className="grid h-full place-content-center gap-2 p-6 text-center text-[13px] text-dim">
            <p className="m-0">The agent has no page open. Ask it to open one, start a dev server, or type an address above.</p>
            {serverList.length ? (
              <div className="flex flex-wrap justify-center gap-2">
                {serverList.slice(0, 4).map((s) => (
                  <Button key={s.port} size="sm" variant="ghost" onClick={() => go(s.url)}>{s.title ? `${s.title} (:${s.port})` : `:${s.port}`}</Button>
                ))}
              </div>
            ) : null}
          </div>
        ) : frame ? (
          <div className="relative size-full overflow-hidden bg-white">
            <img
              ref={imgRef}
              src={`data:image/jpeg;base64,${frame}`}
              alt="The page the agent is on"
              className={cn('absolute inset-0 size-full select-none object-contain', tool === 'move' ? 'cursor-pointer' : 'cursor-default')}
              tabIndex={0}
              onPointerDown={onPointerDown}
              onWheel={onWheel}
              onKeyDown={onKeyDown}
            />
            <AnnotationLayer
              dims={dims}
              tool={tool}
              notes={notes}
              strokes={strokes}
              selected={selected}
              onPlace={place}
              onDraw={(s) => setStrokes((list) => [...list, s])}
              onSelect={setSelected}
            />
          </div>
        ) : (
          <div className="grid h-full place-items-center"><Spinner className="size-5" /></div>
        )}

        {/* Note editor: sits above the toolbar so the page stays visible. */}
        {selectedNote ? (
          <div className="pointer-events-auto absolute inset-x-3 bottom-16 z-20 rounded-xl border border-line bg-panel/95 p-2.5 shadow-pop backdrop-blur">
            <div className="mb-1.5 flex items-center gap-1.5 text-[11.5px] text-dim">
              <span className="min-w-0 flex-1 truncate">
                {selectedNote.kind === 'element' && selectedNote.element
                  ? <>Change &lt;{selectedNote.element.tag}&gt; <span className="text-faint">{selectedNote.element.selector}</span></>
                  : selectedNote.kind === 'text' ? 'Note on the page' : 'Comment on the page'}
              </span>
              <button type="button" aria-label="Remove mark" className="text-faint hover:text-danger" onClick={() => removeNote(selectedNote.id)}><X className="size-3.5" /></button>
            </div>
            <textarea
              autoFocus
              value={selectedNote.text}
              onChange={(e) => updateNote(selectedNote.id, { text: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); closeEditor(); } }}
              placeholder={selectedNote.kind === 'element' ? 'What should change about this element?' : 'What do you want here?'}
              aria-label="Mark note"
              className="w-full resize-y rounded-lg border border-line-strong bg-sunken px-2.5 py-1.5 text-[13px] text-fg outline-none placeholder:text-faint focus:border-accent/45 focus:ring-[3px] focus:ring-accent/15"
              rows={2}
            />
            <div className="mt-1.5 flex items-center justify-end gap-1.5">
              <Button size="sm" variant="ghost" onClick={closeEditor}>Done</Button>
            </div>
          </div>
        ) : null}

        {/* Floating toolbar, like a drawing app over the live page. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-3">
          <AnnotationToolbar
            tool={tool}
            onTool={(t) => { setSelected(null); setTool(t); }}
            count={markCount}
            canSend={!!frame && markCount > 0}
            onSend={sendMarks}
            onClear={clearMarks}
          />
        </div>
      </div>
    </div>
  );
}

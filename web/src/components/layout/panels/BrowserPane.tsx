import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, ArrowUpRight, Monitor, MousePointerClick, RefreshCw, RotateCw, Smartphone, Tablet, WifiOff } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/misc';
import { Tip } from '@/components/ui/tooltip';
import { BrowserEdit, type PickedElement } from './BrowserEdit';

type Device = 'desktop' | 'tablet' | 'phone';
const WIDTH: Record<Device, number | null> = { desktop: null, tablet: 820, phone: 390 };
const KEY = 'shmakk.browser.url';

interface LinkRes { path: string; port: number; origin: string | null; target: string }
interface Probe { ok: boolean; status?: number; title?: string | null; error?: string }
interface Server { port: number; url: string; title: string | null }

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

/**
 * Live preview of whatever the workspace serves. The page is fetched by the
 * shmakk server through its preview proxy, so "localhost" means the machine
 * shmakk runs on (also when it runs in Docker or on another host), framing
 * restrictions do not apply, and HMR keeps working. Edit mode lets you pick
 * elements and describe changes; those become planned tasks.
 */
export function BrowserPane() {
  const [target, setTarget] = useState(() => readSaved());
  const [text, setText] = useState(target);
  const [src, setSrc] = useState<string | null>(null);
  const [previewOrigin, setPreviewOrigin] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [device, setDevice] = useState<Device>('desktop');
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'down' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [ready, setReady] = useState(false);
  const [picked, setPicked] = useState<PickedElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);

  const servers = useQuery({ queryKey: ['preview-servers'], queryFn: () => api.get<{ servers: Server[] }>('/api/preview/servers'), staleTime: 15000 });

  // First visit: pick the first dev server found on the machine.
  useEffect(() => {
    if (target || !servers.data?.servers.length) return;
    const first = servers.data.servers[0].url;
    setTarget(first);
    setText(first);
  }, [target, servers.data]);

  // Probe from the server, then load through the proxy with a fresh link.
  useEffect(() => {
    if (!target) return;
    let alive = true;
    setState('loading');
    setError(null);
    setReady(false);
    setPicked(null);
    (async () => {
      try {
        const probe = await api.get<Probe>(`/api/preview/probe?url=${encodeURIComponent(target)}`);
        if (!alive) return;
        if (!probe.ok) { setState('down'); setError(probe.error || null); setSrc(null); return; }
        const link = await api.post<LinkRes>('/api/preview/link', { url: target });
        if (!alive) return;
        const origin = link.origin || `${location.protocol}//${location.hostname}:${link.port}`;
        setPreviewOrigin(origin);
        setSrc(`${origin}${link.path}`);
        setState('ready');
      } catch (e) {
        if (!alive) return;
        setState('error');
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { alive = false; };
  }, [target, nonce]);

  const post = useCallback((msg: Record<string, unknown>) => {
    frameRef.current?.contentWindow?.postMessage({ source: 'shmakk-preview', ...msg }, '*');
  }, []);

  // Messages from the inspector inside the previewed page.
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const targetRef = useRef(target);
  targetRef.current = target;
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
      const d = e.data as { source?: string; type?: string; path?: string; id?: string; detail?: PickedElement['detail'] };
      if (!d || d.source !== 'shmakk-preview') return;
      if (d.type === 'ready') { setReady(true); if (editingRef.current) post({ type: 'enable' }); }
      else if (d.type === 'nav' && typeof d.path === 'string') {
        // Keep the address bar on the real address, not the proxy's.
        try {
          const real = new URL(d.path, targetRef.current).href;
          setText(real);
          save(real);
        } catch { /* ignore */ }
      } else if (d.type === 'selected' && d.id && d.detail) setPicked({ id: d.id, detail: d.detail });
      else if (d.type === 'cleared') setPicked(null);
      else if (d.type === 'tweaked' && d.id && d.detail) setPicked((p) => (p && p.id === d.id ? { ...p, detail: d.detail as PickedElement['detail'] } : p));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [post]);

  useEffect(() => { post({ type: editing ? 'enable' : 'disable' }); if (!editing) setPicked(null); }, [editing, post]);

  const go = (raw: string) => {
    const next = normalise(raw);
    if (!next) return;
    setText(next);
    save(next);
    if (next === target) setNonce((n) => n + 1);
    else setTarget(next);
  };
  const reload = () => { if (ready) post({ type: 'reload' }); else setNonce((n) => n + 1); };
  const size = useMemo(() => WIDTH[device], [device]);
  const serverList = servers.data?.servers ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col bg-sunken">
      <div className="flex shrink-0 items-center gap-1 border-b border-line bg-panel px-2 py-1.5">
        <Tip label="Back"><Button variant="ghost" size="icon-sm" aria-label="Back" disabled={!ready} onClick={() => post({ type: 'back' })}><ArrowLeft /></Button></Tip>
        <Tip label="Forward"><Button variant="ghost" size="icon-sm" aria-label="Forward" disabled={!ready} onClick={() => post({ type: 'forward' })}><ArrowRight /></Button></Tip>
        <Tip label="Reload"><Button variant="ghost" size="icon-sm" aria-label="Reload preview" onClick={reload}><RotateCw /></Button></Tip>
        <form className="flex min-w-0 flex-1 items-center gap-1" onSubmit={(e) => { e.preventDefault(); go(text); }}>
          <Input value={text} onChange={(e) => setText(e.target.value)} onFocus={(e) => e.target.select()} aria-label="Address" placeholder="localhost:5173 or a full URL" spellCheck={false} className="h-8 min-w-0 flex-1 text-[12.5px]" />
        </form>
        <Tip label="Open in a real tab"><Button variant="ghost" size="icon-sm" aria-label="Open in a new tab" disabled={!src} onClick={() => src && window.open(src, '_blank', 'noopener')}><ArrowUpRight /></Button></Tip>
      </div>

      <div className="flex shrink-0 items-center gap-1.5 border-b border-line px-2 py-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto no-scrollbar">
          {serverList.map((s) => (
            <Tip key={s.port} label={s.title || s.url}>
              <button type="button" onClick={() => go(s.url)}
                className={cn('shrink-0 rounded-md px-1.5 py-0.5 text-[11.5px] text-faint hover:bg-hover hover:text-fg', target.startsWith(s.url) && 'bg-raised text-fg')}>
                :{s.port}
              </button>
            </Tip>
          ))}
          {servers.isFetching ? <Spinner className="size-3" /> : (
            <Tip label={serverList.length ? 'Look for servers again' : 'No dev servers found, look again'}>
              <button type="button" aria-label="Find dev servers" onClick={() => void servers.refetch()} className="grid size-6 shrink-0 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg"><RefreshCw className="size-3" /></button>
            </Tip>
          )}
        </div>
        <div className="flex shrink-0 rounded-lg border border-line p-0.5" role="radiogroup" aria-label="Preview size">
          {([['desktop', <Monitor key="d" />], ['tablet', <Tablet key="t" />], ['phone', <Smartphone key="p" />]] as [Device, React.ReactNode][]).map(([d, icon]) => (
            <Tip key={d} label={d}><button type="button" role="radio" aria-checked={device === d} aria-label={d} onClick={() => setDevice(d)} className={cn('grid size-6 place-items-center rounded-md text-faint hover:text-fg [&_svg]:size-3.5', device === d && 'bg-raised text-fg')}>{icon}</button></Tip>
          ))}
        </div>
        <Tip label={editing ? 'Stop picking elements' : 'Edit in browser: pick an element and describe the change'}>
          <Button variant={editing ? 'primary' : 'ghost'} size="sm" aria-pressed={editing} disabled={state !== 'ready'} onClick={() => setEditing((v) => !v)}><MousePointerClick />Edit</Button>
        </Tip>
      </div>

      <div className="relative min-h-0 flex-1 overflow-auto">
        {src && state === 'ready' ? (
          <div className={cn('mx-auto h-full bg-white transition-[width] duration-200', size ? 'py-3' : null)} style={size ? { width: size, maxWidth: '100%' } : undefined}>
            <iframe
              ref={frameRef}
              key={src}
              src={src}
              title="Browser preview"
              className={cn('size-full border-0 bg-white', editing && 'outline outline-2 -outline-offset-2 outline-violet/60')}
              allow="clipboard-read; clipboard-write; fullscreen"
            />
          </div>
        ) : null}

        {state === 'loading' ? <div className="absolute inset-0 grid place-items-center"><Spinner className="size-5" /></div> : null}

        {!target && state === 'idle' ? (
          <div className="grid h-full place-content-center gap-2 p-6 text-center text-[13px] text-dim">
            {servers.isLoading ? <Spinner className="mx-auto size-5" /> : <p className="m-0">No dev server is running on the shmakk machine. Start one (for example <code>npm run dev</code>) or type an address above.</p>}
          </div>
        ) : null}

        {state === 'down' || state === 'error' ? (
          <div className="absolute inset-x-3 top-3 rounded-xl border border-warn/40 bg-panel/95 p-3 text-[13px] shadow-pop backdrop-blur">
            <div className="flex items-center gap-2 font-medium text-warn"><WifiOff className="size-4" />{state === 'down' ? `Nothing answered at ${target}` : 'The preview could not be opened'}</div>
            <p className="m-0 mt-1 text-dim">
              {state === 'down'
                ? 'The address is fetched by the shmakk server, so it has to be reachable from the machine shmakk runs on. Start the dev server there, or pick one that is running:'
                : error}
            </p>
            {state === 'down' && error ? <p className="m-0 mt-1 text-[12px] text-faint">{error}</p> : null}
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" onClick={() => setNonce((n) => n + 1)}><RotateCw />Try again</Button>
              {serverList.filter((s) => !target.startsWith(s.url)).slice(0, 4).map((s) => <Button key={s.port} size="sm" variant="ghost" onClick={() => go(s.url)}>{s.title ? `${s.title} (:${s.port})` : `:${s.port}`}</Button>)}
            </div>
          </div>
        ) : null}
      </div>

      {editing || picked ? (
        <BrowserEdit
          picked={picked}
          pageUrl={text}
          previewOrigin={previewOrigin}
          onTweak={(id, tweak) => post({ type: 'tweak', id, ...tweak })}
          onClear={() => { setPicked(null); post({ type: 'clear' }); }}
          onReload={() => post({ type: 'reload' })}
        />
      ) : null}
    </div>
  );
}

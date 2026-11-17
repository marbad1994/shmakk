import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Monitor, RefreshCw, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/misc';
import { Tip } from '@/components/ui/tooltip';

interface FrameMsg {
  t: 'frame';
  data: string;
  metadata: { deviceWidth: number; deviceHeight: number } | null;
  url: string;
}
interface StateMsg { t: 'state'; open: boolean; url: string }
interface UrlMsg { t: 'url'; url: string }

type Msg = FrameMsg | StateMsg | UrlMsg | { t: 'pong' };

/**
 * The live shared browser: streams the page the AI's `browser` tool is driving
 * via the /ws/browser screencast, and injects the user's pointer/keyboard
 * events back into that same page. The AI and the user therefore see and
 * control the same page instead of two divergent copies.
 */
export function LiveBrowser() {
  const [url, setUrl] = useState('');
  const [open, setOpen] = useState(false);
  const [frame, setFrame] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(true);
  const [dims, setDims] = useState({ w: 1280, h: 720 });
  const imgRef = useRef<HTMLImageElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);

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
          if (msg.url) setUrl(msg.url);
          if (msg.metadata) setDims({ w: msg.metadata.deviceWidth, h: msg.metadata.deviceHeight });
        } else if (msg.t === 'state') {
          setOpen(!!msg.open);
          if (msg.url) setUrl(msg.url);
        } else if (msg.t === 'url') {
          setUrl(msg.url);
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
    return () => { closed = true; try { wsRef.current?.close(); } catch {} };
  }, []);

  const send = useCallback((msg: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  // Map a pointer/keyboard event over the frame into the shared page's space.
  const normPoint = (e: { clientX: number; clientY: number }) => {
    const el = imgRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLImageElement>) => {
    const p = normPoint(e);
    if (!p) return;
    send({ t: 'input', event: { type: 'mouse', x: p.x, y: p.y, button: e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left' } });
  };

  const onWheel = (e: React.WheelEvent<HTMLImageElement>) => {
    const p = normPoint(e);
    if (!p) return;
    send({ t: 'input', event: { type: 'wheel', x: p.x, y: p.y, deltaX: e.deltaX, deltaY: e.deltaY } });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLImageElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (!e.key || e.key.length > 1) return; // navigation keys need more mapping
    send({ t: 'input', event: { type: 'key', key: e.key, code: `Key${e.key.toUpperCase()}`, text: e.key, down: true } });
    send({ t: 'input', event: { type: 'key', key: e.key, code: `Key${e.key.toUpperCase()}`, text: e.key, down: false } });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-line px-2 py-1.5">
        <Monitor className="size-3.5 text-dim" />
        <span className="min-w-0 flex-1 truncate text-[12px] text-dim" title={url}>
          {url || (open ? 'Shared browser' : 'No page open yet')}
        </span>
        {!connecting && !open ? <WifiOff className="size-3.5 text-warn" /> : null}
        <Tip label="Reload">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Reload shared page"
            disabled={!url}
            onClick={() => send({ t: 'input', event: { type: 'key', key: 'r', code: 'KeyR', down: true, modifiers: 2 } })}
          >
            <RefreshCw />
          </Button>
        </Tip>
        {url ? (
          <Tip label="Open in new tab">
            <Button variant="ghost" size="icon-sm" aria-label="Open in new tab" onClick={() => window.open(url, '_blank', 'noopener')}>
              <ArrowUpRight />
            </Button>
          </Tip>
        ) : null}
      </div>

      <div className="relative min-h-0 flex-1 overflow-auto bg-sunken">
        {connecting ? (
          <div className="grid h-full place-items-center"><Spinner className="size-5" /></div>
        ) : !open ? (
          <div className="grid h-full place-items-center px-6 text-center text-[13px] text-dim">
            The shared browser has no page open. Ask the AI to open one (for example &quot;open the docs&quot;), or wait for it to browse.
          </div>
        ) : frame ? (
          <div className="flex items-start justify-center p-3">
            <img
              ref={imgRef}
              src={`data:image/jpeg;base64,${frame}`}
              alt="Live shared browser"
              className="max-w-full cursor-pointer select-none rounded-lg border border-line shadow-pop"
              style={{ aspectRatio: `${dims.w} / ${dims.h}` }}
              tabIndex={0}
              onPointerDown={onPointerDown}
              onWheel={onWheel}
              onKeyDown={onKeyDown}
            />
          </div>
        ) : (
          <div className="grid h-full place-items-center"><Spinner className="size-5" /></div>
        )}
      </div>
    </div>
  );
}

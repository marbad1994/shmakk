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

// CDP `Input.dispatchKeyEvent` modifier bitmask values (Alt=1, Ctrl=2,
// Meta=4, Shift=8).
const MOD = { ALT: 1, CTRL: 2, META: 4, SHIFT: 8 } as const;

// Explicit allowlist of modifier shortcuts forwarded to the shared page.
// Only these combos cross the bridge; any other modifier combo is left alone
// so the surrounding browser/UI keeps its own accelerators (Ctrl+T, Ctrl+W,
// Cmd+K, Cmd+L, ...). Add an entry here to opt a shortcut in.
const KEY_FORWARD_MAP: Record<string, { key: string; code: string }> = {
  [`${MOD.CTRL}:KeyR`]: { key: 'r', code: 'KeyR' },
  [`${MOD.CTRL | MOD.SHIFT}:KeyR`]: { key: 'r', code: 'KeyR' },
  [`${MOD.META}:KeyR`]: { key: 'r', code: 'KeyR' },
  [`${MOD.META | MOD.SHIFT}:KeyR`]: { key: 'r', code: 'KeyR' },
};

function modifierMask(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (e.altKey ? MOD.ALT : 0) | (e.ctrlKey ? MOD.CTRL : 0) | (e.metaKey ? MOD.META : 0) | (e.shiftKey ? MOD.SHIFT : 0);
}

function isEditableTarget(el: EventTarget | null): boolean {
  if (!el || !('isContentEditable' in el)) return false;
  const node = el as HTMLElement;
  return node.isContentEditable || node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.tagName === 'SELECT';
}

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

  const forwardKey = useCallback(
    (key: string, code: string, keyType: 'rawKeyDown' | 'keyDown' | 'keyUp', modifiers = 0, text = '') => {
      send({ t: 'input', event: { type: 'key', key, code, keyType, modifiers, text: text || undefined } });
    },
    [send],
  );

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
    if (e.nativeEvent.isComposing || isEditableTarget(e.target)) return;

    const modifiers = modifierMask(e);
    const mapped = KEY_FORWARD_MAP[`${modifiers}:${e.code}`];

    // Explicitly mapped shortcut: forward a rawKeyDown + keyUp pair so the
    // shared page's own accelerator (e.g. Ctrl+R reload) actually fires.
    if (mapped) {
      if (e.repeat) return;
      e.preventDefault();
      forwardKey(mapped.key, mapped.code, 'rawKeyDown', modifiers);
      forwardKey(mapped.key, mapped.code, 'keyUp', modifiers);
      return;
    }

    // Any other modifier combo is a browser/UI shortcut — keep it guarded.
    if (modifiers !== 0) return;

    // Minimal parity: forward unmodified printable keys only.
    if (!e.key || e.key.length > 1) return; // navigation keys need more mapping
    forwardKey(e.key, `Key${e.key.toUpperCase()}`, 'keyDown', 0, e.key);
    forwardKey(e.key, `Key${e.key.toUpperCase()}`, 'keyUp', 0, e.key);
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
            onClick={() => {
              forwardKey('r', 'KeyR', 'rawKeyDown', MOD.CTRL);
              forwardKey('r', 'KeyR', 'keyUp', MOD.CTRL);
            }}
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

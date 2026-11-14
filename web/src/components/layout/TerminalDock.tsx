import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Maximize2, Minimize2, Plus, SquareTerminal, X } from 'lucide-react';
import { socket } from '@/lib/ws';
import { cn } from '@/lib/utils';
import { useApp } from '@/store/app';
import { haptic, useIsMobile } from '@/hooks/useMobile';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';

const KEYS: { label: string; data: string }[] = [
  { label: 'esc', data: '\x1b' }, { label: 'tab', data: '\t' }, { label: '^C', data: '\x03' }, { label: '^D', data: '\x04' },
  { label: '↑', data: '\x1b[A' }, { label: '↓', data: '\x1b[B' }, { label: '←', data: '\x1b[D' }, { label: '→', data: '\x1b[C' },
  { label: '^R', data: '\x12' }, { label: '^L', data: '\x0c' }, { label: '^Z', data: '\x1a' },
  { label: '|', data: '|' }, { label: '/', data: '/' }, { label: '-', data: '-' }, { label: '~', data: '~' }, { label: '&', data: '&' },
];

interface Tab { id: string; kind: 'shmakk' | 'shell'; title: string; dead: boolean }

function termTheme() {
  const css = getComputedStyle(document.documentElement);
  const v = (n: string) => css.getPropertyValue(n).trim();
  return {
    background: v('--sunken'), foreground: v('--fg'), cursor: v('--accent'), cursorAccent: v('--sunken'),
    selectionBackground: `${v('--accent')}55`,
    black: v('--line-strong'), red: v('--danger'), green: v('--accent'), yellow: v('--warn'), blue: v('--info'),
    magenta: v('--violet'), cyan: '#56c8d8', white: v('--fg'),
    brightBlack: v('--faint'), brightRed: v('--danger'), brightGreen: v('--accent-strong'), brightYellow: v('--warn'),
    brightBlue: v('--info'), brightMagenta: v('--violet'), brightCyan: '#7fdbe8', brightWhite: v('--fg'),
  };
}

/** One xterm instance bound to one server-side PTY. */
function TermPane({ tab, visible, onExit }: { tab: Tab; visible: boolean; onExit(id: string): void }) {
  const host = useRef<HTMLDivElement>(null);
  const fit = useRef<FitAddon | null>(null);
  const term = useRef<Terminal | null>(null);

  useEffect(() => {
    const t = new Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono') || 'monospace',
      fontSize: matchMedia('(max-width: 767px)').matches ? 12 : 13, lineHeight: 1.25, cursorBlink: true, scrollback: 5000, allowProposedApi: false, theme: termTheme(),
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(host.current!);
    term.current = t;
    fit.current = f;
    try { f.fit(); } catch { /* not laid out yet */ }

    socket.send({ t: 'term.open', id: tab.id, kind: tab.kind, cols: t.cols, rows: t.rows });
    const offData = t.onData((data) => socket.send({ t: 'term.input', id: tab.id, data }));
    const offResize = t.onResize(({ cols, rows }) => socket.send({ t: 'term.resize', id: tab.id, cols, rows }));
    const off = socket.on((msg) => {
      if (msg.t === 'term.data' && msg.id === tab.id) t.write(msg.data);
      if (msg.t === 'term.exit' && msg.id === tab.id) {
        t.write(`\r\n\x1b[2m[${msg.error || `process exited with code ${msg.code}`}]\x1b[0m\r\n`);
        onExit(tab.id);
      }
    });
    const ro = new ResizeObserver(() => { if (host.current?.offsetParent) { try { f.fit(); } catch { /* hidden */ } } });
    ro.observe(host.current!);
    const onTheme = () => { t.options.theme = termTheme(); };
    window.addEventListener('shmakk:theme', onTheme);
    return () => {
      window.removeEventListener('shmakk:theme', onTheme);
      ro.disconnect(); off(); offData.dispose(); offResize.dispose();
      socket.send({ t: 'term.close', id: tab.id });
      t.dispose();
    };
  }, [tab.id, tab.kind, onExit]);

  useEffect(() => {
    if (!visible) return;
    requestAnimationFrame(() => { try { fit.current?.fit(); } catch { /* ignore */ } term.current?.focus(); });
  }, [visible]);

  return <div ref={host} className={cn('absolute inset-0 pb-1 pl-2.5 pr-1 pt-2', !visible && 'invisible')} />;
}

export function TerminalDock() {
  const open = useApp((s) => s.dockOpen);
  const toggleDock = useApp((s) => s.toggleDock);
  const available = useApp((s) => s.features.terminal);
  const reason = useApp((s) => s.features.terminalReason);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [height, setHeight] = useState(() => Number(localStorage.getItem('shmakk.dockHeight')) || 320);
  const [max, setMax] = useState(false);
  const counter = useRef(0);
  const mobile = useIsMobile();
  const keyboardOpen = useApp((s) => s.keyboardOpen);
  const full = max || mobile;
  const sendKey = (data: string) => { haptic(); if (active) socket.send({ t: 'term.input', id: active, data }); };

  const add = useCallback((kind: Tab['kind']) => {
    const n = ++counter.current;
    const tab: Tab = { id: `t${Date.now().toString(36)}${n}`, kind, title: `${kind} ${n}`, dead: false };
    setTabs((t) => [...t, tab]);
    setActive(tab.id);
  }, []);
  const close = useCallback((id: string) => {
    setTabs((t) => {
      const next = t.filter((x) => x.id !== id);
      setActive((a) => (a === id ? next[next.length - 1]?.id ?? null : a));
      return next;
    });
  }, []);
  const onExit = useCallback((id: string) => setTabs((t) => t.map((x) => (x.id === id ? { ...x, dead: true } : x))), []);

  // First open spawns the real CLI.
  useEffect(() => { if (open && available && tabs.length === 0) add('shmakk'); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    const move = (ev: PointerEvent) => setHeight(Math.max(140, Math.min(window.innerHeight - 160, startH + startY - ev.clientY)));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setHeight((h) => { localStorage.setItem('shmakk.dockHeight', String(h)); return h; });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // Keep PTYs alive while the dock is hidden; only unmount when there are no tabs.
  if (!open && tabs.length === 0) return null;

  return (
    <section aria-label="Terminal" hidden={!open} className={cn('relative flex shrink-0 flex-col border-t border-line bg-sunken pl-[var(--sal)] pr-[var(--sar)]', full && 'min-h-0 flex-1')} style={full ? undefined : { height }}>
      {!full ? <div role="separator" aria-orientation="horizontal" aria-label="Resize terminal" onPointerDown={startResize} className="absolute inset-x-0 -top-1 z-10 h-2 cursor-ns-resize hover:bg-accent/15" /> : null}
      <div className="flex min-h-9 items-center gap-2 border-b border-line bg-panel py-1 pl-2.5 pr-2">
        <div role="tablist" className="flex min-w-0 flex-1 gap-0.5 overflow-x-auto">
          {tabs.map((t) => (
            <div key={t.id} role="tab" aria-selected={t.id === active} tabIndex={0} onClick={() => setActive(t.id)} onKeyDown={(e) => { if (e.key === 'Enter') setActive(t.id); }}
              className={cn('inline-flex cursor-default items-center gap-1.5 whitespace-nowrap rounded-[7px] py-1 pl-2.5 pr-1.5 font-mono text-xs text-dim', t.id === active && 'bg-raised text-fg')}>
              <span className={cn('size-1.5 rounded-full', t.dead ? 'bg-faint' : 'bg-accent')} />
              {t.title}
              <button type="button" aria-label={`Close ${t.title}`} onClick={(e) => { e.stopPropagation(); close(t.id); }} className="grid size-4 place-items-center rounded text-faint hover:bg-line hover:text-fg"><X className="size-3" /></button>
            </div>
          ))}
        </div>
        <Tip label="New shmakk terminal — the full CLI" side="top"><Button variant="ghost" size="sm" className="font-mono" onClick={() => add('shmakk')} disabled={!available}><Plus />shmakk</Button></Tip>
        <Tip label="New plain shell" side="top"><Button variant="ghost" size="sm" className="font-mono" onClick={() => add('shell')} disabled={!available}><Plus />shell</Button></Tip>
        <Tip label={max ? 'Restore' : 'Maximize'} side="top"><Button variant="ghost" size="icon-sm" className="max-md:hidden" aria-label={max ? 'Restore terminal' : 'Maximize terminal'} onClick={() => setMax((m) => !m)}>{max ? <Minimize2 /> : <Maximize2 />}</Button></Tip>
        <Tip label="Hide terminal (Ctrl+`)" side="top"><Button variant="ghost" size="icon-sm" className="max-md:hidden" aria-label="Hide terminal" onClick={() => toggleDock(false)}><X /></Button></Tip>
      </div>
      <div className="relative min-h-0 flex-1">
        {tabs.map((t) => <TermPane key={t.id} tab={t} visible={open && t.id === active} onExit={onExit} />)}
        {tabs.length === 0 ? (
          <div className="absolute inset-0 grid place-content-center justify-items-center gap-2.5 p-5 text-center text-dim">
            <SquareTerminal className="size-6 text-faint" />
            {available ? (
              <>
                <span>No terminals open.</span>
                <div className="flex gap-2"><Button variant="primary" size="sm" onClick={() => add('shmakk')}>Open shmakk</Button><Button size="sm" onClick={() => add('shell')}>Open shell</Button></div>
              </>
            ) : <span className="max-w-md text-[13px]">The terminal needs the native <code className="font-mono">node-pty</code> module, which failed to load{reason ? `: ${reason}` : ''}. Reinstall shmakk’s dependencies to enable it.</span>}
          </div>
        ) : null}
      </div>
      {/* Keys a phone keyboard doesn't have. */}
      {mobile && tabs.length ? (
        <div className={cn('no-scrollbar flex shrink-0 gap-1.5 overflow-x-auto border-t border-line bg-panel px-2 py-1.5', keyboardOpen && 'pb-1.5')} role="toolbar" aria-label="Terminal keys">
          {KEYS.map((k) => (
            <button key={k.label} type="button" onPointerDown={(e) => e.preventDefault()} onClick={() => sendKey(k.data)}
              className="h-9 min-w-10 shrink-0 rounded-lg border border-line bg-raised px-2.5 font-mono text-[13px] text-dim active:bg-accent/15 active:text-accent">
              {k.label}
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, Monitor, MousePointerClick, RotateCw, Smartphone, Tablet, WifiOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useApp } from '@/store/app';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tip } from '@/components/ui/tooltip';

type Device = 'desktop' | 'tablet' | 'phone';
const WIDTH: Record<Device, number | null> = { desktop: null, tablet: 820, phone: 390 };
const PORTS = ['5173', '3000', '8080'];
const DEFAULT_URL = 'http://localhost:5173';

const normalise = (raw: string) => {
  const v = raw.trim();
  if (!v) return '';
  if (/^[a-z]+:\/\//i.test(v)) return v;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(v)) return `http://${v}`;
  return `https://${v}`;
};

/**
 * Chromium preview surface: any URL the workspace serves (a dev server, a design
 * preview, a docs page) rendered inside the app, sized like the device you are
 * targeting. The same page is what the agent drives with its browser tools.
 */
export function BrowserPane() {
  const browserTools = useApp((s) => s.features.browser);
  const setDraft = useApp((s) => s.setDraft);
  const [text, setText] = useState(() => localStorage.getItem('shmakk.browser.url') || DEFAULT_URL);
  const [url, setUrl] = useState(() => normalise(localStorage.getItem('shmakk.browser.url') || DEFAULT_URL));
  const [nonce, setNonce] = useState(0);
  const [device, setDevice] = useState<Device>('desktop');
  const [reach, setReach] = useState<'unknown' | 'ok' | 'down'>('unknown');

  // A no-cors probe is the only cross-origin reachability signal a browser gives
  // us: a refused connection rejects, anything that answers resolves.
  useEffect(() => {
    if (!url) return;
    const ctrl = new AbortController();
    setReach('unknown');
    fetch(url, { mode: 'no-cors', cache: 'no-store', signal: ctrl.signal }).then(() => setReach('ok')).catch(() => setReach('down'));
    return () => ctrl.abort();
  }, [url, nonce]);

  const go = (raw: string) => {
    const next = normalise(raw);
    setText(next || raw);
    if (!next) return;
    localStorage.setItem('shmakk.browser.url', next);
    setUrl(next);
    setNonce((n) => n + 1);
  };

  const size = useMemo(() => WIDTH[device], [device]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-sunken">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-line bg-panel px-2 py-1.5">
        <form className="flex min-w-0 flex-1 items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); go(text); }}>
          <Input value={text} onChange={(e) => setText(e.target.value)} onFocus={(e) => e.target.select()} aria-label="Preview URL" placeholder="http://localhost:5173" spellCheck={false} className="h-8 min-w-0 flex-1 font-mono text-[12.5px]" />
          <Button type="submit" size="icon-sm" aria-label="Open address" title="Open"><ArrowUpRight /></Button>
        </form>
        <Tip label="Reload"><Button variant="ghost" size="icon-sm" aria-label="Reload preview" onClick={() => setNonce((n) => n + 1)}><RotateCw /></Button></Tip>
        <Tip label="Open in a real tab"><Button variant="ghost" size="icon-sm" aria-label="Open in a new tab" onClick={() => url && window.open(url, '_blank', 'noopener')}><ArrowUpRight /></Button></Tip>
      </div>

      <div className="flex shrink-0 items-center gap-1.5 border-b border-line px-2.5 py-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto no-scrollbar">
          {PORTS.map((p) => {
            const target = `http://localhost:${p}`;
            return (
              <button key={p} type="button" onClick={() => go(target)}
                className={cn('shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[11px] text-faint hover:bg-hover hover:text-fg', url === target && 'bg-raised text-fg')}>
                :{p}
              </button>
            );
          })}
        </div>
        <div className="flex shrink-0 rounded-lg border border-line p-0.5" role="radiogroup" aria-label="Preview size">
          {([['desktop', <Monitor key="d" />], ['tablet', <Tablet key="t" />], ['phone', <Smartphone key="p" />]] as [Device, React.ReactNode][]).map(([d, icon]) => (
            <Tip key={d} label={d}><button type="button" role="radio" aria-checked={device === d} aria-label={d} onClick={() => setDevice(d)} className={cn('grid size-6 place-items-center rounded-md text-faint hover:text-fg [&_svg]:size-3.5', device === d && 'bg-raised text-fg')}>{icon}</button></Tip>
          ))}
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-auto">
        {url ? (
          <div className={cn('mx-auto h-full bg-white transition-[width] duration-200', size ? 'py-3' : null)} style={size ? { width: size, maxWidth: '100%' } : undefined}>
            <iframe
              key={`${url}#${nonce}`}
              src={url}
              title="Browser preview"
              className="size-full border-0 bg-white"
              referrerPolicy="no-referrer"
              allow="clipboard-read; clipboard-write; fullscreen"
            />
          </div>
        ) : (
          <p className="m-0 p-6 text-center text-[13px] text-dim">Type the address of a dev server or a preview page above.</p>
        )}
        {reach === 'down' ? (
          <div className="absolute inset-x-3 top-3 rounded-xl border border-warn/40 bg-panel/95 p-3 text-[13px] shadow-pop backdrop-blur">
            <div className="flex items-center gap-2 font-medium text-warn"><WifiOff className="size-4" />Nothing answered at {url}</div>
            <p className="m-0 mt-1 text-dim">Start your dev server, or point this pane at the port it prints. Reload once it is up.</p>
            <div className="mt-2 flex gap-2"><Button size="sm" onClick={() => setNonce((n) => n + 1)}><RotateCw />Try again</Button></div>
          </div>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-line bg-panel px-2.5 py-1.5 text-[11.5px] text-faint">
        <span className="min-w-0 flex-1 truncate">
          {browserTools ? 'Chromium — the agent can drive this page with its browser tools.' : 'Chromium preview. Browser automation is unavailable (Playwright not found).'}
        </span>
        <Tip label="Hand this page to the agent"><Button variant="ghost" size="icon-sm" aria-label="Ask the agent to inspect this page" onClick={() => setDraft(`Open ${url} with the browser tools and `)}><MousePointerClick /></Button></Tip>
      </div>
    </div>
  );
}

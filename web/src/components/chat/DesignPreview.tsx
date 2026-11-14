import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Code2, Copy, ExternalLink, History, Monitor, Palette, RotateCcw, Smartphone, Tablet } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { cn, copyText, relTime } from '@/lib/utils';
import { useApp } from '@/store/app';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/misc';
import { Tip } from '@/components/ui/tooltip';
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

interface DesignData {
  base: string; dir: string;
  files: { path: string; size: number; previewable: boolean }[];
  versions: { n: number; at: number; note: string; files: string[] }[];
}
type Device = 'desktop' | 'tablet' | 'phone';
const WIDTH: Record<Device, number | null> = { desktop: null, tablet: 820, phone: 390 };

/** Live preview of a design conversation's files, with versions and device sizes. */
export function DesignPreview({ convId, running }: { convId: string | null; running: boolean }) {
  const qc = useQueryClient();
  const tick = useApp((s) => (convId ? s.designTick[convId] || 0 : 0));
  const { data } = useQuery({ queryKey: ['design', convId, tick], queryFn: () => api.get<DesignData>(`/api/design/${convId}`), enabled: !!convId, placeholderData: (prev) => prev });
  const [file, setFile] = useState<string | null>(null);
  const [version, setVersion] = useState<number | null>(null); // null = working copy
  const [device, setDevice] = useState<Device>('desktop');
  const [showCode, setShowCode] = useState(false);

  useEffect(() => { setFile(null); setVersion(null); setShowCode(false); }, [convId]);
  const pages = useMemo(() => {
    if (!data) return [];
    if (version === null) return data.files.filter((f) => f.previewable).map((f) => f.path);
    return (data.versions.find((v) => v.n === version)?.files || []).filter((p) => /\.(html?|svg)$/i.test(p));
  }, [data, version]);
  const current = file && pages.includes(file) ? file : pages[0] ?? null;
  const src = data && current ? `${data.base}${version === null ? '' : `.versions/${version}/`}${current}?v=${tick}` : null;

  const code = useQuery({
    queryKey: ['design-file', convId, current, version, tick],
    queryFn: () => api.get<{ content: string }>(`/api/design/${convId}/file?path=${encodeURIComponent(`${version === null ? '' : `.versions/${version}/`}${current}`)}`),
    enabled: !!convId && !!current && showCode,
  });
  const restore = useMutation({
    mutationFn: () => api.post(`/api/design/${convId}/restore`, { version }),
    onSuccess: () => { toast.success(`Restored version ${version}`); setVersion(null); void qc.invalidateQueries({ queryKey: ['design', convId] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!convId || !data || pages.length === 0) {
    return (
      <div className="grid h-full place-content-center justify-items-center gap-3 bg-sunken p-8 text-center text-dim">
        {running ? <Spinner className="size-6" /> : <Palette className="size-8 text-violet" />}
        <strong className="font-semibold text-fg">{running ? 'Designing…' : 'Your design appears here'}</strong>
        <p className="m-0 max-w-xs text-[13.5px]">{running ? 'The first screen will show up as soon as it is written.' : 'Describe a screen, a page or a whole flow. shmakk builds it as real HTML you can click through.'}</p>
      </div>
    );
  }

  const latest = data.versions[data.versions.length - 1];
  return (
    <div className="flex h-full min-h-0 flex-col bg-sunken">
      <div className="flex min-h-11 shrink-0 items-center gap-1.5 border-b border-line bg-panel px-2.5 py-1.5">
        <div role="tablist" aria-label="Screens" className="no-scrollbar flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {pages.map((p) => (
            <button key={p} type="button" role="tab" aria-selected={p === current} onClick={() => setFile(p)}
              className={cn('shrink-0 rounded-lg px-2.5 py-1 font-mono text-xs text-dim hover:text-fg touch:py-2', p === current && 'bg-raised text-fg ring-1 ring-line')}>
              {p.replace(/\.html?$/i, '')}
            </button>
          ))}
        </div>
        {running ? <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[11px] text-violet"><Spinner className="size-3 text-violet" />updating</span> : null}

        <div className="flex shrink-0 rounded-lg border border-line p-0.5 max-md:hidden" role="radiogroup" aria-label="Preview size">
          {([['desktop', <Monitor key="d" />], ['tablet', <Tablet key="t" />], ['phone', <Smartphone key="p" />]] as [Device, React.ReactNode][]).map(([d, icon]) => (
            <button key={d} type="button" role="radio" aria-checked={device === d} aria-label={d} onClick={() => setDevice(d)} className={cn('grid size-6 place-items-center rounded-md text-faint hover:text-fg [&_svg]:size-3.5', device === d && 'bg-raised text-fg')}>{icon}</button>
          ))}
        </div>

        <DropdownMenu>
          <Tip label="Version history"><DropdownMenuTrigger asChild><Button variant="ghost" size="sm" className="font-mono"><History />{version === null ? `v${latest ? latest.n : 1}` : `v${version}`}</Button></DropdownMenuTrigger></Tip>
          <DropdownMenuContent align="end" className="max-h-80 w-72 overflow-y-auto">
            <DropdownMenuLabel>Versions</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={version === null ? 'latest' : String(version)} onValueChange={(v) => setVersion(v === 'latest' ? null : Number(v))}>
              <DropdownMenuRadioItem value="latest">Current</DropdownMenuRadioItem>
              {[...data.versions].reverse().map((v) => (
                <DropdownMenuRadioItem key={v.n} value={String(v.n)}>
                  <span className="grid min-w-0"><span>v{v.n} <span className="text-faint">· {relTime(v.at)}</span></span><span className="truncate text-xs text-faint">{v.note || 'snapshot'}</span></span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <Tip label={showCode ? 'Show preview' : 'Show code'}><Button variant="ghost" size="icon-sm" aria-label="Toggle code" aria-pressed={showCode} onClick={() => setShowCode((v) => !v)} className={showCode ? 'bg-accent/10 text-accent' : undefined}><Code2 /></Button></Tip>
        <Tip label="Open in a new tab"><Button variant="ghost" size="icon-sm" aria-label="Open in a new tab" onClick={() => src && window.open(src, '_blank', 'noopener')}><ExternalLink /></Button></Tip>
      </div>

      {version !== null ? (
        <div className="flex shrink-0 items-center gap-3 border-b border-warn/30 bg-warn/10 px-3 py-1.5 text-[13px] text-warn">
          <span className="min-w-0 flex-1 truncate">Viewing version {version} — not the current design.</span>
          <Button size="sm" disabled={running || restore.isPending} onClick={() => restore.mutate()}><RotateCcw />Restore this version</Button>
          <Button size="sm" variant="ghost" onClick={() => setVersion(null)}>Back to current</Button>
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1 overflow-auto">
        {showCode ? (
          <div className="relative h-full">
            <Button size="sm" className="absolute right-3 top-3 z-10" onClick={async () => { if (code.data && await copyText(code.data.content)) toast('Copied'); }}><Copy />Copy</Button>
            <pre className="m-0 h-full overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-[12.5px] leading-relaxed text-dim">{code.data?.content ?? 'Loading…'}</pre>
          </div>
        ) : (
          <div className={cn('mx-auto h-full transition-[width] duration-200', WIDTH[device] && 'py-4')} style={{ width: WIDTH[device] ? `min(${WIDTH[device]}px, 100%)` : '100%' }}>
            {/* Opaque-origin sandbox: the design can run scripts but cannot reach the app. */}
            <iframe key={`${src}`} title={`Preview of ${current}`} src={src ?? undefined} sandbox="allow-scripts allow-forms allow-modals allow-popups"
              className={cn('size-full border-0 bg-white', WIDTH[device] && 'rounded-xl shadow-pop ring-1 ring-line')} />
          </div>
        )}
      </div>
    </div>
  );
}

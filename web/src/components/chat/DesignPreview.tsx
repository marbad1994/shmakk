import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Code2, Copy, ExternalLink, FileCode, History, Minus, Monitor, MousePointerClick, Palette, Plus, RotateCcw, Save, Smartphone, Tablet } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { cn, copyText, relTime } from '@/lib/utils';
import { useApp } from '@/store/app';
import { useHeaderSlot } from '@/components/layout/header-slot';
import { Button } from '@/components/ui/button';
import { CodeView, langFromPath } from '@/components/ui/code-view';
import { Spinner } from '@/components/ui/misc';
import { Tip } from '@/components/ui/tooltip';
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ElementEditor, type Selection, type SelectedDetail } from './ElementEditor';

interface DesignData {
  base: string; dir: string;
  files: { path: string; size: number; previewable: boolean }[];
  versions: { n: number; at: number; note: string; files: string[] }[];
}
type Device = 'desktop' | 'tablet' | 'phone';
const WIDTH: Record<Device, number | null> = { desktop: null, tablet: 820, phone: 390 };

// Zoom is per session: 100% is the fit-to-pane view, and the values in between
// match what a browser's zoom menu offers.
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.1;
const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));

// Previewed file, shown in the toolbar without its extension.
const fileLabel = (p: string) => (p.split('/').pop() || p).replace(/\.(html?|svg)$/i, '');

/**
 * The vault is browsed by title, so a saved screen is named after what it is
 * (the conversation brief, plus the screen when there is more than one) rather
 * than `index.html`.
 */
function artefactTitle(convTitle: string | undefined, file: string, screens: number, version: number | null) {
  const screen = file.replace(/^.*\//, '').replace(/\.(html?|svg)$/i, '');
  const brief = (convTitle || '').replace(/\s+/g, ' ').trim().slice(0, 72).replace(/\s+\S*$/, '');
  const label = screens > 1 && screen && screen !== 'index' ? screen.replace(/[-_]+/g, ' ') : '';
  const base = [brief, label].filter(Boolean).join(' · ') || screen || 'Design';
  return version === null ? base : `${base} · v${version}`;
}

/** Live preview of a design conversation's files, with versions and device sizes. */
export function DesignPreview({ convId, running }: { convId: string | null; running: boolean }) {
  const qc = useQueryClient();
  const tick = useApp((s) => (convId ? s.designTick[convId] || 0 : 0));
  const { data } = useQuery({ queryKey: ['design', convId, tick], queryFn: () => api.get<DesignData>(`/api/design/${convId}`), enabled: !!convId, placeholderData: (prev) => prev });
  const [file, setFile] = useState<string | null>(null);
  const [version, setVersion] = useState<number | null>(null); // null = working copy
  const [device, setDevice] = useState<Device>('desktop');
  const [showCode, setShowCode] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [editMode, setEditMode] = useState(false);
  const [saved, setSaved] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const convTitle = useApp((s) => s.convs.find((c) => c.id === convId)?.title);
  const slot = useHeaderSlot();

  useEffect(() => { setFile(null); setVersion(null); setShowCode(false); setEditMode(false); setSelection(null); }, [convId]);
  const pages = useMemo(() => {
    if (!data) return [];
    if (version === null) return data.files.filter((f) => f.previewable).map((f) => f.path);
    return (data.versions.find((v) => v.n === version)?.files || []).filter((p) => /\.(html?|svg)$/i.test(p));
  }, [data, version]);
  const current = file && pages.includes(file) ? file : pages[0] ?? null;
  const src = data && current ? `${data.base}${version === null ? '' : `.versions/${version}/`}${current}?v=${tick}` : null;
  const frameSrc = src && editMode ? `${src}&inspect=1` : src;

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
  const saveFile = useMutation({
    mutationFn: ({ path, content }: { path: string; content: string }) => api.put(`/api/design/${convId}/file`, { path, content }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['design-file', convId] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  const saveArtefact = useMutation({
    mutationFn: () => api.post('/api/artefacts', {
      path: `${data?.dir || ''}/${version === null ? '' : `.versions/${version}/`}${current}`,
      name: artefactTitle(convTitle, current || '', pages.length, version),
      convId,
      mode: 'design',
      note: `${current}${version === null ? ' · saved from the canvas' : ` · version ${version}`}`,
    }),
    onSuccess: () => {
      toast.success('Saved to Artefacts');
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1800);
      void qc.invalidateQueries({ queryKey: ['artefacts'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const postFrame = useCallback((msg: Record<string, unknown>) => {
    frameRef.current?.contentWindow?.postMessage({ source: 'shmakk-inspector', ...msg }, '*');
  }, []);

  // Refs so the message listener (bound once) always sees the latest values.
  const currentRef = useRef(current);
  currentRef.current = current;
  const saveRef = useRef(saveFile.mutate);
  saveRef.current = saveFile.mutate;

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const frame = frameRef.current;
      if (!frame || e.source !== frame.contentWindow) return;
      const d = e.data as { source?: string; type?: string; id?: string; detail?: SelectedDetail; html?: string };
      if (!d || d.source !== 'shmakk-inspector') return;
      if (d.type === 'selected' && d.id) {
        setSelection({ id: d.id, detail: d.detail ?? { tag: '', selector: '', text: '', hasChildren: false, styles: {}, computed: {} } });
      } else if (d.type === 'cleared') {
        setSelection(null);
      } else if (d.type === 'updated' && typeof d.html === 'string') {
        const p = currentRef.current;
        if (p) saveRef.current({ path: p, content: d.html });
      } else if (d.type === 'removed') {
        setSelection(null);
        if (typeof d.html === 'string') { const p = currentRef.current; if (p) saveRef.current({ path: p, content: d.html }); }
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // A reload (design.changed tick, file switch, or edit toggle) invalidates any
  // selected element, so drop the selection.
  useEffect(() => { setSelection(null); }, [current, tick]);
  useEffect(() => { setSaved(false); }, [convId, current, version]);

  // Ctrl/Cmd + wheel zooms the canvas. React attaches wheel handlers passively,
  // so the listener has to go on the element directly to stop the page scroll.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoom((z) => clampZoom(z + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const clearSelection = useCallback(() => {
    setSelection(null);
    postFrame({ type: 'clear' });
  }, [postFrame]);

  const toggleEdit = useCallback(() => {
    const next = !editMode;
    setEditMode(next);
    setSelection(null);
    if (!next) {
      postFrame({ type: 'disable' });
      if (convId) void api.post(`/api/design/${convId}/snapshot`).catch(() => {});
    }
  }, [editMode, convId, postFrame]);

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
  // On desktop these controls sit in the app header (the design layout supplies
  // the slot); phones keep them on a bar above the preview.
  const tools = (
    <div className="flex min-w-0 items-center gap-1.5">
      {/* One dropdown instead of a strip of file tabs, so the bar stays calm
          however many screens the design grows to. */}
      <DropdownMenu>
        <Tip label={pages.length > 1 ? `Preview file · ${pages.length} available` : 'Previewed file'}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" aria-label="Choose file to preview" className={cn('min-w-0 gap-1.5 px-2', slot && 'max-w-56')}>
              <FileCode />
              <span className="truncate font-mono text-xs text-fg">{fileLabel(current || '')}</span>
              {pages.length > 1 ? <span className="shrink-0 rounded bg-raised px-1 text-[10px] leading-4 tabular-nums text-faint ring-1 ring-line">{pages.length}</span> : null}
              <ChevronDown className="shrink-0 text-faint" />
            </Button>
          </DropdownMenuTrigger>
        </Tip>
        <DropdownMenuContent align="start" className="max-h-80 w-72 overflow-y-auto">
          <DropdownMenuLabel>{pages.length > 1 ? `${pages.length} files` : 'File'}</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={current ?? ''} onValueChange={setFile}>
            {pages.map((p) => (
              <DropdownMenuRadioItem key={p} value={p} className="font-mono text-[13px]">
                <span className="truncate">{fileLabel(p)}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="min-w-0 flex-1" />
      {running ? <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[11px] text-violet"><Spinner className="size-3 text-violet" />updating</span> : null}

      <div className="flex shrink-0 rounded-lg border border-line p-0.5 max-md:hidden" role="radiogroup" aria-label="Preview size">
        {([['desktop', <Monitor key="d" />], ['tablet', <Tablet key="t" />], ['phone', <Smartphone key="p" />]] as [Device, React.ReactNode][]).map(([d, icon]) => (
          <button key={d} type="button" role="radio" aria-checked={device === d} aria-label={d} onClick={() => setDevice(d)} className={cn('grid size-6 place-items-center rounded-md text-faint hover:text-fg [&_svg]:size-3.5', device === d && 'bg-raised text-fg')}>{icon}</button>
        ))}
      </div>

      {showCode ? null : (
        <div className="flex shrink-0 items-center rounded-lg border border-line p-0.5" role="group" aria-label="Zoom">
          <button type="button" aria-label="Zoom out" onClick={() => setZoom((z) => clampZoom(z - ZOOM_STEP))} disabled={zoom <= ZOOM_MIN} className="grid size-6 place-items-center rounded-md text-faint hover:text-fg disabled:opacity-40 [&_svg]:size-3.5"><Minus /></button>
          <button type="button" aria-label="Reset zoom to 100%" onClick={() => setZoom(1)} className="min-w-10 px-1 text-center font-mono text-[11px] tabular-nums text-dim hover:text-fg">{Math.round(zoom * 100)}%</button>
          <button type="button" aria-label="Zoom in" onClick={() => setZoom((z) => clampZoom(z + ZOOM_STEP))} disabled={zoom >= ZOOM_MAX} className="grid size-6 place-items-center rounded-md text-faint hover:text-fg disabled:opacity-40 [&_svg]:size-3.5"><Plus /></button>
        </div>
      )}

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
      <Tip label={version !== null ? 'Edit the current design only' : editMode ? 'Done editing' : 'Edit on canvas'}><Button variant="ghost" size="icon-sm" aria-label="Edit on canvas" aria-pressed={editMode} disabled={version !== null} onClick={toggleEdit} className={editMode ? 'bg-accent/10 text-accent' : undefined}><MousePointerClick /></Button></Tip>
      <Tip label={showCode ? 'Show preview' : 'Show code'}><Button variant="ghost" size="icon-sm" aria-label="Toggle code" aria-pressed={showCode} onClick={() => setShowCode((v) => !v)} className={showCode ? 'bg-accent/10 text-accent' : undefined}><Code2 /></Button></Tip>
      <Tip label={saved ? 'Saved to Artefacts' : 'Save this file as an artefact'}>
        <Button variant="ghost" size="icon-sm" aria-label="Save as artefact" disabled={!current || !data || saveArtefact.isPending} onClick={() => saveArtefact.mutate()} className={saved ? 'text-accent' : undefined}>
          {saved ? <Check /> : <Save />}
        </Button>
      </Tip>
      <Tip label="Open in a new tab"><Button variant="ghost" size="icon-sm" aria-label="Open in a new tab" onClick={() => src && window.open(src, '_blank', 'noopener')}><ExternalLink /></Button></Tip>
    </div>
  );

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-sunken">
      {slot ? createPortal(tools, slot) : (
        <div className="flex min-h-11 shrink-0 items-center gap-1.5 border-b border-line bg-panel px-2.5 py-1.5">{tools}</div>
      )}

      {version !== null ? (
        <div className="flex shrink-0 items-center gap-3 border-b border-warn/30 bg-warn/10 px-3 py-1.5 text-[13px] text-warn">
          <span className="min-w-0 flex-1 truncate">Viewing version {version}, not the current design.</span>
          <Button size="sm" disabled={running || restore.isPending} onClick={() => restore.mutate()}><RotateCcw />Restore this version</Button>
          <Button size="sm" variant="ghost" onClick={() => setVersion(null)}>Back to current</Button>
        </div>
      ) : null}

      <div ref={canvasRef} className="relative min-h-0 flex-1 overflow-auto">
        {showCode ? (
          <div className="relative h-full">
            <Button size="sm" className="absolute right-3 top-3 z-10" onClick={async () => { if (code.data && await copyText(code.data.content)) toast('Copied'); }}><Copy />Copy</Button>
            {code.data ? (
              <CodeView code={code.data.content} lang={langFromPath(current)} className="h-full p-4" />
            ) : (
              <p className="m-0 p-4 text-[13px] text-faint">Loading…</p>
            )}
          </div>
        ) : (
          <div className={cn('mx-auto h-full transition-[width] duration-200', WIDTH[device] && 'py-4')} style={{ width: WIDTH[device] ? `min(${WIDTH[device]}px, 100%)` : '100%' }}>
            {/* Opaque-origin sandbox: the design can run scripts but cannot reach the app. */}
            <iframe ref={frameRef} key={frameSrc ?? ''} title={`Preview of ${current}`} src={frameSrc ?? undefined} sandbox="allow-scripts allow-forms allow-modals allow-popups"
              onLoad={() => { if (editMode) postFrame({ type: 'enable' }); }}
              style={zoom === 1 ? undefined : { zoom }}
              className={cn('size-full border-0 bg-white', WIDTH[device] && 'rounded-xl shadow-pop ring-1 ring-line')} />
          </div>
        )}
      </div>

      {/* Overlay lives outside the scrolling canvas so the editor does not drift
          when the zoomed preview scrolls. */}
      {editMode && !showCode ? (
        selection ? (
          <div className="pointer-events-none absolute inset-0 z-20">
            <ElementEditor convId={convId} file={current} selection={selection} running={running} postFrame={postFrame} onClear={clearSelection} />
          </div>
        ) : (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-3 pb-3">
            <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-line bg-panel/95 py-1 pl-3 pr-1 shadow-pop backdrop-blur">
              <span className="text-[12.5px] text-dim">Click an element to edit it</span>
              <Button size="sm" variant="ghost" className="h-7" onClick={() => setEditMode(false)}>Done</Button>
            </div>
          </div>
        )
      ) : null}
    </div>
  );
}

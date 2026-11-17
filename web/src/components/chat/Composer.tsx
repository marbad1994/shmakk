import type { ClipboardEvent } from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, ChevronDown, Cpu, FileText, Gauge, Mic, Paperclip, Square, Volume2, VolumeX, X } from 'lucide-react';
import { COMMANDS, filterCommands, matchSlash, type Command } from '@/lib/commands';
import { bytes, cn } from '@/lib/utils';
import { browserStorage, draftScope, enterDraft, loadDrafts, saveDrafts } from '@/lib/composerDraft';
import { modeInfo } from '@/lib/modes';
import type { EffortLevel, Mode } from '@/lib/types';
import { useApp } from '@/store/app';
import type { MicState } from '@/hooks/useVoice';
import { haptic, isTouch } from '@/hooks/useMobile';
import { Button } from '@/components/ui/button';
import { Segmented, Spinner } from '@/components/ui/misc';
import { Tip } from '@/components/ui/tooltip';
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

interface Props {
  mode: Mode;
  running: boolean;
  activity: string | null;
  mic: MicState;
  speaking: boolean;
  onMic(): void;
  onStopSpeaking(): void;
}

/** A file staged in the composer. `url` is a blob URL used only for image thumbnails,
 *  `data` is the downscaled base64 image the model actually sees. */
type PendingFile = { name: string; size: number; content: string; url?: string; mimeType?: string; data?: string };
type ParkedDraft = { text: string; mode: 'ask' | 'shell'; files: PendingFile[] };

// Prompts parked under the conversation or empty space they were typed in.
// Module scope on purpose: the composer is remounted when design mode swaps
// the chat layout, and the parked prompts must outlive that. Seeded from
// localStorage so a reload does not throw away something you were mid-way
// through writing.
const parked = new Map<string, ParkedDraft>(
  [...loadDrafts(browserStorage())].map(([scope, d]) => [scope, { text: d.text, mode: d.mode, files: [] }] as const),
);

const MAX_IMAGE_EDGE = 1568;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
// Raw (undecoded) image bytes only travel when the socket and the server can
// still do something with them: the websocket caps messages at 4 MB.
const MAX_RAW_IMAGE_BYTES = 2 * 1024 * 1024;
const NATIVE_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

// Every format we recognise. Providers only take png/jpeg/gif/webp, so the rest
// are rasterised here or converted by the server after upload.
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', apng: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg', jfif: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', dib: 'image/bmp', svg: 'image/svg+xml', svgz: 'image/svg+xml',
  tif: 'image/tiff', tiff: 'image/tiff', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif',
  ico: 'image/x-icon', cur: 'image/x-icon',
};

function extOfFile(name: string) {
  return name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';
}

function imageMimeOf(f: File) {
  const type = (f.type || '').toLowerCase().split(';')[0].trim();
  if (type.startsWith('image/')) return type === 'image/jpg' ? 'image/jpeg' : type;
  return IMAGE_MIME_BY_EXT[extOfFile(f.name)] || null;
}

const isImageFile = (f: File) => !!imageMimeOf(f);

/** Extension for a pasted file, which often arrives without a usable name. */
function pasteExt(f: File) {
  const ext = extOfFile(f.name);
  if (ext) return ext;
  const sub = (f.type || '').split('/')[1]?.split(/[;+]/)[0];
  return sub === 'jpeg' ? 'jpg' : sub || 'bin';
}

const GENERIC_PASTE_NAMES = /^(image|blob|file|clipboard)(\.(png|jpe?g|gif|webp|bmp))?$/i;

/** Files carried by a paste (Ctrl/Cmd+V). Screenshots and copies from a file
 *  manager show up here; plain text returns an empty list so the browser can
 *  insert it as usual. */
function clipboardFiles(dt: DataTransfer | null, at = new Date()): File[] {
  if (!dt) return [];
  const out: File[] = [];
  for (const item of Array.from(dt.items || [])) {
    if (item.kind !== 'file') continue;
    const f = item.getAsFile();
    if (f) out.push(f);
  }
  if (!out.length && dt.files?.length) out.push(...Array.from(dt.files));
  if (!out.length) return out;
  const stamp = at.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return out.map((f, i) => {
    if (f.name && !GENERIC_PASTE_NAMES.test(f.name)) return f;
    const suffix = out.length > 1 ? `-${i + 1}` : '';
    return new File([f], `paste-${stamp}${suffix}.${pasteExt(f)}`, { type: f.type });
  });
}

function drawToJpeg(width: number, height: number, draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void): string | null {
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  draw(ctx, w, h);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
  return dataUrl.slice(dataUrl.indexOf(',') + 1) || null;
}

async function readRaw(f: File, mimeType: string) {
  try {
    const buf = new Uint8Array(await f.arrayBuffer());
    let binary = '';
    for (let i = 0; i < buf.length; i += 0x8000) binary += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { mimeType, data: btoa(binary) };
  } catch { return null; }
}

/** Downscale an image so it fits vision input sizes and the websocket payload
 *  limit, or hand back the original bytes when a converter can read them. */
async function prepareImage(f: File): Promise<{ mimeType: string; data: string } | null> {
  const declared = imageMimeOf(f);
  // Already a provider format and small enough: send it untouched so animation
  // and transparency survive and nothing is recompressed.
  if (declared && NATIVE_IMAGE_MIMES.has(declared) && f.size <= MAX_RAW_IMAGE_BYTES) {
    const raw = await readRaw(f, declared);
    if (raw) return raw;
  }
  try {
    const bitmap = await createImageBitmap(f);
    const data = drawToJpeg(bitmap.width, bitmap.height, (ctx, w, h) => ctx.drawImage(bitmap, 0, 0, w, h));
    bitmap.close();
    if (data) return { mimeType: 'image/jpeg', data };
  } catch {}
  // createImageBitmap skips SVG and several exotic formats: rasterise via <img>.
  try {
    const url = URL.createObjectURL(f);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const data = drawToJpeg(img.naturalWidth || 1024, img.naturalHeight || 1024, (ctx, w, h) => ctx.drawImage(img, 0, 0, w, h));
      if (data) return { mimeType: 'image/jpeg', data };
    } finally { URL.revokeObjectURL(url); }
  } catch {}
  // Nothing can decode it here (HEIC in Chrome, unusual TIFF): send the bytes
  // with the right mime and let the server convert them.
  if (declared && f.size <= MAX_RAW_IMAGE_BYTES) {
    const raw = await readRaw(f, declared);
    if (raw) return raw;
  }
  return null;
}

const HISTORY_KEY = 'shmakk.inputHistory';
const MAX_ATTACH_BYTES = 200 * 1024;
const MAX_ATTACH_CHARS = 60000;
const MAX_ATTACH_COUNT = 8;
function loadHistory(): string[] { try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; } }

export function Composer({ mode: space, running, activity, mic, speaking, onMic, onStopSpeaking }: Props) {
  // Shell input only makes sense where there is a workspace.
  const agentic = space === 'code' || space === 'cowork';
  const send = useApp((s) => s.send);
  const stop = useApp((s) => s.stop);
  const settings = useApp((s) => s.settings);
  const patchSettings = useApp((s) => s.patchSettings);
  const provider = useApp((s) => s.provider);
  const draft = useApp((s) => s.draft);
  const clearDraft = useApp((s) => s.clearDraft);
  const activeId = useApp((s) => s.activeId);

  // Active model + the reasoning_effort levels it actually accepts. Resolved
  // early so submit can clamp a stale settings value before the menus render.
  const DEFAULT_MODEL = '__default';
  const modelByMode = settings.modelByMode || ({} as Record<Mode, string | null>);
  const currentModel = modelByMode[space] || provider.model || 'default';
  const effortLevels: EffortLevel[] = useMemo(() => {
    const by = provider.effortByModel || {};
    if (currentModel && by[currentModel]) return by[currentModel];
    if (provider.model && by[provider.model]) return by[provider.model];
    return provider.effortLevels || [];
  }, [provider.effortByModel, provider.effortLevels, provider.model, currentModel]);
  const effortSupported = effortLevels.length > 0;
  const activeEffort: EffortLevel | null =
    settings.reasoningEffort && effortLevels.includes(settings.reasoningEffort)
      ? settings.reasoningEffort
      : null;

  const [text, setText] = useState('');
  const [files, setFiles] = useState<PendingFile[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  // Object URLs for image thumbnails, revoked when the attachment goes away.
  const blobUrls = useRef<Set<string>>(new Set());
  const makeBlobUrl = useCallback((f: File) => { const u = URL.createObjectURL(f); blobUrls.current.add(u); return u; }, []);
  const dropBlobUrl = useCallback((u?: string) => { if (u && blobUrls.current.delete(u)) URL.revokeObjectURL(u); }, []);
  const clearBlobUrls = useCallback(() => { blobUrls.current.forEach((u) => URL.revokeObjectURL(u)); blobUrls.current.clear(); }, []);
  useEffect(() => () => clearBlobUrls(), [clearBlobUrls]);
  const [mode, setMode] = useState<'ask' | 'shell'>('ask');
  const shell = agentic && mode === 'shell';
  useEffect(() => { if (!agentic && mode === 'shell') setMode('ask'); }, [agentic, mode]);
  const [sel, setSel] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const history = useRef<string[]>(loadHistory());
  const histIdx = useRef(-1);
  // The composer outlives a space or session switch, so its local text would
  // otherwise follow you into the next one. Park the prompt (and its staged
  // files) under the slot it was written in and restore whatever belongs to the
  // slot we just entered. Design mode swaps the whole chat layout for one with
  // a preview, which remounts this composer, so the parked prompts have to live
  // outside the component or they would be lost (or, worse, refilled from the
  // one-shot draft below).
  const scope = draftScope(space, activeId);
  const [scopeKey, setScopeKey] = useState<string | null>(null);
  if (scopeKey !== scope) {
    const next = enterDraft(parked, scopeKey, scope, { text, mode, files }, { text: '', mode: 'ask' as const, files: [] });
    setScopeKey(scope);
    setText(next.text);
    setMode(next.mode);
    setFiles(next.files);
    setMenuDismissed(false);
  }

  // Keep the parked map and localStorage in step with what is on screen, so a
  // reload or a remount lands back on the same prompt.
  useEffect(() => {
    parked.set(scope, { text, mode, files });
    const t = setTimeout(() => saveDrafts(browserStorage(), parked), 400);
    return () => clearTimeout(t);
  }, [scope, text, mode, files]);

  // Switching slots is the moment the outgoing draft has to be on disk: the
  // debounce above is cleared by the switch before it can fire.
  useEffect(() => { saveDrafts(browserStorage(), parked); }, [scope]);

  // Slash menu
  const slash = mode === 'ask' ? matchSlash(text) : null;
  const matches = useMemo(() => (slash ? filterCommands(slash.query) : []), [slash?.query]); // eslint-disable-line react-hooks/exhaustive-deps
  const menuOpen = !!slash && !menuDismissed && matches.length > 0;
  useEffect(() => { setSel(0); }, [slash?.query]);

  // Autosize
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`;
  }, [text, mode]);

  // Prefill from elsewhere in the app (suggestions, workflows…)
  useEffect(() => {
    if (!draft) return;
    setText(draft.text);
    setMode(draft.mode);
    ref.current?.focus();
    // One-shot: consume it so it can't be re-applied when the composer
    // remounts (e.g. switching into design mode swaps the chat layout).
    clearDraft();
  }, [draft, clearDraft]);
  // Don't pop the on-screen keyboard uninvited on phones.
  useEffect(() => { if (!isTouch()) ref.current?.focus(); }, [activeId]);

  const runCommand = useCallback((cmd: Command, arg: string) => {
    if (cmd.argRequired && !arg) { setText(`/${cmd.slash} `); setMenuDismissed(true); ref.current?.focus(); return; }
    setText('');
    setMenuDismissed(false);
    void cmd.run(arg);
  }, []);

  const submit = useCallback(() => {
    const value = text.trim();
    if ((!value && !files.length) || running) return;
    if (value && mode === 'ask') {
      const m = matchSlash(value);
      if (m) {
        const cmd = COMMANDS.find((c) => c.slash === m.query) || (matches.length === 1 ? matches[0] : undefined);
        if (cmd) return runCommand(cmd, m.arg);
      }
    }
    if (value) {
      history.current = [value, ...history.current.filter((h) => h !== value)].slice(0, 100);
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history.current)); } catch { /* private mode */ }
      histIdx.current = -1;
    }
    setText('');
    setFiles([]);
    clearBlobUrls();
    setMenuDismissed(false);
    haptic();
    void send(value, shell ? 'shell' : 'ask', files.map(({ name, size, content, mimeType, data }) => ({ name, size, content, mimeType, data })), activeEffort);
  }, [text, files, running, mode, shell, matches, runCommand, send, clearBlobUrls, activeEffort]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (menuOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel((i) => (i + 1) % matches.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSel((i) => (i - 1 + matches.length) % matches.length); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        const cmd = (slash?.arg ? COMMANDS.find((c) => c.slash === slash.query) : undefined) ?? matches[sel];
        if (e.key === 'Tab' || (cmd.argRequired && !slash?.arg)) { setText(`/${cmd.slash} `); if (!cmd.arg) setMenuDismissed(true); }
        else runCommand(cmd, slash?.arg || '');
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); setMenuDismissed(true); return; }
    }
    // Phones: Return makes a new line and the send button sends, as in any
    // native messenger. Shell mode still runs on Return — it's a prompt.
    if (e.key === 'Enter' && !e.shiftKey && (!isTouch() || mode === 'shell')) { e.preventDefault(); submit(); return; }
    if (e.key === 'Escape' && running) { e.preventDefault(); stop(); return; }
    // Shell-style history recall
    if (e.key === 'ArrowUp' && (text === '' || histIdx.current >= 0) && e.currentTarget.selectionStart === 0) {
      const next = Math.min(histIdx.current + 1, history.current.length - 1);
      if (next >= 0 && history.current[next] !== undefined) { e.preventDefault(); histIdx.current = next; setText(history.current[next]); }
    } else if (e.key === 'ArrowDown' && histIdx.current >= 0) {
      e.preventDefault();
      histIdx.current -= 1;
      setText(histIdx.current >= 0 ? history.current[histIdx.current] : '');
    }
  };

  const onChange = (value: string) => {
    setMenuDismissed(false);
    histIdx.current = -1;
    // Typing "$ " at the start flips to shell mode, like a prompt.
    if (agentic && mode === 'ask' && /^\$\s/.test(value)) { setMode('shell'); setText(value.replace(/^\$\s+/, '')); return; }
    setText(value);
  };

  // Attach files for reference: read text files into the message, keep others
  // as name/size only (the model gets a note that they're binary).
  const onFiles = useCallback(async (list: FileList | readonly File[] | null) => {
    if (!list || !list.length) return;
    const picked: PendingFile[] = [];
    for (const f of Array.from(list)) {
      if (picked.length >= MAX_ATTACH_COUNT) break;
      // Images get a real thumbnail and a base64 copy so the model can see them.
      if (isImageFile(f)) {
        if (f.size > MAX_IMAGE_BYTES) { picked.push({ name: f.name, size: f.size, content: '' }); continue; }
        const prepared = await prepareImage(f);
        picked.push({ name: f.name, size: f.size, content: '', url: makeBlobUrl(f), mimeType: prepared?.mimeType, data: prepared?.data });
        continue;
      }
      if (f.size > MAX_ATTACH_BYTES) { picked.push({ name: f.name, size: f.size, content: '' }); continue; }
      let content = '';
      try { content = await f.text(); } catch { content = ''; }
      const binary = content.includes('\u0000');
      picked.push({ name: f.name, size: f.size, content: binary ? '' : content.slice(0, MAX_ATTACH_CHARS) });
    }
    setFiles((prev) => {
      const all = [...prev, ...picked];
      for (const dropped of all.slice(MAX_ATTACH_COUNT)) dropBlobUrl(dropped.url);
      return all.slice(0, MAX_ATTACH_COUNT);
    });
  }, [makeBlobUrl, dropBlobUrl]);

  // Ctrl/Cmd+V carrying files (a screenshot, files copied in a file manager)
  // stages them exactly like the paperclip; plain text pastes normally.
  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    const pasted = clipboardFiles(e.clipboardData);
    if (!pasted.length) return;
    e.preventDefault();
    setMenuDismissed(true);
    void onFiles(pasted);
    ref.current?.focus();
  };

  // Per-space model picker. The list comes from the model registry in
  // ~/.config/shmakk/endpoints.json (env vars are only the fallback);
  // "default" clears the override.
  const setModel = (v: string) => patchSettings({ modelByMode: { ...modelByMode, [space]: v === DEFAULT_MODEL ? null : v } });

  const modelMenu = (
    <DropdownMenu>
      <Tip label={`Model for ${modeInfo(space).label.toLowerCase()}`} side="top">
        <DropdownMenuTrigger asChild>
          <button type="button" className="inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-0.5 font-mono text-xs text-dim touch:px-3 touch:py-1.5 touch:text-[13px] hover:border-line-strong hover:bg-hover hover:text-fg">
            <Cpu className="size-3.5" />{currentModel}<ChevronDown className="size-3" />
          </button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>Model · {modeInfo(space).label}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={modelByMode[space] || DEFAULT_MODEL} onValueChange={setModel}>
          <DropdownMenuRadioItem value={DEFAULT_MODEL}>default <span className="text-faint">· {provider.model || 'gpt-4o-mini'}</span></DropdownMenuRadioItem>
          {provider.models.map((m) => <DropdownMenuRadioItem key={m} value={m}>{m}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  // Reasoning effort — only for models that actually accept reasoning_effort.
  // Levels come from the provider (live /models catalog, name heuristics, or an
  // endpoints.json `effort` override). Empty list hides the control entirely.
  const DEFAULT_EFFORT = '__default';
  const effort = activeEffort || DEFAULT_EFFORT;
  const setEffort = (v: string) => patchSettings({ reasoningEffort: v === DEFAULT_EFFORT ? null : (v as EffortLevel) });

  // Drop a stale effort when the active model cannot take it (e.g. switched
  // from grok-4.7 to deepseek). Keeps settings honest without a manual reset.
  useEffect(() => {
    if (!settings.reasoningEffort) return;
    if (effortSupported && effortLevels.includes(settings.reasoningEffort)) return;
    patchSettings({ reasoningEffort: null });
  }, [settings.reasoningEffort, effortSupported, effortLevels, patchSettings]);

  const effortMenu = effortSupported ? (
    <DropdownMenu>
      <Tip label="Reasoning effort" side="top">
        <DropdownMenuTrigger asChild>
          <button type="button" className="inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-0.5 font-mono text-xs text-dim touch:px-3 touch:py-1.5 touch:text-[13px] hover:border-line-strong hover:bg-hover hover:text-fg">
            <Gauge className="size-3.5" />{effort === DEFAULT_EFFORT ? 'auto' : effort}<ChevronDown className="size-3" />
          </button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>Reasoning effort</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={effort} onValueChange={setEffort}>
          <DropdownMenuRadioItem value={DEFAULT_EFFORT}>auto <span className="text-faint">· provider default</span></DropdownMenuRadioItem>
          {effortLevels.map((e) => <DropdownMenuRadioItem key={e} value={e}>{e}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;

  return (
    <div className="relative shrink-0 px-5.5 pb-3 max-md:px-2 max-md:pb-2">
      <div className="relative mx-auto max-w-[780px]">
        <div className="flex h-7 items-center gap-2 pl-1.5 font-mono text-xs text-dim max-md:h-6" aria-live="polite">
          {running ? (
            <>
              <span className="inline-flex h-[11px] items-end gap-0.5" aria-hidden>
                {[0, 150, 300].map((d) => <i key={d} className="w-[3px] animate-bars rounded-[1px] bg-accent" style={{ animationDelay: `${d}ms` }} />)}
              </span>
              <span>{activity || 'working'}…</span>
            </>
          ) : mic === 'listening' ? <span className="text-danger">● listening — pause to finish</span>
            : mic === 'busy' ? <><Spinner className="size-3" /><span>transcribing…</span></>
            : null}
        </div>

        {menuOpen ? (
          <div role="listbox" aria-label="Commands" className="absolute inset-x-0 bottom-[calc(100%-22px)] z-20 max-h-80 overflow-y-auto rounded-2xl border border-line-strong bg-raised p-1.5 shadow-pop animate-pop">
            {matches.map((c, i) => (
              <button
                key={c.id}
                type="button"
                role="option"
                aria-selected={i === sel}
                ref={i === sel ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
                onMouseEnter={() => setSel(i)}
                onMouseDown={(e) => { e.preventDefault(); if (c.argRequired) { setText(`/${c.slash} `); ref.current?.focus(); } else runCommand(c, ''); }}
                className={cn('flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left touch:min-h-11', i === sel && 'bg-hover')}
              >
                <span className="text-dim [&_svg]:size-4">{c.icon}</span>
                <span className="shrink-0 font-mono text-[12.5px] font-semibold text-accent">/{c.slash}{c.arg ? <span className="font-normal text-faint"> {c.arg}</span> : null}</span>
                <span className="truncate text-[13px] text-dim">{c.hint}</span>
              </button>
            ))}
          </div>
        ) : null}

        <div onPaste={onPaste} className={cn('rounded-[22px] border border-line-strong bg-raised shadow-[0_8px_30px_rgb(0_0_0/0.18)] transition-[border-color,box-shadow] focus-within:border-accent/45 focus-within:ring-[3px] focus-within:ring-accent/10', shell && 'border-accent/40')}>
          <div className="flex items-start gap-1 px-4 pb-1 pt-3">
            <span className="w-4 shrink-0 select-none font-mono text-[15px] font-bold leading-[1.6] text-accent" aria-hidden>{shell ? '$' : '❯'}</span>
            <textarea
              id="composer-input"
              ref={ref}
              rows={1}
              value={text}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={shell ? 'Run a command…' : modeInfo(space).placeholder}
              enterKeyHint={shell ? 'go' : 'enter'}
              autoCapitalize={shell ? 'off' : 'sentences'}
              autoCorrect={shell ? 'off' : 'on'}
              aria-label={shell ? 'Shell command' : 'Message shmakk'}
              spellCheck={!shell}
              className={cn('max-h-[40vh] min-h-6 min-w-0 flex-1 resize-none bg-transparent leading-[1.6] outline-none placeholder:text-faint', shell && 'font-mono text-[13.5px] leading-[1.75]')}
            />
          </div>
          {files.length > 0 ? (
            <div className="flex flex-wrap gap-2 px-4 pb-2" aria-label="Attachments">
              {files.map((f, i) => (
                <div key={`${f.name}-${i}`} className="group relative size-28 shrink-0">
                  <div className="relative size-full overflow-hidden rounded-xl border border-line bg-panel transition-colors group-hover:border-line-strong" title={`${f.name} · ${bytes(f.size)}`}>
                    {f.url ? (
                      <img src={f.url} alt={f.name} className="size-full object-cover" draggable={false} />
                    ) : f.content ? (
                      <>
                        <pre className="m-0 size-full overflow-hidden whitespace-pre-wrap break-all p-2 font-mono text-[7px] leading-[1.45] text-faint">{f.content.slice(0, 420)}</pre>
                        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-9 bg-gradient-to-t from-panel to-transparent" />
                      </>
                    ) : (
                      <div className="grid size-full place-items-center text-faint">
                        <FileText className="size-6" strokeWidth={1.75} />
                      </div>
                    )}
                    <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/55 to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 px-2 pb-1.5 text-[10px] text-dim opacity-0 transition-opacity group-hover:opacity-100">
                      <span className="block truncate">{f.name}</span>
                    </div>
                    <button type="button" aria-label={`Remove ${f.name}`} onClick={() => { dropBlobUrl(files[i]?.url); setFiles((p) => p.filter((_, j) => j !== i)); }} className="absolute right-1 top-1 z-10 grid size-5 place-items-center rounded-full bg-raised/90 text-faint shadow-sm touch:size-11 opacity-0 transition-opacity hover:text-fg focus-visible:opacity-100 group-hover:opacity-100 touch:opacity-100">
                      <X className="size-3" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
          <div className="flex items-center gap-1.5 px-2.5 pb-2 pt-1">
            <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto [mask-image:linear-gradient(to_right,black_calc(100%-16px),transparent)] [&>*]:shrink-0">
            {agentic ? (
              <Segmented label="Input mode" value={mode} onChange={(m) => { setMode(m); ref.current?.focus(); }} options={[{ value: 'ask', label: 'ask' }, { value: 'shell', label: 'shell' }]} />
            ) : null}
            {modelMenu}
            {effortMenu}

            <span className="w-3" />
            </div>

            <Tip label="Attach files for reference" side="top">
              <Button variant="ghost" size="icon" aria-label="Attach files" onClick={() => fileRef.current?.click()}>
                <Paperclip />
              </Button>
            </Tip>
            <input ref={fileRef} type="file" multiple hidden accept="image/*,.heic,.heif,.avif,.tiff,.tif,.bmp,.ico,.cur,.jfif,.svg" onChange={(e) => { void onFiles(e.target.files); e.target.value = ''; }} />
            {speaking ? (
              <Tip label="Stop speaking" side="top"><Button variant="ghost" size="icon" aria-label="Stop speaking" onClick={onStopSpeaking}><VolumeX className="text-accent" /></Button></Tip>
            ) : (
              <Tip label={settings.ttsAuto ? 'Read replies aloud: on' : 'Read replies aloud: off'} side="top">
                <Button variant="ghost" size="icon" aria-pressed={settings.ttsAuto} aria-label="Read replies aloud" onClick={() => patchSettings({ ttsAuto: !settings.ttsAuto })}>
                  <Volume2 className={settings.ttsAuto ? 'text-accent' : undefined} />
                </Button>
              </Tip>
            )}
            <Tip label={mic === 'listening' ? 'Stop listening' : 'Speak'} side="top">
              <Button variant="ghost" size="icon" aria-label="Voice input" onClick={onMic} className={cn(mic === 'listening' && 'animate-pulse bg-danger/10 text-danger hover:bg-danger/15 hover:text-danger')}>
                {mic === 'busy' ? <Spinner /> : <Mic />}
              </Button>
            </Tip>
            {running ? (
              <Tip label="Stop (Esc)" side="top">
                <button type="button" aria-label="Stop" onClick={stop} className="grid size-[34px] shrink-0 place-items-center rounded-full bg-fg text-bg transition-transform hover:scale-105 touch:size-11"><Square className="size-3.5 fill-current" /></button>
              </Tip>
            ) : (
              <Tip label="Send (Enter)" side="top">
                <button type="button" aria-label="Send" disabled={!text.trim() && !files.length} onClick={submit} className="grid size-[34px] shrink-0 place-items-center rounded-full bg-accent text-accent-ink transition-transform enabled:hover:scale-105 disabled:opacity-35 touch:size-11"><ArrowUp className="size-[18px]" strokeWidth={2.4} /></button>
              </Tip>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

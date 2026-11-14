import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowUp, ChevronDown, Cpu, Mic, Paperclip, Square, Volume2, VolumeX, X } from 'lucide-react';
import { toast } from 'sonner';
import { COMMANDS, filterCommands, matchSlash, type Command } from '@/lib/commands';
import { cn, modKey } from '@/lib/utils';
import { api } from '@/lib/api';
import type { AttachedFile } from '@/lib/types';
import { useApp } from '@/store/app';
import type { MicState } from '@/hooks/useVoice';
import { haptic, isTouch } from '@/hooks/useMobile';
import { Button } from '@/components/ui/button';
import { Segmented, Spinner } from '@/components/ui/misc';
import { Tip } from '@/components/ui/tooltip';
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

interface Props {
  running: boolean;
  activity: string | null;
  mic: MicState;
  speaking: boolean;
  onMic(): void;
  onStopSpeaking(): void;
}

const HISTORY_KEY = 'shmakk.inputHistory';
function loadHistory(): string[] { try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; } }

export function Composer({ running, activity, mic, speaking, onMic, onStopSpeaking }: Props) {
  const send = useApp((s) => s.send);
  const stop = useApp((s) => s.stop);
  const settings = useApp((s) => s.settings);
  const patchSettings = useApp((s) => s.patchSettings);
  const provider = useApp((s) => s.provider);
  const draft = useApp((s) => s.draft);
  const activeId = useApp((s) => s.activeId);
  const conv = useApp((s) => s.convs.find((c) => c.id === s.activeId));
  const pendingMode = useApp((s) => s.pendingMode);

  const [text, setText] = useState('');
  const [mode, setMode] = useState<'ask' | 'shell'>('ask');
  const [sel, setSel] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [attachments, setAttachments] = useState<AttachedFile[]>([]);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const history = useRef<string[]>(loadHistory());
  const histIdx = useRef(-1);

  const models = useQuery({
    queryKey: ['models', provider.baseUrl, provider.endpoint],
    queryFn: () => api.get<{ models: string[]; error?: string }>('/api/models'),
    enabled: provider.configured,
    staleTime: 60_000,
  });
  const switchModel = useCallback((m: string) => {
    void api.put('/api/provider', { model: m }).then(() => toast.success(`Model → ${m}`)).catch((e) => toast.error((e as Error).message));
  }, []);

  const convMode: 'chat' | 'code' = conv?.mode ?? pendingMode;
  const chatMode = convMode === 'chat';
  const shell = !chatMode && mode === 'shell';

  // Slash menu
  const slash = !shell ? matchSlash(text) : null;
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
  }, [draft]);
  // Don't pop the on-screen keyboard uninvited on phones.
  useEffect(() => { if (!isTouch()) ref.current?.focus(); }, [activeId]);

  const runCommand = useCallback((cmd: Command, arg: string) => {
    if (cmd.argRequired && !arg) { setText(`/${cmd.slash} `); setMenuDismissed(true); ref.current?.focus(); return; }
    setText('');
    setMenuDismissed(false);
    void cmd.run(arg);
  }, []);

  const pickFiles = useCallback(async (files: FileList | null) => {
    if (!files?.length) return;
    for (const f of Array.from(files)) {
      try {
        const r = await api.upload<AttachedFile>(`/api/upload?name=${encodeURIComponent(f.name)}`, f, f.type || 'application/octet-stream');
        setAttachments((prev) => (prev.some((a) => a.path === r.path) ? prev : [...prev, r]));
      } catch (e) {
        toast.error(`Upload failed: ${(e as Error).message}`);
      }
    }
  }, []);

  const submit = useCallback(() => {
    const value = text.trim();
    if (!value || running) return;
    if (!shell) {
      const m = matchSlash(value);
      if (m) {
        const cmd = COMMANDS.find((c) => c.slash === m.query) || (matches.length === 1 ? matches[0] : undefined);
        if (cmd) return runCommand(cmd, m.arg);
      }
    }
    history.current = [value, ...history.current.filter((h) => h !== value)].slice(0, 100);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history.current)); } catch { /* private mode */ }
    histIdx.current = -1;
    setText('');
    setMenuDismissed(false);
    haptic();
    const atts = attachments;
    setAttachments([]);
    void send(value, shell ? 'shell' : 'ask', atts);
  }, [text, running, shell, matches, runCommand, send, attachments]);

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
    if (e.key === 'Enter' && !e.shiftKey && (!isTouch() || shell)) { e.preventDefault(); submit(); return; }
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
    if (!chatMode && mode === 'ask' && /^\$\s/.test(value)) { setMode('shell'); setText(value.replace(/^\$\s+/, '')); return; }
    setText(value);
  };

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

        <input ref={fileRef} type="file" multiple hidden onChange={(e) => { void pickFiles(e.target.files); e.target.value = ''; }} />

        <div className={cn('rounded-[22px] border border-line-strong bg-raised shadow-[0_8px_30px_rgb(0_0_0/0.18)] transition-[border-color,box-shadow] focus-within:border-accent/45 focus-within:ring-[3px] focus-within:ring-accent/10', shell && 'border-accent/40')}>
          <div className="flex items-start gap-1 px-4 pb-1 pt-3">
            <span className="w-4 shrink-0 select-none font-mono text-[15px] font-bold leading-[1.6] text-accent" aria-hidden>{shell ? '$' : '❯'}</span>
            <textarea
              id="composer-input"
              ref={ref}
              rows={1}
              value={text}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={shell ? 'Run a command…' : 'Ask shmakk anything — / for commands'}
              enterKeyHint={shell ? 'go' : 'enter'}
              autoCapitalize={shell ? 'off' : 'sentences'}
              autoCorrect={shell ? 'off' : 'on'}
              aria-label={shell ? 'Shell command' : 'Message shmakk'}
              spellCheck={!shell}
              className={cn('max-h-[40vh] min-h-6 flex-1 resize-none bg-transparent leading-[1.6] outline-none placeholder:text-faint', shell && 'font-mono text-[13.5px] leading-[1.75]')}
            />
          </div>
          {attachments.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5 px-4 pb-1">
              {attachments.map((a) => (
                <span key={a.path} className="inline-flex items-center gap-1 rounded-full border border-line bg-bg px-2 py-0.5 font-mono text-xs text-dim">
                  <Paperclip className="size-3" />
                  <span className="max-w-40 truncate">{a.name}</span>
                  <button type="button" aria-label={`Remove ${a.name}`} onClick={() => setAttachments((prev) => prev.filter((x) => x.path !== a.path))} className="text-faint hover:text-danger">
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <div className="flex items-center gap-1.5 px-2.5 pb-2 pt-1">
            <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto [mask-image:linear-gradient(to_right,black_calc(100%-16px),transparent)] [&>*]:shrink-0">
            {!chatMode ? (
              <Segmented label="Input mode" value={mode} onChange={(m) => { setMode(m); ref.current?.focus(); }} options={[{ value: 'ask', label: 'ask' }, { value: 'shell', label: 'shell' }]} />
            ) : null}

            <DropdownMenu>
              <Tip label="Model" side="top">
                <DropdownMenuTrigger asChild>
                  <button type="button" className="inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-0.5 font-mono text-xs text-dim touch:px-3 touch:py-1.5 touch:text-[13px] hover:border-line-strong hover:bg-hover hover:text-fg">
                    <Cpu className="size-3.5" />{provider.model || 'model'}<ChevronDown className="size-3" />
                  </button>
                </DropdownMenuTrigger>
              </Tip>
              <DropdownMenuContent align="start">
                <DropdownMenuLabel>Model</DropdownMenuLabel>
                {models.data?.models?.length ? (
                  <DropdownMenuRadioGroup value={provider.model || ''} onValueChange={switchModel}>
                    {models.data.models.map((m) => <DropdownMenuRadioItem key={m} value={m}>{m}</DropdownMenuRadioItem>)}
                  </DropdownMenuRadioGroup>
                ) : (
                  <div className="px-2.5 py-1.5 text-xs text-faint">{provider.configured ? 'No models listed — use /model' : 'No model configured — set up in Settings'}</div>
                )}
              </DropdownMenuContent>
            </DropdownMenu>

            <Tip label="Attach files" side="top">
              <button type="button" aria-label="Attach files" onClick={() => fileRef.current?.click()} className="inline-flex size-6 items-center justify-center rounded-md text-dim hover:bg-hover hover:text-fg touch:size-8">
                <Paperclip className="size-4" />
              </button>
            </Tip>

            <span className="w-3" />
            </div>

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
                <button type="button" aria-label="Stop" onClick={stop} className="grid size-[34px] shrink-0 place-items-center rounded-full bg-fg text-bg transition-transform hover:scale-105 touch:size-10"><Square className="size-3.5 fill-current" /></button>
              </Tip>
            ) : (
              <Tip label="Send (Enter)" side="top">
                <button type="button" aria-label="Send" disabled={!text.trim()} onClick={submit} className="grid size-[34px] shrink-0 place-items-center rounded-full bg-accent text-accent-ink transition-transform enabled:hover:scale-105 disabled:opacity-35 touch:size-10"><ArrowUp className="size-[18px]" strokeWidth={2.4} /></button>
              </Tip>
            )}
          </div>
        </div>
        <p className="m-0 pt-1.5 text-center text-[11.5px] text-faint max-md:hidden touch:hidden">
          <kbd>Enter</kbd> send · <kbd>Shift Enter</kbd> newline · <kbd>/</kbd> commands{!chatMode ? <> · <kbd>$</kbd> shell · <kbd>{modKey} K</kbd> palette</> : null}
        </p>
      </div>
    </div>
  );
}

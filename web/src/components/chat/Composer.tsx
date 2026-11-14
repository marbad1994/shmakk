import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, ChevronDown, Gauge, Mic, ShieldCheck, Square, Volume2, VolumeX, Zap } from 'lucide-react';
import { COMMANDS, filterCommands, matchSlash, type Command } from '@/lib/commands';
import { cn, modKey } from '@/lib/utils';
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
  const profiles = useApp((s) => s.profiles);
  const draft = useApp((s) => s.draft);
  const activeId = useApp((s) => s.activeId);

  const [text, setText] = useState('');
  const [mode, setMode] = useState<'ask' | 'shell'>('ask');
  const [sel, setSel] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const history = useRef<string[]>(loadHistory());
  const histIdx = useRef(-1);

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
  }, [draft]);
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
    if (!value || running) return;
    if (mode === 'ask') {
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
    void send(value, mode);
  }, [text, running, mode, matches, runCommand, send]);

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
    if (mode === 'ask' && /^\$\s/.test(value)) { setMode('shell'); setText(value.replace(/^\$\s+/, '')); return; }
    setText(value);
  };

  const shell = mode === 'shell';
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
          <div className="flex items-center gap-1.5 px-2.5 pb-2 pt-1">
            <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto [mask-image:linear-gradient(to_right,black_calc(100%-16px),transparent)] [&>*]:shrink-0">
            <Segmented label="Input mode" value={mode} onChange={(m) => { setMode(m); ref.current?.focus(); }} options={[{ value: 'ask', label: 'ask' }, { value: 'shell', label: 'shell' }]} />

            <DropdownMenu>
              <Tip label="Profile — how much context and how many tool rounds" side="top">
                <DropdownMenuTrigger asChild>
                  <button type="button" className="inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-0.5 font-mono text-xs text-dim touch:px-3 touch:py-1.5 touch:text-[13px] hover:border-line-strong hover:bg-hover hover:text-fg">
                    <Gauge className="size-3.5" />{settings.profile || 'auto'}<ChevronDown className="size-3" />
                  </button>
                </DropdownMenuTrigger>
              </Tip>
              <DropdownMenuContent align="start">
                <DropdownMenuLabel>Profile</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={settings.profile || 'auto'} onValueChange={(v) => patchSettings({ profile: v === 'auto' ? null : v })}>
                  <DropdownMenuRadioItem value="auto">auto <span className="text-faint">· picked per task</span></DropdownMenuRadioItem>
                  {profiles.map((p) => <DropdownMenuRadioItem key={p.name} value={p.name}>{p.name} <span className="text-faint">· {p.maxToolIters} rounds</span></DropdownMenuRadioItem>)}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>

            <Tip label="Review mode — confirm every AI action" side="top">
              <button type="button" aria-pressed={settings.review} onClick={() => patchSettings({ review: !settings.review })}
                className={cn('inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-0.5 font-mono text-xs text-dim touch:px-3 touch:py-1.5 touch:text-[13px] hover:bg-hover hover:text-fg', settings.review && 'border-accent/40 bg-accent/10 text-accent hover:text-accent')}>
                <ShieldCheck className="size-3.5" />review
              </button>
            </Tip>
            <Tip label="Auto-accept file writes and edits" side="top">
              <button type="button" aria-pressed={settings.yesFiles} onClick={() => patchSettings({ yesFiles: !settings.yesFiles })}
                className={cn('inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-0.5 font-mono text-xs text-dim touch:px-3 touch:py-1.5 touch:text-[13px] hover:bg-hover hover:text-fg', settings.yesFiles && 'border-accent/40 bg-accent/10 text-accent hover:text-accent')}>
                <Zap className="size-3.5" />yes-files
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
          <kbd>Enter</kbd> send · <kbd>Shift Enter</kbd> newline · <kbd>/</kbd> commands · <kbd>$</kbd> shell · <kbd>{modKey} K</kbd> palette
        </p>
      </div>
    </div>
  );
}

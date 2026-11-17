import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CheckCircle2, Cpu, Database, Download, Eye, FolderOpen, Info, LogOut, Mic, Monitor, Moon, Palette, Power, ScrollText, SlidersHorizontal, Sun, Wrench, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { COMMANDS } from '@/lib/commands';
import type { Provider } from '@/lib/types';
import { cn, tildify } from '@/lib/utils';
import { chooseWorkspace, useApp } from '@/store/app';
import { useTheme, type ThemePref } from '@/hooks/useTheme';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/input';
import { Segmented, Spinner } from '@/components/ui/misc';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Row, Rows, Section } from './Page';

function ProviderSection() {
  const provider = useApp((s) => s.provider);
  const [form, setForm] = useState({ baseUrl: '', model: '', apiKey: '', headers: '', modelList: '' });
  const [test, setTest] = useState<{ ok: boolean; ms?: number; error?: string; model?: string } | null>(null);
  useEffect(() => {
    setForm({ baseUrl: provider.baseUrl || '', model: provider.model || '', apiKey: '', headers: provider.headers || '', modelList: provider.modelList || '' });
  }, [provider.baseUrl, provider.model, provider.headers, provider.modelList, provider.endpoint]);

  const models = useQuery({ queryKey: ['models', provider.baseUrl, provider.endpoint], queryFn: () => api.get<{ models: string[]; error?: string }>('/api/models'), enabled: provider.configured, staleTime: 60_000 });
  // Registry first, then whatever the live endpoint reports.
  const suggestions = Array.from(new Set([...provider.models, ...(models.data?.models || [])]));
  const save = useMutation({
    mutationFn: () => api.put<Provider>('/api/provider', { baseUrl: form.baseUrl.trim(), model: form.model.trim(), headers: form.headers.trim(), modelList: form.modelList.trim(), ...(form.apiKey ? { apiKey: form.apiKey } : {}) }),
    onSuccess: () => { toast.success('Provider saved'); setForm((f) => ({ ...f, apiKey: '' })); setTest(null); },
    onError: (e: Error) => toast.error(e.message),
  });
  // Saved on its own: flipping it should not also submit half-edited fields.
  const saveVision = useMutation({
    mutationFn: (vision: boolean) => api.put<Provider>('/api/provider', { vision }),
    onSuccess: (_r, v) => toast.success(v ? 'Images will be sent to this model' : 'Images will not be sent to this model'),
    onError: (e: Error) => toast.error(e.message),
  });
  const useEndpoint = useMutation({
    mutationFn: (name: string) => api.post('/api/endpoints/use', { name: name === '__none' ? '' : name }),
    onSuccess: () => toast.success('Endpoint switched'),
    onError: (e: Error) => toast.error(e.message),
  });
  const runTest = useMutation({
    mutationFn: () => api.post<{ ok: boolean; ms?: number; error?: string; model?: string }>('/api/provider/test'),
    onSuccess: setTest,
    onError: (e: Error) => setTest({ ok: false, error: e.message }),
  });
  const dirty = form.baseUrl !== (provider.baseUrl || '') || form.model !== (provider.model || '') || !!form.apiKey || form.headers !== (provider.headers || '') || form.modelList !== (provider.modelList || '');

  return (
    <Section id="set-provider" title="Model provider" aside={provider.configured ? null : <Badge tone="warn">not configured</Badge>}>
      <form className="grid min-w-0 grid-cols-2 gap-3 rounded-2xl border border-line bg-raised p-4 max-md:grid-cols-1" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        {provider.endpoints.length ? (
          <Field label="Endpoint preset" hint="From ~/.config/shmakk/endpoints.json" className="col-span-full">
            <Select value={provider.endpoint || '__none'} onValueChange={(v) => useEndpoint.mutate(v)}>
              <SelectTrigger aria-label="Endpoint preset"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">None — use the fields below</SelectItem>
                {provider.endpoints.map((e) => <SelectItem key={e} value={e}>{e}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
        ) : null}
        <Field label="Base URL" htmlFor="p-url" hint="Any OpenAI-compatible endpoint (SHMAKK_BASE_URL)" className="col-span-full">
          <Input id="p-url" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.example.com/v1" className="font-mono text-[13px]" spellCheck={false} />
        </Field>
        <Field label="API key" htmlFor="p-key" hint={provider.hasApiKey ? `Current: ${provider.apiKeyMasked} — leave blank to keep` : 'Stored locally in ~/.config/shmakk/web.json (owner-only)'}>
          <Input id="p-key" type="password" autoComplete="off" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder={provider.hasApiKey ? '••••••••' : 'sk-…'} className="font-mono text-[13px]" />
        </Field>
        <Field
          label="Model"
          htmlFor="p-model"
          hint={provider.modelsSource === 'registry'
            ? `${provider.registry.length} in the registry · ~/.config/shmakk/endpoints.json`
            : models.data?.models.length ? `${models.data.models.length} models from this endpoint` : 'SHMAKK_MODEL'}
        >
          <Input id="p-model" list="model-list" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="gpt-4o-mini" className="font-mono text-[13px]" spellCheck={false} />
          <datalist id="model-list">{suggestions.map((m) => <option key={m} value={m} />)}</datalist>
        </Field>
        <Field label="Extra headers" htmlFor="p-headers" hint="k=v,k=v (SHMAKK_HEADERS)">
          <Input id="p-headers" value={form.headers} onChange={(e) => setForm({ ...form, headers: e.target.value })} className="font-mono text-[13px]" spellCheck={false} />
        </Field>
        {provider.registry.length ? (
          <div className="col-span-full rounded-xl border border-line bg-panel p-3">
            <div className="mb-2 flex items-center gap-2 text-[13px] text-dim">
              <Database className="size-4 shrink-0 text-faint" />
              <span className="min-w-0 truncate">
                Model registry · <code className="font-mono text-faint">~/.config/shmakk/endpoints.json</code>
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {provider.registry.map((m) => {
                const active = form.model === m.model;
                return (
                  <button
                    key={m.name}
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, model: m.model }))}
                    title={`Preset ${m.name} → model ${m.model}${m.provider ? ` · ${m.provider}` : ''}${m.hasApiKey ? ' · has key' : ''}`}
                    className={`inline-flex max-w-full flex-wrap items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12.5px] transition-colors ${active ? 'border-accent/50 bg-accent/10 text-fg' : 'border-line text-dim hover:border-line-strong hover:bg-hover hover:text-fg'}`}
                  >
                    <span className="font-mono">{m.model}</span>
                    {m.name !== m.model ? <span className="text-faint">{m.name}</span> : null}
                    {m.default ? <span className="rounded-full border border-accent/35 bg-accent/10 px-1.5 text-[11px] text-accent">default</span> : null}
                    {m.vision ? <Eye className="size-3.5 text-faint" aria-label="vision" /> : null}
                  </button>
                );
              })}
            </div>
            <p className="m-0 mt-2 text-xs text-faint">
              These are the models the composer offers per space. Environment variables (<code className="font-mono">SHMAKK_MODELS</code>, <code className="font-mono">SHMAKK_MODEL</code>) are only the fallback when there is no registry.
            </p>
          </div>
        ) : (
          <Field label="Model list" htmlFor="p-models" hint="Comma-separated fallback — there is no endpoints.json registry (SHMAKK_MODELS)" className="col-span-full">
            <Input id="p-models" value={form.modelList} onChange={(e) => setForm({ ...form, modelList: e.target.value })} className="font-mono text-[13px]" spellCheck={false} />
          </Field>
        )}
        <label className="col-span-full flex items-start gap-2.5 text-[13px]">
          <Switch checked={!!provider.vision} disabled={!!provider.visionFromEndpoint || save.isPending} onCheckedChange={(v) => saveVision.mutate(v)} aria-label="This model can read images" className="mt-0.5" />
          <span className="grid gap-0.5">
            <span className="font-medium text-fg">This model can read images</span>
            <span className="text-xs text-faint">{provider.visionFromEndpoint ? 'Set by "vision" on the active endpoint in endpoints.json.' : 'Screenshots (Show & tell, image attachments) are sent to it directly. Turn on for multimodal models shmakk cannot detect by name. (SHMAKK_VISION)'}</span>
          </span>
        </label>
        <div className="col-span-full flex flex-wrap items-center gap-2.5">
          <Button type="submit" variant="primary" disabled={!dirty || save.isPending}>Save</Button>
          <Button onClick={() => runTest.mutate()} disabled={!provider.configured || runTest.isPending}>{runTest.isPending ? <Spinner /> : null}Test connection</Button>
          {test ? (
            <span className={`inline-flex min-w-0 items-center gap-1.5 text-[13px] ${test.ok ? 'text-accent' : 'text-danger'}`}>
              {test.ok ? <CheckCircle2 className="size-4 shrink-0" /> : <XCircle className="size-4 shrink-0" />}
              <span className="truncate">{test.ok ? `Replied in ${test.ms} ms · ${test.model}` : test.error}</span>
            </span>
          ) : null}
        </div>
      </form>
    </Section>
  );
}

function Toggle({ title, sub, checked, onChange }: { title: string; sub: string; checked: boolean; onChange(v: boolean): void }) {
  return <Row title={title} sub={sub}><Switch checked={checked} onCheckedChange={onChange} aria-label={title} /></Row>;
}

function PromptSection() {
  const systemPrompt = useApp((s) => s.settings.systemPrompt || '');
  const patch = useApp((s) => s.patchSettings);
  const [value, setValue] = useState(systemPrompt);
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const dirty = value !== systemPrompt;

  // Keep the field in sync when settings arrive from the server.
  useEffect(() => setValue(systemPrompt), [systemPrompt]);

  // Autosave a moment after typing stops, like the rest of settings.
  useEffect(() => {
    if (value === systemPrompt) return;
    setState('saving');
    const t = setTimeout(() => {
      void patch({ systemPrompt: value }).then(() => {
        setState('saved');
        setTimeout(() => setState('idle'), 1600);
      });
    }, 700);
    return () => clearTimeout(t);
  }, [value, systemPrompt, patch]);

  const chars = value.trim().length;
  return (
    <Section
      id="set-prompts"
      title="Prompts"
      aside={state === 'saving' ? <span className="text-[12px] text-faint">saving…</span> : state === 'saved' ? <span className="flex items-center gap-1 text-[12px] text-accent"><CheckCircle2 className="size-3.5" />saved</span> : null}
    >
      <div className="rounded-2xl border border-line bg-raised p-4">
        <Field
          label="Global system prompt"
          htmlFor="p-global-prompt"
          hint="Prepended to every conversation, in every space. A project's own system prompt is added after this one."
        >
          <Textarea
            id="p-global-prompt"
            rows={6}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="e.g. Answer concisely. Match the project's existing patterns instead of adding dependencies. Never guess file contents."
            spellCheck={false}
          />
        </Field>
        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="m-0 text-xs text-faint">
            {chars ? `${chars.toLocaleString()} characters` : 'Nothing set, so no global prompt is applied.'}
          </p>
          {dirty ? (
            <Button variant="ghost" size="sm" onClick={() => setValue(systemPrompt)}>Revert</Button>
          ) : null}
        </div>
      </div>
    </Section>
  );
}

const SECTIONS = [
  { id: 'provider', label: 'Model provider', icon: <Cpu /> },
  { id: 'behaviour', label: 'Behaviour', icon: <SlidersHorizontal /> },
  { id: 'prompts', label: 'Prompts', icon: <ScrollText /> },
  { id: 'voice', label: 'Voice', icon: <Mic /> },
  { id: 'workspace', label: 'Workspace', icon: <FolderOpen /> },
  { id: 'appearance', label: 'Appearance', icon: <Palette /> },
  { id: 'maintenance', label: 'Maintenance', icon: <Wrench /> },
  { id: 'about', label: 'About', icon: <Info /> },
] as const;

type SectionId = typeof SECTIONS[number]['id'];

/** Settings lives in a modal: categories on the left, one scrolling panel on the right. */
export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState<SectionId>('provider');

  const goTo = (id: SectionId) => {
    const c = scroller.current;
    const el = c?.querySelector<HTMLElement>(`#set-${id}`);
    if (!c || !el) return;
    setActive(id);
    c.scrollTo({ top: el.getBoundingClientRect().top - c.getBoundingClientRect().top + c.scrollTop - 8, behavior: 'smooth' });
  };

  // Follow the scroll position so the rail always shows what is on screen.
  const onScroll = () => {
    const c = scroller.current;
    if (!c) return;
    if (c.scrollHeight - c.scrollTop - c.clientHeight < 12) { setActive(SECTIONS[SECTIONS.length - 1].id); return; }
    const top = c.getBoundingClientRect().top;
    let current: SectionId = SECTIONS[0].id;
    for (const s of SECTIONS) {
      const el = c.querySelector<HTMLElement>(`#set-${s.id}`);
      if (el && el.getBoundingClientRect().top - top <= 32) current = s.id;
    }
    setActive(current);
  };

  const settings = useApp((s) => s.settings);
  const patch = useApp((s) => s.patchSettings);
  const profiles = useApp((s) => s.profiles);
  const features = useApp((s) => s.features);
  const workspace = useApp((s) => s.workspace);
  const home = useApp((s) => s.home);
  const version = useApp((s) => s.version);
  const hosted = useApp((s) => s.hosted);
  const status = useApp((s) => s.status);
  const [theme, setTheme] = useTheme();
  const [doc, setDoc] = useState<{ title: string; text: string } | null>(null);
  const run = (id: string) => COMMANDS.find((c) => c.id === id)?.run('');

  const voices = useQuery({ queryKey: ['voices'], queryFn: () => api.get<{ voices: { id: string; name: string; language: string; gender: string }[]; stt: { installed: boolean; cached: boolean }; tts: { installed: boolean; cached: boolean } }>('/api/voice/status?voices=1'), enabled: features.tts && settings.ttsAuto, staleTime: Infinity });
  const completion = async (shell: string) => {
    const r = await api.get<{ script: string }>(`/api/completions/${shell}`);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([r.script], { type: 'text/plain' }));
    a.download = shell === 'fish' ? 'shmakk.fish' : `shmakk-completion.${shell}`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="settings-dialog max-md:h-[calc(var(--app-h)-var(--sat)-24px)] md:!top-[7vh] md:!h-[min(86vh,820px)] md:!max-h-none md:!w-[min(1000px,calc(100vw-48px))] md:!p-0">
        <div className="grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] md:grid-cols-[248px_minmax(0,1fr)] md:grid-rows-1">
          <div className="flex min-h-0 min-w-0 flex-col border-b border-line bg-panel/40 md:border-b-0 md:border-r">
            <DialogHeader>
              <DialogTitle>Settings</DialogTitle>
              <DialogDescription className="sr-only">Settings</DialogDescription>
            </DialogHeader>
            <nav aria-label="Settings sections" className="scroll-touch flex min-w-0 gap-1 overflow-x-auto px-2 pb-2 max-md:pt-1 md:flex-col md:overflow-y-auto md:pb-3">
              {SECTIONS.map((s) => (
                <button key={s.id} type="button" aria-current={active === s.id ? 'true' : undefined} onClick={() => goTo(s.id)}
                  className={cn('flex shrink-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13.5px] text-dim hover:bg-hover hover:text-fg [&_svg]:size-4 [&_svg]:shrink-0', active === s.id && 'bg-accent/10 text-accent')}>
                  {s.icon}{s.label}
                </button>
              ))}
            </nav>
          </div>

          <div ref={scroller} onScroll={onScroll} className="scroll-touch min-h-0 min-w-0 overflow-x-hidden overflow-y-auto px-6 py-5 max-md:px-4">
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-7">
              <ProviderSection />

              <Section id="set-behaviour" title="Behaviour">
                <Rows>
                  <Toggle title="Review mode" sub="Confirm every AI action before it runs, including safe ones (--review)" checked={settings.review} onChange={(v) => patch({ review: v })} />
                  <Toggle title="Auto-accept file edits" sub="Skip confirmation for write, edit and mkdir in auto mode (--yes-files)" checked={settings.yesFiles} onChange={(v) => patch({ yesFiles: v })} />
                  <Toggle title="Command correction" sub="Fix typos in failed shell commands using your command glossary (--no-correction)" checked={!settings.noCorrection} onChange={(v) => patch({ noCorrection: !v })} />
                  <Toggle title="AI follow-up on failed commands" sub="When a shell command fails and isn’t a typo, hand it to the agent (--no-ai turns this off)" checked={!settings.noAi} onChange={(v) => patch({ noAi: !v })} />
                  <Toggle title="Debug output" sub="Show stack traces and verbose errors (--debug)" checked={settings.debug} onChange={(v) => patch({ debug: v })} />
                  <Row title="Profile" sub="How much context and how many tool rounds the agent gets (--profile)">
                    <Select value={settings.profile || 'auto'} onValueChange={(v) => patch({ profile: v === 'auto' ? null : v })}>
                      <SelectTrigger className="w-44 max-sm:w-full" aria-label="Profile"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">auto — per task</SelectItem>
                        {profiles.map((p) => <SelectItem key={p.name} value={p.name}>{p.name} · {p.maxToolIters} rounds</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </Row>
                </Rows>
              </Section>

              <PromptSection />

              <Section id="set-voice" title="Voice" aside={<span className="flex flex-wrap gap-1.5"><Badge tone={features.stt ? 'ok' : 'neutral'}>{features.stt ? 'local Whisper' : 'browser speech-to-text'}</Badge><Badge tone={features.tts ? 'ok' : 'neutral'}>{features.tts ? 'local Kokoro' : 'browser voices'}</Badge></span>}>
                <Rows>
                  <Toggle title="Read replies aloud" sub="Speak each finished answer (--tts)" checked={settings.ttsAuto} onChange={(v) => patch({ ttsAuto: v })} />
                  <Toggle title="Hands-free conversation" sub="After each reply the microphone listens again — speak, pause, repeat (--sts)" checked={settings.voiceHandsFree} onChange={(v) => patch({ voiceHandsFree: v, ...(v ? { ttsAuto: true } : {}) })} />
                  {features.tts ? (
                    <Row title="Voice" sub="Kokoro voice used for speech (--tts-voice)">
                      {voices.data?.voices.length ? (
                        <Select value={settings.ttsVoice || 'af_heart'} onValueChange={(v) => patch({ ttsVoice: v })}>
                          <SelectTrigger className="w-52 max-sm:w-full" aria-label="Voice"><SelectValue /></SelectTrigger>
                          <SelectContent>{voices.data.voices.map((v) => <SelectItem key={v.id} value={v.id}>{v.name} · {v.language}</SelectItem>)}</SelectContent>
                        </Select>
                      ) : (
                        <Input className="w-52 max-sm:w-full font-mono text-[13px]" defaultValue={settings.ttsVoice || ''} placeholder="af_heart" aria-label="Voice id" onBlur={(e) => patch({ ttsVoice: e.target.value.trim() || null })} />
                      )}
                    </Row>
                  ) : null}
                  <Row title="Language" sub="Hint for transcription, e.g. english, es, fr (--voice-language)">
                    <Input className="w-52 max-sm:w-full" defaultValue={settings.voiceLanguage || ''} placeholder="english" aria-label="Voice language" onBlur={(e) => patch({ voiceLanguage: e.target.value.trim() || null })} />
                  </Row>
                </Rows>
                {!features.stt || !features.tts ? <p className="m-0 text-[13px] text-faint">For fully local speech models run <code className="font-mono">npm run setup:voice</code> in the shmakk package. The first use downloads the models.</p> : null}
              </Section>

              <Section id="set-workspace" title="Workspace">
                <Rows>
                  <Row title={<span className="font-mono text-[13px]">{tildify(workspace, home)}</span>} sub={status?.workspaceWarning || 'shmakk’s tools are confined to this folder (--workspace)'}>
                    <Button onClick={() => void chooseWorkspace()}><FolderOpen />Switch…</Button>
                  </Row>
                  <Row title="Workspaces root" sub="“Create workspace…” makes a new folder directly inside this directory, never a sub-folder of it">
                    <div className="flex items-center gap-2">
                      <Input className="w-72 max-sm:w-full font-mono text-[13px]" defaultValue={settings.workspacesRoot || ''} placeholder="~/workspaces" aria-label="Workspaces root" onBlur={(e) => patch({ workspacesRoot: e.target.value.trim() || null })} />
                      <Button variant="ghost" onClick={() => patch({ workspacesRoot: workspace })}>Use current</Button>
                    </div>
                  </Row>
                </Rows>
              </Section>

              <Section id="set-appearance" title="Appearance">
                <Rows>
                  <Row title="Theme" sub="Follow the system, or pick one">
                    <Segmented<ThemePref> label="Theme" value={theme} onChange={setTheme} options={[
                      { value: 'system', label: <span className="inline-flex items-center gap-1.5"><Monitor className="size-3.5" />system</span> },
                      { value: 'dark', label: <span className="inline-flex items-center gap-1.5"><Moon className="size-3.5" />dark</span> },
                      { value: 'light', label: <span className="inline-flex items-center gap-1.5"><Sun className="size-3.5" />light</span> },
                    ]} />
                  </Row>
                </Rows>
              </Section>

              <Section id="set-maintenance" title="Maintenance">
                <Rows>
                  <Row title="Command glossary" sub={status?.glossary.exists ? `${status.glossary.commands} commands indexed — used to correct typos` : 'Not built yet — scan your PATH so typos can be corrected (--update-command-glossary)'}>
                    <Button onClick={() => run('glossary')}>{status?.glossary.exists ? 'Rebuild' : 'Build'}</Button>
                  </Row>
                  <Row title="Shell history" sub="Learn which commands you use most to rank corrections (--build-history)"><Button onClick={() => run('history')}>Build frequency map</Button></Row>
                  <Row title="Shell completions" sub="Tab-completion scripts for the shmakk CLI (--completion)">
                    {['bash', 'zsh', 'fish'].map((s) => <Button key={s} size="sm" onClick={() => void completion(s)}><Download />{s}</Button>)}
                  </Row>
                  <Row title="Resolved configuration" sub="What the server is actually running with (--print-config)">
                    <Button onClick={async () => setDoc({ title: 'Configuration', text: JSON.stringify(await api.get('/api/config'), null, 2) })}>Show</Button>
                  </Row>
                  <Row title="CLI reference" sub="Every flag and environment variable (--help)">
                    <Button onClick={async () => setDoc({ title: 'shmakk --help', text: (await api.get<{ text: string }>('/api/help')).text })}>Show</Button>
                  </Row>
                </Rows>
              </Section>

              <Section id="set-about" title="About">
                <Rows>
                  <Row title={`shmakk ${version}`} sub={features.desktop ? 'Desktop app' : 'Web interface — also available as a desktop app via shmakk --desktop'}>
                    <Button variant="danger" onClick={() => run('exit')}><Power />{hosted ? 'Restart server' : 'Quit shmakk'}</Button>
                  </Row>
                  {hosted ? (
                    <Row title="This device" sub="Remove the access token from this browser. You’ll need the token to sign in again.">
                      <Button onClick={() => { window.location.href = '/logout'; }}><LogOut />Sign out</Button>
                    </Row>
                  ) : null}
                </Rows>
              </Section>

              <Dialog open={!!doc} onOpenChange={(o) => { if (!o) setDoc(null); }}>
                <DialogContent className="w-[min(820px,calc(100vw-32px))]">
                  <DialogHeader><DialogTitle>{doc?.title}</DialogTitle></DialogHeader>
                  <DialogBody><pre className="m-0 whitespace-pre-wrap break-words font-mono text-[12.5px] leading-relaxed text-dim">{doc?.text}</pre></DialogBody>
                </DialogContent>
              </Dialog>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
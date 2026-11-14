import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CheckCircle2, Download, FolderOpen, Monitor, Moon, Power, Sun, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { COMMANDS } from '@/lib/commands';
import type { Provider } from '@/lib/types';
import { tildify } from '@/lib/utils';
import { chooseWorkspace, useApp } from '@/store/app';
import { useTheme, type ThemePref } from '@/hooks/useTheme';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Segmented, Spinner } from '@/components/ui/misc';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Page, Row, Rows, Section } from './Page';

function ProviderSection() {
  const provider = useApp((s) => s.provider);
  const [form, setForm] = useState({ baseUrl: '', model: '', apiKey: '', headers: '', registry: '' });
  const [test, setTest] = useState<{ ok: boolean; ms?: number; error?: string; model?: string } | null>(null);
  useEffect(() => {
    setForm({ baseUrl: provider.baseUrl || '', model: provider.model || '', apiKey: '', headers: provider.headers || '', registry: provider.registry || '' });
  }, [provider.baseUrl, provider.model, provider.headers, provider.registry, provider.endpoint]);

  const models = useQuery({ queryKey: ['models', provider.baseUrl, provider.endpoint], queryFn: () => api.get<{ models: string[]; error?: string }>('/api/models'), enabled: provider.configured, staleTime: 60_000 });
  const save = useMutation({
    mutationFn: () => api.put<Provider>('/api/provider', { baseUrl: form.baseUrl.trim(), model: form.model.trim(), headers: form.headers.trim(), registry: form.registry.trim(), ...(form.apiKey ? { apiKey: form.apiKey } : {}) }),
    onSuccess: () => { toast.success('Provider saved'); setForm((f) => ({ ...f, apiKey: '' })); setTest(null); },
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
  const dirty = form.baseUrl !== (provider.baseUrl || '') || form.model !== (provider.model || '') || !!form.apiKey || form.headers !== (provider.headers || '') || form.registry !== (provider.registry || '');

  return (
    <Section title="Model provider" aside={provider.configured ? <Badge tone="ok">connected</Badge> : <Badge tone="warn">not configured</Badge>}>
      <form className="grid grid-cols-2 gap-3 rounded-2xl border border-line bg-raised p-4 max-md:grid-cols-1" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        {provider.endpoints.length ? (
          <Field label="Endpoint preset" hint="From ~/.config/shmakk/endpoints.js" className="col-span-full">
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
        <Field label="Model" htmlFor="p-model" hint={models.data?.models.length ? `${models.data.models.length} models available from this endpoint` : 'SHMAKK_MODEL'}>
          <Input id="p-model" list="model-list" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="gpt-4o-mini" className="font-mono text-[13px]" spellCheck={false} />
          <datalist id="model-list">{models.data?.models.map((m) => <option key={m} value={m} />)}</datalist>
        </Field>
        <Field label="Extra headers" htmlFor="p-headers" hint="k=v,k=v (SHMAKK_HEADERS)">
          <Input id="p-headers" value={form.headers} onChange={(e) => setForm({ ...form, headers: e.target.value })} className="font-mono text-[13px]" spellCheck={false} />
        </Field>
        <Field label="Model registry" htmlFor="p-reg" hint="Comma-separated filter for makkorch (SHMAKK_REGISTRY)">
          <Input id="p-reg" value={form.registry} onChange={(e) => setForm({ ...form, registry: e.target.value })} className="font-mono text-[13px]" spellCheck={false} />
        </Field>
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

export function SettingsView() {
  const settings = useApp((s) => s.settings);
  const patch = useApp((s) => s.patchSettings);
  const profiles = useApp((s) => s.profiles);
  const features = useApp((s) => s.features);
  const workspace = useApp((s) => s.workspace);
  const home = useApp((s) => s.home);
  const version = useApp((s) => s.version);
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
    <Page>
      <ProviderSection />

      <Section title="Behaviour">
        <Rows>
          <Toggle title="Review mode" sub="Confirm every AI action before it runs, including safe ones (--review)" checked={settings.review} onChange={(v) => patch({ review: v })} />
          <Toggle title="Auto-accept file edits" sub="Skip confirmation for write, edit and mkdir in auto mode (--yes-files)" checked={settings.yesFiles} onChange={(v) => patch({ yesFiles: v })} />
          <Toggle title="Command correction" sub="Fix typos in failed shell commands using your command glossary (--no-correction)" checked={!settings.noCorrection} onChange={(v) => patch({ noCorrection: !v })} />
          <Toggle title="AI follow-up on failed commands" sub="When a shell command fails and isn’t a typo, hand it to the agent (--no-ai turns this off)" checked={!settings.noAi} onChange={(v) => patch({ noAi: !v })} />
          <Toggle title="Debug output" sub="Show stack traces and verbose errors (--debug)" checked={settings.debug} onChange={(v) => patch({ debug: v })} />
          <Row title="Profile" sub="How much context and how many tool rounds the agent gets (--profile)">
            <Select value={settings.profile || 'auto'} onValueChange={(v) => patch({ profile: v === 'auto' ? null : v })}>
              <SelectTrigger className="w-44" aria-label="Profile"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">auto — per task</SelectItem>
                {profiles.map((p) => <SelectItem key={p.name} value={p.name}>{p.name} · {p.maxToolIters} rounds</SelectItem>)}
              </SelectContent>
            </Select>
          </Row>
        </Rows>
      </Section>

      <Section title="Voice" aside={<span className="flex gap-1.5"><Badge tone={features.stt ? 'ok' : 'neutral'}>{features.stt ? 'local Whisper' : 'browser speech-to-text'}</Badge><Badge tone={features.tts ? 'ok' : 'neutral'}>{features.tts ? 'local Kokoro' : 'browser voices'}</Badge></span>}>
        <Rows>
          <Toggle title="Read replies aloud" sub="Speak each finished answer (--tts)" checked={settings.ttsAuto} onChange={(v) => patch({ ttsAuto: v })} />
          <Toggle title="Hands-free conversation" sub="After each reply the microphone listens again — speak, pause, repeat (--sts)" checked={settings.voiceHandsFree} onChange={(v) => patch({ voiceHandsFree: v, ...(v ? { ttsAuto: true } : {}) })} />
          {features.tts ? (
            <Row title="Voice" sub="Kokoro voice used for speech (--tts-voice)">
              {voices.data?.voices.length ? (
                <Select value={settings.ttsVoice || 'af_heart'} onValueChange={(v) => patch({ ttsVoice: v })}>
                  <SelectTrigger className="w-52" aria-label="Voice"><SelectValue /></SelectTrigger>
                  <SelectContent>{voices.data.voices.map((v) => <SelectItem key={v.id} value={v.id}>{v.name} · {v.language}</SelectItem>)}</SelectContent>
                </Select>
              ) : (
                <Input className="w-52 font-mono text-[13px]" defaultValue={settings.ttsVoice || ''} placeholder="af_heart" aria-label="Voice id" onBlur={(e) => patch({ ttsVoice: e.target.value.trim() || null })} />
              )}
            </Row>
          ) : null}
          <Row title="Language" sub="Hint for transcription, e.g. english, es, fr (--voice-language)">
            <Input className="w-52" defaultValue={settings.voiceLanguage || ''} placeholder="english" aria-label="Voice language" onBlur={(e) => patch({ voiceLanguage: e.target.value.trim() || null })} />
          </Row>
        </Rows>
        {!features.stt || !features.tts ? <p className="m-0 text-[13px] text-faint">For fully local speech models run <code className="font-mono">npm run setup:voice</code> in the shmakk package. The first use downloads the models.</p> : null}
      </Section>

      <Section title="Workspace">
        <Rows>
          <Row title={<span className="font-mono text-[13px]">{tildify(workspace, home)}</span>} sub={status?.workspaceWarning || 'shmakk’s tools are confined to this folder (--workspace)'}>
            <Button onClick={() => void chooseWorkspace()}><FolderOpen />Switch…</Button>
          </Row>
        </Rows>
      </Section>

      <Section title="Appearance">
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

      <Section title="Maintenance">
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

      <Section title="About">
        <Rows>
          <Row title={`shmakk ${version}`} sub={features.desktop ? 'Desktop app' : 'Web interface — also available as a desktop app via shmakk --desktop'}>
            <Button variant="danger" onClick={() => run('exit')}><Power />Quit shmakk</Button>
          </Row>
        </Rows>
      </Section>

      <Dialog open={!!doc} onOpenChange={(o) => { if (!o) setDoc(null); }}>
        <DialogContent className="w-[min(820px,calc(100vw-32px))]">
          <DialogHeader><DialogTitle>{doc?.title}</DialogTitle></DialogHeader>
          <DialogBody><pre className="m-0 whitespace-pre-wrap break-words font-mono text-[12.5px] leading-relaxed text-dim">{doc?.text}</pre></DialogBody>
        </DialogContent>
      </Dialog>
    </Page>
  );
}

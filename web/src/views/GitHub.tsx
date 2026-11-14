import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Copy, ExternalLink, GitBranch, GitFork, Lock, RotateCw, Search } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { copyText, relTime, tildify } from '@/lib/utils';
import { useApp } from '@/store/app';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/input';
import { Empty, Spinner } from '@/components/ui/misc';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Loading, Page, Row, Rows, Section } from './Page';

interface GhStatus {
  connected: boolean; source: 'env' | 'saved' | null; deviceFlow: boolean; workspacesDir: string; error: string | null;
  user: { login: string; name: string; avatar: string; url: string; scopes: string[] } | null;
}
interface Repo {
  fullName: string; owner: string; name: string; private: boolean; fork: boolean; archived: boolean; description: string;
  defaultBranch: string; pushedAt: string; language: string | null; url: string; canPush: boolean;
}
interface Device { deviceCode: string; userCode: string; verificationUri: string; interval: number }

const openUrl = (url: string) => (window.shmakkDesktop ? window.shmakkDesktop.openExternal(url) : window.open(url, '_blank', 'noopener'));
const NEW_TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=repo,read:org&description=shmakk';

function Connect({ status }: { status: GhStatus }) {
  const qc = useQueryClient();
  const [token, setToken] = useState('');
  const [device, setDevice] = useState<Device | null>(null);
  const timer = useRef<number | null>(null);
  const done = () => qc.invalidateQueries({ queryKey: ['github'] });

  const connect = useMutation({
    mutationFn: () => api.post<GhStatus>('/api/github/connect', { token }),
    onSuccess: (s) => { toast.success(`Connected as ${s.user?.login}`); setToken(''); void done(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const start = useMutation({
    mutationFn: () => api.post<Device>('/api/github/device/start'),
    onSuccess: (d) => { setDevice(d); openUrl(d.verificationUri); },
    onError: (e: Error) => toast.error(e.message),
  });

  // Poll GitHub while the user enters the code on github.com.
  useEffect(() => {
    if (!device) return;
    let delay = device.interval * 1000;
    const tick = async () => {
      try {
        const r = await api.post<{ state: string; slowDown?: boolean; error?: string }>('/api/github/device/poll', { deviceCode: device.deviceCode });
        if (r.state === 'connected') { toast.success('GitHub connected'); setDevice(null); void done(); return; }
        if (r.state !== 'pending') { toast.error(r.error || `Sign-in ${r.state}`); setDevice(null); return; }
        if (r.slowDown) delay += 5000;
      } catch { /* transient — keep polling */ }
      timer.current = window.setTimeout(tick, delay);
    };
    timer.current = window.setTimeout(tick, delay);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [device]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Section title="Connect GitHub">
      {status.error ? <p className="m-0 rounded-[10px] border border-danger/40 bg-danger/10 px-3 py-2 text-[13px] text-danger">{status.error}</p> : null}
      <div className="grid gap-4 rounded-2xl border border-line bg-raised p-4">
        {status.deviceFlow ? (
          <div className="grid gap-2.5">
            {device ? (
              <div className="grid justify-items-start gap-2">
                <span className="text-dim">Enter this code at <button type="button" className="text-accent underline underline-offset-2" onClick={() => openUrl(device.verificationUri)}>{device.verificationUri.replace(/^https?:\/\//, '')}</button></span>
                <button type="button" onClick={async () => { if (await copyText(device.userCode)) toast('Code copied'); }} className="inline-flex items-center gap-3 rounded-xl border border-accent/40 bg-accent/10 px-4 py-2 font-mono text-2xl font-bold tracking-[0.2em] text-accent">
                  {device.userCode}<Copy className="size-4" />
                </button>
                <span className="inline-flex items-center gap-2 text-[13px] text-faint"><Spinner />Waiting for you to approve…</span>
              </div>
            ) : (
              <Button variant="primary" className="justify-self-start" disabled={start.isPending} onClick={() => start.mutate()}><GitBranch />Sign in with GitHub</Button>
            )}
            <div className="flex items-center gap-3 text-xs text-faint before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line">or use a token</div>
          </div>
        ) : null}
        <form className="grid gap-2.5" onSubmit={(e) => { e.preventDefault(); if (token.trim()) connect.mutate(); }}>
          <Field label="Personal access token" htmlFor="gh-token" hint={<>Needs the <code className="font-mono">repo</code> scope (classic), or a fine-grained token with <em>Contents</em> and <em>Pull requests</em> read/write on the repositories you want to use. Stored on the server in an owner-only file.</>}>
            <Input id="gh-token" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="ghp_… or github_pat_…" className="font-mono text-[13px]" />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant={status.deviceFlow ? 'default' : 'primary'} disabled={!token.trim() || connect.isPending}>{connect.isPending ? 'Checking…' : 'Connect'}</Button>
            <Button variant="ghost" onClick={() => openUrl(NEW_TOKEN_URL)}>Create a token<ExternalLink /></Button>
          </div>
        </form>
      </div>
    </Section>
  );
}

function StartDialog({ repo, onClose }: { repo: Repo | null; onClose(): void }) {
  const startSession = useApp((s) => s.startSession);
  const [branch, setBranch] = useState('');
  const [newBranch, setNewBranch] = useState('');
  const [prompt, setPrompt] = useState('');
  const branches = useQuery({
    queryKey: ['github', 'branches', repo?.fullName],
    queryFn: () => api.get<{ defaultBranch: string; canPush: boolean; branches: string[] }>(`/api/github/branches?repo=${encodeURIComponent(repo!.fullName)}`),
    enabled: !!repo,
  });
  useEffect(() => { if (repo) { setBranch(repo.defaultBranch); setNewBranch(''); setPrompt(''); } }, [repo]);

  const start = useMutation({
    mutationFn: () => startSession({ repo: repo!.fullName, branch, newBranch: newBranch.trim() || undefined, prompt: prompt.trim() || undefined }),
    onSuccess: () => { toast.success(`Session ready on ${repo!.fullName}`); onClose(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const list = useMemo(() => Array.from(new Set([repo?.defaultBranch, ...(branches.data?.branches || [])].filter(Boolean) as string[])), [repo, branches.data]);

  return (
    <Dialog open={!!repo} onOpenChange={(o) => { if (!o && !start.isPending) onClose(); }}>
      <DialogContent>
        <form onSubmit={(e) => { e.preventDefault(); start.mutate(); }} className="flex min-h-0 flex-col">
          <DialogHeader>
            <DialogTitle>New session</DialogTitle>
            <DialogDescription>shmakk clones <span className="font-mono text-fg">{repo?.fullName}</span> into its own folder on the server and opens a chat on it.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
              <Field label="Start from branch">
                <Select value={branch} onValueChange={setBranch}>
                  <SelectTrigger aria-label="Base branch" className="font-mono text-[13px]"><SelectValue /></SelectTrigger>
                  <SelectContent>{list.map((b) => <SelectItem key={b} value={b} className="font-mono">{b}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
              <Field label="Work on a new branch" htmlFor="gh-new-branch" hint={repo?.canPush ? 'Recommended — needed to open a pull request' : 'You have read-only access to this repository'}>
                <Input id="gh-new-branch" value={newBranch} onChange={(e) => setNewBranch(e.target.value.replace(/\s+/g, '-'))} placeholder="shmakk/my-change" className="font-mono text-[13px]" spellCheck={false} autoCapitalize="off" />
              </Field>
            </div>
            <Field label="First task (optional)" htmlFor="gh-prompt" hint="Leave empty to just open the session.">
              <Textarea id="gh-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} className="min-h-24 font-sans" placeholder="e.g. Find out why the login test is flaky and fix it" />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose} disabled={start.isPending}>Cancel</Button>
            <Button variant="primary" type="submit" disabled={start.isPending || !branch}>{start.isPending ? <><Spinner className="text-accent-ink" />Cloning…</> : <>Start session<ArrowRight /></>}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function GitHubView() {
  const qc = useQueryClient();
  const home = useApp((s) => s.home);
  const convs = useApp((s) => s.convs);
  const runs = useApp((s) => s.runs);
  const openConv = useApp((s) => s.openConv);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Repo | null>(null);
  const status = useQuery({ queryKey: ['github'], queryFn: () => api.get<GhStatus>('/api/github') });
  const connected = !!status.data?.connected;
  const repos = useQuery({
    queryKey: ['github', 'repos', query],
    queryFn: () => api.get<{ total: number; repos: Repo[] }>(`/api/github/repos?q=${encodeURIComponent(query)}`),
    enabled: connected,
  });
  // debounce the search box
  useEffect(() => { const t = setTimeout(() => setQuery(q.trim()), 250); return () => clearTimeout(t); }, [q]);

  const disconnect = useMutation({
    mutationFn: () => api.post('/api/github/disconnect'),
    onSuccess: () => { toast('GitHub disconnected'); void qc.invalidateQueries({ queryKey: ['github'] }); },
  });
  const sessions = convs.filter((c) => c.repo);

  if (status.isLoading) return <Page><Loading /></Page>;
  const st = status.data!;

  return (
    <Page lead="Pick a repository and shmakk clones it on this server into a session of its own. Work on it from any device, then push and open a pull request without leaving the chat.">
      {!connected ? <Connect status={st} /> : (
        <Rows>
          <Row
            title={<span className="inline-flex items-center gap-2.5">{st.user?.avatar ? <img src={st.user.avatar} alt="" className="size-7 rounded-full" referrerPolicy="no-referrer" /> : null}{st.user?.name}<span className="font-mono text-[13px] font-normal text-dim">@{st.user?.login}</span></span>}
            sub={st.source === 'env' ? 'Connected through the server’s GITHUB_TOKEN environment variable' : `Sessions are cloned into ${tildify(st.workspacesDir, home)}`}
          >
            <Badge tone="ok">connected</Badge>
            {st.source === 'saved' ? <Button size="sm" variant="ghost" onClick={() => disconnect.mutate()}>Disconnect</Button> : null}
          </Row>
        </Rows>
      )}

      {sessions.length ? (
        <Section title={`Sessions · ${sessions.length}`}>
          <Rows>
            {sessions.map((c) => (
              <Row key={c.id} title={<button type="button" className="text-left hover:text-accent" onClick={() => void openConv(c.id)}>{c.title}</button>}
                sub={<span className="inline-flex flex-wrap items-center gap-x-2 font-mono text-xs"><span>{c.repo!.fullName}</span><span className="inline-flex items-center gap-1 text-violet"><GitBranch className="size-3" />{c.repo!.branch}</span><span className="text-faint">{relTime(c.updatedAt)}</span></span>}>
                {c.id in runs ? <Badge tone="ok"><Spinner className="size-3" />working</Badge> : null}
                <Button size="sm" onClick={() => void openConv(c.id)}>Open</Button>
              </Row>
            ))}
          </Rows>
        </Section>
      ) : null}

      {connected ? (
        <Section title="Repositories" aside={<Button variant="ghost" size="icon-sm" aria-label="Refresh repositories" onClick={() => void api.get('/api/github/repos?refresh=1').then(() => qc.invalidateQueries({ queryKey: ['github', 'repos'] }))}><RotateCw className={repos.isFetching ? 'animate-spin' : undefined} /></Button>}>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-faint touch:top-3.5" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your repositories, or type any owner/repo" className="pl-9" aria-label="Search repositories" autoCapitalize="off" spellCheck={false} />
          </div>
          {repos.isLoading ? <Loading /> : repos.error ? <Empty title="Couldn’t load repositories">{(repos.error as Error).message}</Empty> : repos.data?.repos.length ? (
            <Rows>
              {repos.data.repos.map((r) => (
                <Row key={r.fullName}
                  title={<span className="inline-flex min-w-0 max-w-full items-center gap-2"><span className="truncate font-mono text-[13.5px]">{r.fullName}</span>{r.private ? <Lock className="size-3.5 shrink-0 text-faint" aria-label="Private" /> : null}{r.fork ? <GitFork className="size-3.5 shrink-0 text-faint" aria-label="Fork" /> : null}{r.archived ? <Badge tone="warn">archived</Badge> : null}</span>}
                  sub={<span className="line-clamp-1">{[r.language, r.description, `pushed ${relTime(r.pushedAt)}`].filter(Boolean).join(' · ')}</span>}>
                  <Button size="sm" variant="primary" onClick={() => setPicked(r)}>Start session</Button>
                </Row>
              ))}
            </Rows>
          ) : <Empty icon={<GitBranch />} title={query ? `No repository matches “${query}”` : 'No repositories found'}>Type a full <code className="font-mono">owner/repo</code> to open any repository your token can read.</Empty>}
        </Section>
      ) : null}

      <StartDialog repo={picked} onClose={() => setPicked(null)} />
    </Page>
  );
}

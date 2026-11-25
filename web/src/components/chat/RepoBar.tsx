import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpFromLine, ExternalLink, GitBranch, GitPullRequest, Lock } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { ConvMeta, RepoRef } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

interface GitState {
  repo: RepoRef;
  status: { branch: string | null; upstream: string | null; ahead: number; behind: number; unpushed: number; files: { status: string; path: string }[] };
  pr: { number: number; url: string; state: string; title: string; draft: boolean } | null;
}

const open = (url: string) => (window.shmakkDesktop ? window.shmakkDesktop.openExternal(url) : window.open(url, '_blank', 'noopener'));

/** Source-control strip for a GitHub cloud session: branch, pending changes, push, pull request. */
export function RepoBar({ conv, running }: { conv: ConvMeta; running: boolean }) {
  const qc = useQueryClient();
  const key = ['git', conv.id];
  const { data, error } = useQuery({ queryKey: key, queryFn: () => api.get<GitState>(`/api/github/sessions/${conv.id}`), refetchInterval: running ? 4000 : 15000 });
  const [dialog, setDialog] = useState<'push' | 'pr' | null>(null);
  const [message, setMessage] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [draft, setDraft] = useState(false);

  const push = useMutation({
    mutationFn: () => api.post<{ committed: boolean; branch: string }>(`/api/github/sessions/${conv.id}/push`, { message }),
    onSuccess: (r) => { toast.success(`${r.committed ? 'Committed and pushed' : 'Pushed'} to ${r.branch}`); setDialog(null); setMessage(''); void qc.invalidateQueries({ queryKey: key }); },
    onError: (e: Error) => toast.error(e.message),
  });
  const pr = useMutation({
    mutationFn: () => api.post<{ url: string; number: number }>(`/api/github/sessions/${conv.id}/pr`, { title, body, draft }),
    onSuccess: (r) => { toast.success(`Pull request #${r.number} opened`, { action: { label: 'View', onClick: () => open(r.url) } }); setDialog(null); void qc.invalidateQueries({ queryKey: key }); },
    onError: (e: Error) => toast.error(e.message),
  });

  const repo = data?.repo ?? conv.repo!;
  const st = data?.status;
  const changes = st?.files.length ?? 0;
  const canPush = !!st && (changes > 0 || st.unpushed > 0);
  const onBase = !st || st.branch === repo.baseBranch;
  const canPr = !!st && !onBase && !data?.pr && changes === 0 && st.unpushed === 0 && !!st.upstream;

  return (
    <div className="shrink-0 border-b border-line bg-panel/60 px-3.5 py-1.5 max-md:px-2">
      <div className="no-scrollbar mx-auto flex max-w-[780px] items-center gap-2 overflow-x-auto font-mono text-xs text-dim [&>*]:shrink-0">
        <button type="button" onClick={() => open(repo.url)} className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-fg hover:bg-hover">
          {repo.private ? <Lock className="size-3.5 text-faint" /> : null}{repo.fullName}<ExternalLink className="size-3 text-faint" />
        </button>
        <span className="inline-flex items-center gap-1 text-violet"><GitBranch className="size-3.5" />{st?.branch || repo.branch}</span>
        {error ? <Badge tone="danger">workspace unavailable</Badge> : null}
        {changes ? <Badge tone="warn">{changes} changed</Badge> : null}
        {st?.unpushed ? <Badge tone="info">{st.unpushed} unpushed</Badge> : null}
        {st?.behind ? <Badge>{st.behind} behind</Badge> : null}
        {data?.pr ? (
          <button type="button" onClick={() => open(data.pr!.url)} className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-px font-semibold', data.pr.state === 'merged' ? 'border-violet/40 bg-violet/10 text-violet' : data.pr.state === 'open' ? 'border-accent/35 bg-accent/10 text-accent' : 'border-line-strong')}>
            <GitPullRequest className="size-3" />#{data.pr.number} {data.pr.draft ? 'draft' : data.pr.state}
          </button>
        ) : null}
        <span className="min-w-2 flex-1" />
        {repo.canPush ? (
          <>
            <Button size="sm" className="font-sans" disabled={!canPush || running} onClick={() => { setMessage(''); setDialog('push'); }}><ArrowUpFromLine />{changes ? 'Commit & push' : 'Push'}</Button>
            {!data?.pr ? <Button size="sm" variant="primary" className="font-sans" disabled={!canPr || running} title={onBase ? 'Work on a branch to open a pull request' : !canPr ? 'Push your changes first' : undefined} onClick={() => { setTitle(conv.title); setBody(''); setDialog('pr'); }}><GitPullRequest />Open PR</Button> : null}
          </>
        ) : <Badge>read-only access</Badge>}
      </div>

      <Dialog open={dialog === 'push'} onOpenChange={(o) => { if (!o) setDialog(null); }}>
        <DialogContent>
          <form onSubmit={(e) => { e.preventDefault(); push.mutate(); }} className="flex min-h-0 flex-col">
            <DialogHeader>
              <DialogTitle>{changes ? 'Commit & push' : 'Push'}</DialogTitle>
              <DialogDescription>to <span className="font-mono">{repo.fullName}</span> · <span className="font-mono">{st?.branch}</span></DialogDescription>
            </DialogHeader>
            <DialogBody>
              {changes ? (
                <>
                  <Field label="Commit message" htmlFor="commit-msg"><Input id="commit-msg" autoFocus value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Describe the change" /></Field>
                  <div className="max-h-48 overflow-y-auto rounded-[10px] border border-line bg-sunken px-3 py-2 font-mono text-[12.5px] text-dim">
                    {st!.files.map((f) => <div key={f.path} className="flex gap-2"><span className={cn('w-5 shrink-0', f.status === '?' ? 'text-accent' : f.status.includes('D') ? 'text-danger' : 'text-warn')}>{f.status === '?' ? 'A' : f.status}</span><span className="break-all">{f.path}</span></div>)}
                  </div>
                </>
              ) : <p className="m-0 text-dim">{st?.unpushed} commit{st?.unpushed === 1 ? '' : 's'} will be pushed.</p>}
              {onBase ? <p className="m-0 text-[13px] text-warn">You’re on the base branch — this pushes straight to <span className="font-mono">{repo.baseBranch}</span>.</p> : null}
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setDialog(null)}>Cancel</Button>
              <Button variant="primary" type="submit" disabled={push.isPending || (changes > 0 && !message.trim())}>{push.isPending ? 'Pushing…' : changes ? 'Commit & push' : 'Push'}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === 'pr'} onOpenChange={(o) => { if (!o) setDialog(null); }}>
        <DialogContent>
          <form onSubmit={(e) => { e.preventDefault(); pr.mutate(); }} className="flex min-h-0 flex-col">
            <DialogHeader>
              <DialogTitle>Open pull request</DialogTitle>
              <DialogDescription><span className="font-mono">{st?.branch}</span> → <span className="font-mono">{repo.baseBranch}</span></DialogDescription>
            </DialogHeader>
            <DialogBody>
              <Field label="Title" htmlFor="pr-title"><Input id="pr-title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
              <Field label="Description" htmlFor="pr-body"><Textarea id="pr-body" value={body} onChange={(e) => setBody(e.target.value)} className="min-h-32 font-sans" placeholder="What changed and why" /></Field>
              <label className="flex items-center gap-2.5 text-[13.5px]"><Switch checked={draft} onCheckedChange={setDraft} />Open as draft</label>
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setDialog(null)}>Cancel</Button>
              <Button variant="primary" type="submit" disabled={pr.isPending || !title.trim()}>{pr.isPending ? 'Opening…' : 'Open pull request'}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

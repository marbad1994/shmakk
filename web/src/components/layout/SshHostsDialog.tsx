import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Pencil, Plus, Server, Terminal, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { cn, tildify } from '@/lib/utils';
import { useApp } from '@/store/app';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tip } from '@/components/ui/tooltip';

type Scope = 'workspace' | 'global';
type Source = Scope | 'config';

interface SshHost { name: string; host: string; port: number; auto_approve: boolean; timeout_sec: number; source: Source; editable: boolean }
interface SshData { hosts: SshHost[]; paths: { global: string; workspace: string | null }; allowSshConfig: boolean; defaultTimeoutSec: number; sshConfigPath: string }
interface TestResult { ok: boolean; latencyMs?: number; output?: string; error?: string }
interface Draft { name: string; host: string; port: string; timeout: string; autoApprove: boolean; scope: Scope; existing: boolean }

const blankDraft = (scope: Scope = 'global'): Draft => ({ name: '', host: '', port: '22', timeout: '30', autoApprove: false, scope, existing: false });

const draftOf = (h: SshHost): Draft => ({
  name: h.name,
  host: h.host,
  port: String(h.port),
  timeout: String(h.timeout_sec),
  autoApprove: h.auto_approve,
  scope: h.source === 'workspace' ? 'workspace' : 'global',
  existing: true,
});

function resultText(r: TestResult): string {
  if (r.ok) return `Connected in ${r.latencyMs ?? 0} ms`;
  return r.error || 'Connection failed';
}

export function SshHostsDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const qc = useQueryClient();
  const home = useApp((s) => s.home);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [results, setResults] = useState<Record<string, TestResult>>({});
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['ssh'], queryFn: () => api.get<SshData>('/api/ssh'), enabled: open });
  const workspacePath = data?.paths.workspace ?? null;

  // Leaving the dialog drops half-edited hosts and stale test output.
  useEffect(() => {
    if (!open) { setDraft(null); setResults({}); }
  }, [open]);

  const test = useMutation({
    mutationFn: (v: { key: string; host: string; port: number; timeout_sec: number }) => api.post<TestResult>('/api/ssh/test', v),
    onSuccess: (r, v) => setResults((prev) => ({ ...prev, [v.key]: r })),
    onError: (e: Error, v) => setResults((prev) => ({ ...prev, [v.key]: { ok: false, error: e.message } })),
  });
  const testingKey = test.isPending ? test.variables?.key : null;

  const save = useMutation({
    mutationFn: (d: Draft) => api.put(`/api/ssh/${encodeURIComponent(d.name.trim())}`, {
      scope: d.scope,
      host: d.host.trim(),
      port: Number(d.port) || 22,
      timeout_sec: Number(d.timeout) || 30,
      auto_approve: d.autoApprove,
    }),
    onSuccess: (_r, d) => {
      toast.success(d.existing ? `Updated ${d.name}` : `Added ${d.name}`);
      setDraft(null);
      void qc.invalidateQueries({ queryKey: ['ssh'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: (h: SshHost) => api.del(`/api/ssh/${encodeURIComponent(h.name)}?scope=${h.source === 'workspace' ? 'workspace' : 'global'}`),
    onSuccess: (_r, h) => {
      toast.success(`Removed ${h.name}`);
      setResults((prev) => { const next = { ...prev }; delete next[h.name]; return next; });
      void qc.invalidateQueries({ queryKey: ['ssh'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggleImport = useMutation({
    mutationFn: (allow: boolean) => api.put('/api/ssh', { allowSshConfig: allow }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['ssh'] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const hosts = data?.hosts ?? [];
  const defaultScope: Scope = workspacePath ? 'workspace' : 'global';
  const draftKey = 'draft';
  const draftResult = results[draftKey];

  const clearResult = (key: string) => setResults((prev) => { const next = { ...prev }; delete next[key]; return next; });
  const editRow = (h: SshHost) => { clearResult(draftKey); setDraft(draftOf(h)); };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="md:w-[min(680px,calc(100vw-32px))]">
        <DialogHeader>
          <DialogTitle>SSH hosts</DialogTitle>
          <DialogDescription>
            Remote machines the agent can run commands on and copy files to. The same list the CLI uses.
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          {draft ? (
            <div className="grid gap-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-semibold">{draft.existing ? `Edit ${draft.name}` : 'New host'}</span>
                <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>Back to list</Button>
              </div>

              <Field label="Name" htmlFor="ssh-name" hint={draft.existing ? 'The name is the key; delete and re-add to rename it.' : 'How you and the agent refer to it, e.g. devbox.'}>
                <Input id="ssh-name" autoFocus={!draft.existing} value={draft.name} disabled={draft.existing} spellCheck={false}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="devbox" className="font-mono text-[13px]" />
              </Field>

              <div className="grid grid-cols-[minmax(0,1fr)_96px] gap-3 max-sm:grid-cols-1">
                <Field label="Host" htmlFor="ssh-host" hint="user@host, or a Host alias from your ssh config.">
                  <Input id="ssh-host" value={draft.host} spellCheck={false} onChange={(e) => setDraft({ ...draft, host: e.target.value })}
                    placeholder="marcus@192.168.1.100" className="font-mono text-[13px]" />
                </Field>
                <Field label="Port" htmlFor="ssh-port">
                  <Input id="ssh-port" value={draft.port} inputMode="numeric" onChange={(e) => setDraft({ ...draft, port: e.target.value.replace(/\D/g, '') })} className="font-mono text-[13px]" />
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
                <Field label="Save in" hint={draft.existing ? 'Move a host by deleting it and adding it in the other scope.' : undefined}>
                  <Select value={draft.scope} onValueChange={(v) => setDraft({ ...draft, scope: v as Scope })} disabled={draft.existing}>
                    <SelectTrigger aria-label="Config file"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="workspace" disabled={!workspacePath}>This workspace</SelectItem>
                      <SelectItem value="global">Global</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Connect timeout (s)" htmlFor="ssh-timeout">
                  <Input id="ssh-timeout" value={draft.timeout} inputMode="numeric" onChange={(e) => setDraft({ ...draft, timeout: e.target.value.replace(/\D/g, '') })} className="font-mono text-[13px]" />
                </Field>
              </div>

              <label className="flex items-start gap-3 rounded-xl border border-line bg-sunken p-3">
                <Switch checked={draft.autoApprove} onCheckedChange={(v) => setDraft({ ...draft, autoApprove: v })} className="mt-0.5" />
                <span className="grid gap-0.5">
                  <span className="font-medium">Run without asking</span>
                  <span className="text-[13px] text-dim">Commands on this host skip the confirmation prompt. Only for machines you trust.</span>
                </span>
              </label>

              {draftResult ? (
                <p role="status" className={cn('m-0 break-words font-mono text-[12.5px]', draftResult.ok ? 'text-accent' : 'text-danger')}>{resultText(draftResult)}</p>
              ) : null}
            </div>
          ) : error ? (
            <div className="grid gap-2 rounded-xl border border-danger/40 bg-danger/5 p-3">
              <p role="alert" className="m-0 break-words text-[13px] text-danger">
                Could not load the host list: {error.message}
              </p>
              <p className="m-0 text-[12.5px] text-dim">
                The server does not know this route yet. Restart <span className="font-mono">shmakk --web</span> and open this again.
              </p>
              <div>
                <Button size="sm" variant="default" onClick={() => void refetch()}>Try again</Button>
              </div>
            </div>
          ) : isLoading || !data ? (
            <div className="flex h-20 animate-pulse items-center justify-center rounded-xl border border-line bg-sunken text-[12.5px] text-faint">
              Loading hosts…
            </div>
          ) : (
            <div className="grid gap-3">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[10.5px] font-semibold uppercase tracking-wider text-faint">
                  {hosts.length} {hosts.length === 1 ? 'host' : 'hosts'}
                </span>
                <Button size="sm" variant="primary" onClick={() => { clearResult(draftKey); setDraft(blankDraft(defaultScope)); }}>
                  <Plus />Add host
                </Button>
              </div>

              {hosts.length === 0 ? (
                <p className="m-0 rounded-xl border border-dashed border-line px-3 py-6 text-center text-[13px] text-dim">
                  No hosts yet. Add one to let the agent run commands elsewhere.
                </p>
              ) : (
                <div className="divide-y divide-line overflow-hidden rounded-xl border border-line">
                  {hosts.map((h) => {
                    const r = results[h.name];
                    return (
                      <div key={h.name} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
                        <Server className="size-4 shrink-0 text-faint" aria-hidden />
                        <div className="min-w-0 flex-1 basis-[55%]">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="truncate font-mono text-[13px] font-semibold">{h.name}</span>
                            <Badge tone={h.source === 'workspace' ? 'info' : h.source === 'config' ? 'neutral' : 'violet'}>
                              {h.source === 'workspace' ? 'this workspace' : h.source === 'global' ? 'global' : 'ssh config'}
                            </Badge>
                            {h.auto_approve ? <Badge tone="warn">auto-approve</Badge> : null}
                          </div>
                          <div className="truncate font-mono text-[12px] text-dim">{h.host}:{h.port}</div>
                          {r ? <div className={cn('break-words text-[12px]', r.ok ? 'text-accent' : 'text-danger')}>{resultText(r)}</div> : null}
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <Button size="sm" variant="ghost" disabled={testingKey === h.name}
                            onClick={() => test.mutate({ key: h.name, host: h.host, port: h.port, timeout_sec: h.timeout_sec })}>
                            {testingKey === h.name ? <Loader2 className="animate-spin" /> : <Terminal />}Test
                          </Button>
                          {h.editable ? (
                            <>
                              <Tip label="Edit"><Button size="icon-sm" variant="ghost" aria-label={`Edit ${h.name}`} onClick={() => editRow(h)}><Pencil /></Button></Tip>
                              <Tip label="Delete">
                                <Button size="icon-sm" variant="ghost" aria-label={`Delete ${h.name}`} disabled={remove.isPending}
                                  onClick={() => { if (confirm(`Remove the SSH host ${h.name}?`)) remove.mutate(h); }}><Trash2 /></Button>
                              </Tip>
                            </>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <label className="flex items-start gap-3 rounded-xl border border-line bg-sunken p-3">
                <Switch checked={data.allowSshConfig} onCheckedChange={(v) => toggleImport.mutate(v)} className="mt-0.5" />
                <span className="grid gap-0.5">
                  <span className="font-medium">Also read hosts from your ssh config</span>
                  <span className="break-all font-mono text-[12px] text-dim">{tildify(data.sshConfigPath, home)}</span>
                </span>
              </label>

              <div className="grid gap-1 text-[12px] text-faint">
                <span className="break-all font-mono">global · {tildify(data.paths.global, home)}</span>
                {data.paths.workspace ? <span className="break-all font-mono">workspace · {tildify(data.paths.workspace, home)}</span> : null}
              </div>
            </div>
          )}
        </DialogBody>

        {draft ? (
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
            <Button variant="default" disabled={!draft.host.trim() || testingKey === draftKey}
              onClick={() => test.mutate({ key: draftKey, host: draft.host.trim(), port: Number(draft.port) || 22, timeout_sec: Number(draft.timeout) || 30 })}>
              {testingKey === draftKey ? <Loader2 className="animate-spin" /> : <Terminal />}Test connection
            </Button>
            <Button variant="primary" disabled={save.isPending || !draft.name.trim() || !draft.host.trim()} onClick={() => save.mutate(draft)}>
              {save.isPending ? <Loader2 className="animate-spin" /> : null}Save host
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

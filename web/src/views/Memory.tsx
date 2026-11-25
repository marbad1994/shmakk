import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { tildify } from '@/lib/utils';
import { useApp } from '@/store/app';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Loading, Page, Section } from './Page';

interface Doc { status: { globalPath: string; workspacePath: string }; global: string; workspace: string }
type Scope = 'workspace' | 'global';

function Editor({ kind, scope, doc }: { kind: 'memory' | 'rules'; scope: Scope; doc: Doc }) {
  const qc = useQueryClient();
  const home = useApp((s) => s.home);
  const saved = doc[scope];
  const [text, setText] = useState(saved);
  useEffect(() => setText(saved), [saved]);
  const save = useMutation({
    mutationFn: () => api.put(`/api/${kind}`, { scope, content: text }),
    onSuccess: () => { toast.success('Saved'); void qc.invalidateQueries({ queryKey: [kind] }); },
    onError: (e: Error) => toast.error(e.message),
  });
  const path = scope === 'global' ? doc.status.globalPath : doc.status.workspacePath;
  return (
    <div className="grid gap-2">
      <Textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} aria-label={`${scope} ${kind}`}
        placeholder={kind === 'memory' ? '## Preferences\n- Uses pnpm, not npm' : '- Always write tests for new functions\n- Never commit directly to main'} className="min-h-72" />
      <div className="flex items-center gap-3">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-faint">{tildify(path, home)}</span>
        {text !== saved ? <Button variant="ghost" size="sm" onClick={() => setText(saved)}>Discard</Button> : null}
        <Button variant="primary" size="sm" disabled={text === saved || save.isPending} onClick={() => save.mutate()}>Save</Button>
      </div>
    </div>
  );
}

function ScopedEditors({ kind }: { kind: 'memory' | 'rules' }) {
  const { data } = useQuery({ queryKey: [kind], queryFn: () => api.get<Doc>(`/api/${kind}`) });
  if (!data) return <Loading />;
  return (
    <Tabs defaultValue="workspace" className="grid gap-3">
      <TabsList className="justify-self-start"><TabsTrigger value="workspace">This workspace</TabsTrigger><TabsTrigger value="global">Global</TabsTrigger></TabsList>
      <TabsContent value="workspace"><Editor kind={kind} scope="workspace" doc={data} /></TabsContent>
      <TabsContent value="global"><Editor kind={kind} scope="global" doc={data} /></TabsContent>
    </Tabs>
  );
}

export function MemoryView() {
  const qc = useQueryClient();
  const [fact, setFact] = useState('');
  const [category, setCategory] = useState('Notes');
  const [scope, setScope] = useState<Scope>('workspace');
  const [pattern, setPattern] = useState('');
  const done = () => qc.invalidateQueries({ queryKey: ['memory'] });
  const add = useMutation({
    mutationFn: () => api.post('/api/memory/add', { fact, category, scope }),
    onSuccess: () => { toast.success('Remembered'); setFact(''); void done(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const forget = useMutation({
    mutationFn: () => api.post<{ removed: number }>('/api/memory/forget', { pattern }),
    onSuccess: (r) => { toast(r.removed ? `Forgot ${r.removed} entr${r.removed === 1 ? 'y' : 'ies'}` : 'Nothing matched'); setPattern(''); void done(); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Page lead="Memory is what shmakk has learned about you and this project; rules are instructions it must always follow. Both are plain Markdown files injected into every request.">
      <Tabs defaultValue="memory" className="grid gap-5">
        <TabsList className="justify-self-start"><TabsTrigger value="memory">Memory</TabsTrigger><TabsTrigger value="rules">Rules</TabsTrigger></TabsList>

        <TabsContent value="memory" className="grid gap-5.5">
          <Section title="Remember something">
            <form className="grid grid-cols-[1fr_150px_150px_auto] items-end gap-2 max-md:grid-cols-1" onSubmit={(e) => { e.preventDefault(); if (fact.trim()) add.mutate(); }}>
              <Field label="Fact" htmlFor="mem-fact"><Input id="mem-fact" value={fact} onChange={(e) => setFact(e.target.value)} placeholder="The staging database is read-only" /></Field>
              <Field label="Category" htmlFor="mem-cat"><Input id="mem-cat" value={category} onChange={(e) => setCategory(e.target.value)} /></Field>
              <Field label="Scope">
                <Select value={scope} onValueChange={(v) => setScope(v as Scope)}>
                  <SelectTrigger aria-label="Scope"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="workspace">Workspace</SelectItem><SelectItem value="global">Global</SelectItem></SelectContent>
                </Select>
              </Field>
              <Button type="submit" variant="primary" disabled={!fact.trim() || add.isPending}>Remember</Button>
            </form>
          </Section>
          <Section title="Stored memory"><ScopedEditors kind="memory" /></Section>
          <Section title="Forget">
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (pattern.trim()) forget.mutate(); }}>
              <Input value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="Remove every entry containing…" aria-label="Forget pattern" />
              <Button type="submit" variant="danger" disabled={!pattern.trim() || forget.isPending}>Forget</Button>
            </form>
          </Section>
        </TabsContent>

        <TabsContent value="rules"><Section title="Rule files"><ScopedEditors kind="rules" /></Section></TabsContent>
      </Tabs>
    </Page>
  );
}

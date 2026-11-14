import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plug, RotateCw } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { tildify } from '@/lib/utils';
import { useApp } from '@/store/app';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { Empty } from '@/components/ui/misc';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Loading, Page, Row, Rows, Section } from './Page';

interface Server { name: string; source: string; command: string; disabled: boolean; safety: string | null; safeTools: string[]; env: string[]; live: { connected?: boolean; tools?: number; toolCount?: number } | null }
interface McpData { paths: { global: string; workspace: string }; raw: { global: string; workspace: string }; toolCount: number; servers: Server[]; tools: { name: string; description: string }[] }
type Scope = 'global' | 'workspace';
const TEMPLATE = '{\n  "mcpServers": {\n    "example": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-everything"] }\n  }\n}\n';

function ConfigEditor({ scope, data }: { scope: Scope; data: McpData }) {
  const qc = useQueryClient();
  const home = useApp((s) => s.home);
  const refreshStatus = useApp((s) => s.refreshStatus);
  const saved = data.raw[scope];
  const [text, setText] = useState(saved);
  useEffect(() => setText(saved), [saved]);
  const save = useMutation({
    mutationFn: () => api.put('/api/mcp', { scope, content: text || '{}' }),
    onSuccess: () => { toast.success('Saved — servers restarted'); void qc.invalidateQueries({ queryKey: ['mcp'] }); void refreshStatus(); },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <div className="grid gap-2">
      <Textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} placeholder={TEMPLATE} aria-label={`${scope} MCP config`} className="min-h-56" />
      <div className="flex items-center gap-3">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-faint">{tildify(data.paths[scope], home)}</span>
        {!text ? <Button variant="ghost" size="sm" onClick={() => setText(TEMPLATE)}>Insert template</Button> : null}
        <Button variant="primary" size="sm" disabled={text === saved || save.isPending} onClick={() => save.mutate()}>Save &amp; restart</Button>
      </div>
    </div>
  );
}

export function McpView() {
  const qc = useQueryClient();
  const refreshStatus = useApp((s) => s.refreshStatus);
  const { data, isLoading } = useQuery({ queryKey: ['mcp'], queryFn: () => api.get<McpData>('/api/mcp') });
  const restart = useMutation({
    mutationFn: () => api.post('/api/mcp/restart'),
    onSuccess: () => { toast.success('MCP servers restarted'); void qc.invalidateQueries({ queryKey: ['mcp'] }); void refreshStatus(); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Page
      lead="Model Context Protocol servers give the agent extra tools — databases, issue trackers, browsers. Workspace config overrides global."
      actions={<Button size="sm" onClick={() => restart.mutate()} disabled={restart.isPending}><RotateCw className={restart.isPending ? 'animate-spin' : undefined} />Restart servers</Button>}
    >
      <Section title="Servers" aside={data ? <span className="font-mono text-xs text-faint">{data.toolCount} tools live</span> : null}>
        {isLoading || !data ? <Loading /> : data.servers.length === 0 ? (
          <Empty icon={<Plug />} title="No MCP servers configured">Add one in the configuration below.</Empty>
        ) : (
          <Rows>
            {data.servers.map((s) => {
              const tools = data.tools.filter((t) => t.name.startsWith(`mcp__${s.name}__`));
              return (
                <Row key={s.name} className="flex-col items-stretch gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-semibold">{s.name}</span>
                    <Badge>{s.source}</Badge>
                    {s.disabled ? <Badge tone="warn">disabled</Badge> : s.live ? <Badge tone="ok">connected · {tools.length} tools</Badge> : <Badge tone="danger">not running</Badge>}
                    {s.safety ? <Badge tone="info">safety: {s.safety}</Badge> : null}
                  </div>
                  <code className="break-all font-mono text-[12.5px] text-dim">{s.command}</code>
                  {tools.length ? <div className="flex flex-wrap gap-1.5">{tools.map((t) => <span key={t.name} title={t.description} className="rounded-md border border-line bg-sunken px-1.5 py-px font-mono text-[11.5px] text-dim">{t.name.split('__').slice(2).join('__')}</span>)}</div> : null}
                </Row>
              );
            })}
          </Rows>
        )}
      </Section>

      <Section title="Configuration">
        {data ? (
          <Tabs defaultValue="global" className="grid gap-3">
            <TabsList className="justify-self-start"><TabsTrigger value="global">Global</TabsTrigger><TabsTrigger value="workspace">This workspace</TabsTrigger></TabsList>
            <TabsContent value="global"><ConfigEditor scope="global" data={data} /></TabsContent>
            <TabsContent value="workspace"><ConfigEditor scope="workspace" data={data} /></TabsContent>
          </Tabs>
        ) : <Loading />}
      </Section>
    </Page>
  );
}

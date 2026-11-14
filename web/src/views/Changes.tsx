import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileDiff, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { relTime } from '@/lib/utils';
import { useApp } from '@/store/app';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty } from '@/components/ui/misc';
import { Diff } from '@/components/chat/Diff';
import { Loading, Page } from './Page';

interface Edit { index: number; path: string; tool: string; created: boolean; timestamp: number; diff: string | null }

export function ChangesView() {
  const qc = useQueryClient();
  const refreshStatus = useApp((s) => s.refreshStatus);
  const { data, isLoading } = useQuery({ queryKey: ['edits'], queryFn: () => api.get<{ edits: Edit[] }>('/api/edits'), refetchInterval: 5000 });
  const after = () => { void qc.invalidateQueries({ queryKey: ['edits'] }); void refreshStatus(); };
  const revert = useMutation({
    mutationFn: (i: number) => api.post(`/api/edits/${i}/revert`),
    onSuccess: () => { toast.success('Reverted'); after(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const clear = useMutation({ mutationFn: () => api.del('/api/edits'), onSuccess: after });
  const edits = [...(data?.edits || [])].reverse();

  return (
    <Page
      lead="Every file the agent wrote or edited since shmakk started, newest first. Revert restores the content from just before that edit."
      actions={edits.length ? <Button variant="ghost" size="sm" onClick={() => clear.mutate()}>Clear list</Button> : null}
    >
      {isLoading ? <Loading /> : edits.length === 0 ? (
        <Empty icon={<FileDiff />} title="No changes yet">When shmakk edits files, the diffs collect here for review.</Empty>
      ) : edits.map((e) => (
        <article key={e.index} className="grid gap-2">
          <header className="flex items-center gap-2">
            <Badge tone={e.created ? 'ok' : 'info'}>{e.created ? 'created' : e.tool === 'edit_file' ? 'edited' : 'rewritten'}</Badge>
            <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{e.path}</span>
            <span className="text-xs text-faint">{relTime(e.timestamp)}</span>
            <Button size="sm" onClick={() => revert.mutate(e.index)} disabled={revert.isPending}><Undo2 />Revert</Button>
          </header>
          {e.diff ? <Diff diff={e.diff} maxHeight={520} /> : <p className="m-0 text-[13px] text-faint">No textual difference.</p>}
        </article>
      ))}
    </Page>
  );
}

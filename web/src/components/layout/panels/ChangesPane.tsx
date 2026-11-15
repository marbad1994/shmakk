import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, FileDiff, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { cn, relTime } from '@/lib/utils';
import { useApp } from '@/store/app';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, Spinner } from '@/components/ui/misc';
import { Diff } from '@/components/chat/Diff';

interface Edit { index: number; path: string; tool: string; created: boolean; timestamp: number; diff: string | null }

/** Everything the agent changed this session, newest first, with inline diffs. */
export function ChangesPane() {
  const qc = useQueryClient();
  const refreshStatus = useApp((s) => s.refreshStatus);
  const [open, setOpen] = useState<number | null>(null);
  const { data, isLoading } = useQuery({ queryKey: ['edits'], queryFn: () => api.get<{ edits: Edit[] }>('/api/edits'), refetchInterval: 5000 });
  const after = () => { void qc.invalidateQueries({ queryKey: ['edits'] }); void refreshStatus(); };
  const revert = useMutation({
    mutationFn: (index: number) => api.post(`/api/edits/${index}/revert`),
    onSuccess: () => toast.success('Reverted'),
    onError: (e: Error) => toast.error(e.message),
    onSettled: after,
  });
  const edits = [...(data?.edits || [])].reverse();

  if (isLoading) return <div className="grid h-full place-items-center"><Spinner className="size-5" /></div>;
  if (edits.length === 0) {
    return <div className="p-4"><Empty icon={<FileDiff />} title="No changes yet">Files the agent writes or edits show up here, with a revert per change.</Empty></div>;
  }

  return (
    <ul className="m-0 flex h-full list-none flex-col gap-0.5 overflow-y-auto p-2">
      {edits.map((e) => (
        <li key={e.index}>
          <div className="flex items-center gap-1.5 rounded-lg px-1.5 py-1 hover:bg-hover">
            <button type="button" aria-expanded={open === e.index} onClick={() => setOpen(open === e.index ? null : e.index)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
              <ChevronRight className={cn('size-3.5 shrink-0 text-faint transition-transform', open === e.index && 'rotate-90')} />
              <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{e.path}</span>
              <Badge tone={e.created ? 'ok' : 'info'}>{e.created ? 'created' : e.tool === 'edit_file' ? 'edited' : 'rewritten'}</Badge>
              <span className="shrink-0 text-[11px] text-faint">{relTime(e.timestamp)}</span>
            </button>
            <Button variant="ghost" size="icon-sm" aria-label={`Revert changes to ${e.path}`} disabled={revert.isPending} onClick={() => revert.mutate(e.index)}><Undo2 /></Button>
          </div>
          {open === e.index ? (
            <div className="px-1.5 pb-2 pt-1">
              {e.diff ? <Diff diff={e.diff} maxHeight={320} /> : <p className="m-0 px-1 text-[12.5px] text-faint">No textual difference.</p>}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

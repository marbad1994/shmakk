import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CornerLeftUp, Folder } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { tildify } from '@/lib/utils';
import { useApp } from '@/store/app';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/misc';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

interface Listing { path: string; parent: string | null; entries: { name: string; dir: boolean }[] }

/** Server-side folder browser (the browser can't hand us real paths). */
export function FolderPicker() {
  const open = useApp((s) => s.folderPickerOpen);
  const setOpen = useApp((s) => s.setFolderPicker);
  const workspace = useApp((s) => s.workspace);
  const home = useApp((s) => s.home);
  const recent = useApp((s) => s.settings.recentWorkspaces) || [];
  const setWorkspace = useApp((s) => s.setWorkspace);
  const [path, setPath] = useState(workspace);
  const [typed, setTyped] = useState(workspace);

  useEffect(() => { if (open) { setPath(workspace); setTyped(workspace); } }, [open, workspace]);
  const { data, isFetching, error } = useQuery({
    queryKey: ['fs', path],
    queryFn: () => api.get<Listing>(`/api/fs/list?dirs=1&path=${encodeURIComponent(path)}`),
    enabled: open,
  });
  useEffect(() => { if (data) setTyped(data.path); }, [data]);

  const choose = async (p: string) => {
    try { await setWorkspace(p); setOpen(false); } catch (e) { toast.error((e as Error).message); }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="w-[min(640px,calc(100vw-32px))]">
        <DialogHeader>
          <DialogTitle>Switch workspace</DialogTitle>
          <DialogDescription>shmakk can only read and change files inside the workspace you pick.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setPath(typed); }}>
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} className="font-mono text-[13px]" aria-label="Folder path" spellCheck={false} />
            <Button type="submit">Go</Button>
          </form>
          {recent.length > 1 ? (
            <div className="flex flex-wrap gap-1.5">
              {recent.filter((r) => r !== workspace).slice(0, 5).map((r) => (
                <button key={r} type="button" onClick={() => void choose(r)} className="rounded-full border border-line px-2.5 py-0.5 font-mono text-xs text-dim hover:bg-hover hover:text-fg">{tildify(r, home)}</button>
              ))}
            </div>
          ) : null}
          <div className="max-h-[40vh] min-h-40 overflow-y-auto rounded-[10px] border border-line bg-sunken">
            {error ? <p className="p-3 text-[13px] text-danger">{(error as Error).message}</p> : null}
            {isFetching && !data ? <div className="grid place-items-center p-6"><Spinner /></div> : null}
            {data?.parent ? (
              <button type="button" onClick={() => setPath(data.parent!)} className="flex w-full items-center gap-2.5 border-b border-line px-3 py-1.5 text-left font-mono text-[13px] text-dim hover:bg-hover"><CornerLeftUp className="size-4" />..</button>
            ) : null}
            {data?.entries.map((e) => (
              <button key={e.name} type="button" onClick={() => setPath(`${data.path.replace(/\/$/, '')}/${e.name}`)} className="flex w-full items-center gap-2.5 border-b border-line px-3 py-1.5 text-left font-mono text-[13px] last:border-b-0 hover:bg-hover">
                <Folder className="size-4 text-accent" />{e.name}
              </button>
            ))}
            {data && data.entries.length === 0 ? <p className="p-3 text-[13px] text-faint">No sub-folders here.</p> : null}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="primary" disabled={!data} onClick={() => data && void choose(data.path)}>Use this folder</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

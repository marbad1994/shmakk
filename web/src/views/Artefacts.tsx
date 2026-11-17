import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Boxes, Code2, ExternalLink, File, FileText, FileUp, FolderOpen, Image as ImageIcon,
  MessageSquare, MoreHorizontal, Pencil, Plus, Search, SquarePen, Trash2, X, Copy,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { bytes, copyText, relTime } from '@/lib/utils';
import { modeInfo } from '@/lib/modes';
import { useApp } from '@/store/app';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/input';
import { Empty, Segmented } from '@/components/ui/misc';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Markdown } from '@/components/chat/Markdown';
import { Loading, Page, Row, Rows } from './Page';
import type { Artefact, ConvSnapshot, Mode } from '@/lib/types';

// ── presentation ────────────────────────────────────────────────────────

function iconFor(a: { mimeType: string; relPath: string; name: string }) {
  const mime = a.mimeType || '';
  const ext = (a.relPath || a.name).split('.').pop()?.toLowerCase() || '';
  if (mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg'].includes(ext)) return <ImageIcon />;
  if (mime === 'text/markdown' || ['md', 'mdx', 'markdown', 'txt'].includes(ext)) return <FileText />;
  if (mime.startsWith('text/') || /javascript|typescript|python|ruby|go|rust|java|c\+\+|csharp|shellscript|sql|html|css|json|xml|yaml|toml/.test(mime) || ['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'swift', 'kt', 'sh', 'fish', 'zsh', 'bash', 'sql', 'html', 'css', 'scss', 'less', 'json', 'yml', 'yaml', 'toml'].includes(ext)) return <Code2 />;
  return <File />;
}

function preview(a: Artefact) {
  const content = a.content ?? '';
  if (content.startsWith('data:')) return <img src={content} alt={a.name} className="max-h-96 w-auto rounded-xl border border-line" />;
  if (a.mimeType?.startsWith('image/') && a.binary) return <img src={`data:${a.mimeType};base64,${content}`} alt={a.name} className="max-h-96 w-auto rounded-xl border border-line" />;
  if (a.mimeType === 'image/svg+xml' && !a.binary) return <img src={`data:image/svg+xml;utf8,${encodeURIComponent(content)}`} alt={a.name} className="max-h-96 w-auto rounded-xl border border-line" />;
  if (a.mimeType === 'text/markdown' || /\.mdx?$/.test(a.relPath)) return <Markdown text={content} />;
  if (a.binary) return <p className="text-dim">Binary file — open it to view it outside shmakk.</p>;
  return <pre className="scroll-touch m-0 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-line bg-sunken p-3.5 font-mono text-[12.5px] leading-relaxed">{content}</pre>;
}

// ── dialogs ─────────────────────────────────────────────────────────────

function NewDialog({ open, onOpenChange }: { open: boolean; onOpenChange(o: boolean): void }) {
  const mode = useApp((s) => s.mode);
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [content, setContent] = useState('');
  const create = useMutation({
    mutationFn: () => api.post('/api/artefacts', { name: name.trim(), note: note.trim() || null, content, mimeType: 'text/markdown', mode }),
    onSuccess: () => { toast.success('Artefact saved'); setName(''); setNote(''); setContent(''); onOpenChange(false); void qc.invalidateQueries({ queryKey: ['artefacts'] }); },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="md:w-[min(640px,calc(100vw-32px))]">
        <form className="flex min-h-0 flex-col" onSubmit={(e) => { e.preventDefault(); if (name.trim() && content.trim()) create.mutate(); }}>
          <DialogHeader><DialogTitle>New artefact</DialogTitle><DialogDescription>Save a snippet of text, code or notes into your cross-workspace vault.</DialogDescription></DialogHeader>
          <DialogBody>
            <Field label="Name" htmlFor="art-name"><Input id="art-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="release-notes.md" autoCapitalize="off" spellCheck={false} /></Field>
            <Field label="Note" htmlFor="art-note"><Input id="art-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What is this and where did it come from?" /></Field>
            <Field label="Contents" htmlFor="art-content"><Textarea id="art-content" value={content} onChange={(e) => setContent(e.target.value)} className="min-h-48" placeholder="Paste the text or code…" /></Field>
          </DialogBody>
          <DialogFooter><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" type="submit" disabled={!name.trim() || !content.trim() || create.isPending}>{create.isPending ? 'Saving…' : 'Save'}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditDialog({ art, onOpenChange }: { art: Artefact | null; onOpenChange(o: boolean): void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(art?.name ?? '');
  const [note, setNote] = useState(art?.note ?? '');
  const update = useMutation({
    mutationFn: () => api.patch(`/api/artefacts/${art!.id}`, { name: name.trim(), note: note.trim() || null }),
    onSuccess: () => { toast.success('Artefact updated'); onOpenChange(false); void qc.invalidateQueries({ queryKey: ['artefacts'] }); },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog open={!!art} onOpenChange={onOpenChange}>
      <DialogContent>
        <form className="flex min-h-0 flex-col" onSubmit={(e) => { e.preventDefault(); if (name.trim()) update.mutate(); }}>
          <DialogHeader><DialogTitle>Edit artefact</DialogTitle><DialogDescription>Rename it or adjust its note.</DialogDescription></DialogHeader>
          <DialogBody>
            <Field label="Name" htmlFor="art-edit-name"><Input id="art-edit-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Note" htmlFor="art-edit-note"><Input id="art-edit-note" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          </DialogBody>
          <DialogFooter><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" type="submit" disabled={!name.trim() || update.isPending}>{update.isPending ? 'Saving…' : 'Save'}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DiscussDialog({ art, onOpenChange }: { art: Artefact | null; onOpenChange(o: boolean): void }) {
  const openConv = useApp((s) => s.openConv);
  const [text, setText] = useState('');
  const discuss = useMutation({
    mutationFn: () => api.post<ConvSnapshot>(`/api/artefacts/${art!.id}/discuss`, { text: text.trim() }),
    onSuccess: (snap) => { onOpenChange(false); void openConv(snap.id); },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog open={!!art} onOpenChange={onOpenChange}>
      <DialogContent>
        <form className="flex min-h-0 flex-col" onSubmit={(e) => { e.preventDefault(); if (text.trim()) discuss.mutate(); }}>
          <DialogHeader><DialogTitle>Discuss this artefact</DialogTitle><DialogDescription>Ask a question about <span className="font-mono">{art?.name}</span>. It starts a new chat with the file attached.</DialogDescription></DialogHeader>
          <DialogBody>
            <Field label="Question" htmlFor="art-discuss"><Textarea id="art-discuss" autoFocus value={text} onChange={(e) => setText(e.target.value)} className="min-h-28 font-sans" placeholder="Summarise this file, explain a part of it, suggest improvements…" /></Field>
          </DialogBody>
          <DialogFooter><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" type="submit" disabled={!text.trim() || discuss.isPending}>{discuss.isPending ? 'Starting…' : 'Ask'}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── main view ───────────────────────────────────────────────────────────

export function ArtefactsView() {
  const mode = useApp((s) => s.mode);
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);

  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | Mode>('all');
  const [creating, setCreating] = useState(false);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Artefact | null>(null);
  const [discussing, setDiscussing] = useState<Artefact | null>(null);

  const list = useQuery({ queryKey: ['artefacts'], queryFn: () => api.get<{ artefacts: Artefact[] }>('/api/artefacts').then((r) => r.artefacts) });
  const detail = useQuery({ queryKey: ['artefact', viewingId], queryFn: () => api.get<Artefact>(`/api/artefacts/${viewingId}`), enabled: !!viewingId });

  const create = useMutation({
    mutationFn: (body: { name: string; content: string; mimeType: string }) => api.post('/api/artefacts', { ...body, mode }),
    onSuccess: () => { toast.success('Artefact saved'); void qc.invalidateQueries({ queryKey: ['artefacts'] }); },
    onError: (e: Error) => toast.error(e.message),
  });
  const open = useMutation({
    mutationFn: (id: string) => api.post(`/api/artefacts/${id}/open`),
    onSuccess: () => toast.success('Opened in your default app'),
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/artefacts/${id}`),
    onSuccess: () => { toast.success('Artefact deleted'); setViewingId(null); void qc.invalidateQueries({ queryKey: ['artefacts'] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let out = list.data ?? [];
    if (filter !== 'all') out = out.filter((a) => a.mode === filter);
    if (needle) out = out.filter((a) => `${a.name} ${a.relPath} ${a.note || ''}`.toLowerCase().includes(needle));
    return out;
  }, [list.data, q, filter]);

  const onFile = (f?: File) => {
    if (!f) return;
    const reader = new FileReader();
    if (f.type.startsWith('image/')) {
      reader.onload = () => create.mutate({ name: f.name, content: String(reader.result), mimeType: f.type });
      reader.readAsDataURL(f);
    } else {
      reader.onload = () => create.mutate({ name: f.name, content: String(reader.result), mimeType: f.type || 'text/plain' });
      reader.readAsText(f);
    }
  };

  const menu = (a: Artefact) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button size="icon-sm" aria-label={`${a.name} — actions`}><MoreHorizontal /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem onSelect={() => open.mutate(a.id)} disabled={!a.path}><ExternalLink />Open file</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setDiscussing(a)}><MessageSquare />Discuss</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setEditing(a)}><Pencil />Edit name &amp; note</DropdownMenuItem>
        <DropdownMenuItem
          disabled={!a.path}
          onSelect={() => { if (a.path) void copyText(a.path).then((ok) => (ok ? toast('File path copied') : toast.error('Could not copy the path'))); }}
        >
          <Copy />Copy file path
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem danger onSelect={() => remove.mutate(a.id)}><Trash2 />Delete</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const current = detail.data;

  return (
    <Page>
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" className="rounded-full bg-fg text-bg hover:bg-fg/90 hover:border-transparent" onClick={() => setCreating(true)}><Plus />New artefact</Button>
          <Button size="sm" className="rounded-full" onClick={() => fileRef.current?.click()}><FileUp />Add file</Button>
        </div>
        <input ref={fileRef} type="file" hidden onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
      </div>

      <div className="grid gap-1.5">
        <h2 className="m-0 text-[28px] font-semibold tracking-tight max-md:text-2xl">Artefacts</h2>
        <p className="m-0 text-[15px] text-dim">Files shmakk made that are not part of any project, kept together across every workspace. Open one, keep talking about it, or file it away.</p>
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-4 top-1/2 size-4.5 -translate-y-1/2 text-faint" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search artefacts" aria-label="Search artefacts" className="h-12 rounded-full pl-11 text-[15px] touch:h-12" />
        {q ? <button type="button" aria-label="Clear search" onClick={() => setQ('')} className="absolute right-3 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-full text-faint hover:bg-hover hover:text-fg"><X className="size-4" /></button> : null}
      </div>

      <Segmented<'all' | Mode>
        label="Filter by mode"
        value={filter}
        onChange={setFilter}
        options={[{ value: 'all', label: 'All' }, { value: 'chat', label: 'Chat' }, { value: 'code', label: 'Code' }, { value: 'design', label: 'Design' }, { value: 'cowork', label: 'Cowork' }]}
      />

      {list.isLoading ? <Loading /> : items.length === 0 ? (
        <Empty icon={<Boxes />} title={list.data?.length ? 'No artefacts match' : 'No artefacts yet'}>
          {list.data?.length
            ? 'Try a different search or filter.'
            : <>Save a file with <strong>New artefact</strong> or <strong>Add file</strong>. Files the AI creates outside the project land here automatically.</>}
        </Empty>
      ) : (
        <Rows>
          {items.map((a) => (
            <Row key={a.id} className="gap-3.5">
              <button type="button" onClick={() => setViewingId(a.id)} className="flex min-w-0 flex-1 items-center gap-3.5 text-left touch:min-h-12" aria-label={`${a.name} — details`}>
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-sunken text-dim [&_svg]:size-5">{iconFor(a)}</span>
                <span className="grid min-w-0 gap-px">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-semibold">{a.name}</span>
                    <Badge tone={modeInfo(a.mode).id === 'chat' ? 'info' : modeInfo(a.mode).id === 'design' ? 'violet' : modeInfo(a.mode).id === 'cowork' ? 'warn' : 'ok'}>{modeInfo(a.mode).label}</Badge>
                  </span>
                  <span className="truncate text-[13px] text-dim">
                    {a.note || (a.path ? '' : 'no file on disk')}
                  </span>
                </span>
              </button>
              <span className="hidden shrink-0 text-[12px] font-medium text-faint sm:block">{bytes(a.size)}</span>
              <span className="hidden shrink-0 text-[12px] text-faint md:block">{relTime(a.updatedAt)}</span>
              {menu(a)}
            </Row>
          ))}
        </Rows>
      )}

      <NewDialog open={creating} onOpenChange={setCreating} />
      <EditDialog art={editing} onOpenChange={(o) => { if (!o) setEditing(null); }} />
      <DiscussDialog art={discussing} onOpenChange={(o) => { if (!o) setDiscussing(null); }} />

      <Dialog open={!!viewingId} onOpenChange={(o) => { if (!o) setViewingId(null); }}>
        <DialogContent className="md:w-[min(780px,calc(100vw-32px))]">
          <DialogHeader>
            <div className="flex items-center gap-3.5">
              <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-sunken text-dim [&_svg]:size-6">{current ? iconFor(current) : <File />}</span>
              <div className="grid min-w-0 gap-0.5">
                <DialogTitle className="truncate">{current?.name ?? 'Loading…'}</DialogTitle>
                <DialogDescription className="truncate">
                  {current ? `${bytes(current.size)}${current.mode ? ` · ${modeInfo(current.mode).label}` : ''}${current.note ? ` · ${current.note}` : ''}` : ''}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <DialogBody>{current ? preview(current) : <Loading />}</DialogBody>
          <DialogFooter>
            {current && <Button variant="danger" className="mr-auto max-md:mr-0" onClick={() => remove.mutate(current.id)}><Trash2 />Delete</Button>}
            <Button variant="ghost" onClick={() => setViewingId(null)}>Close</Button>
            <Button onClick={() => current && open.mutate(current.id)} disabled={!current?.path}><FolderOpen />Open file</Button>
            <Button variant="primary" onClick={() => current && setDiscussing(current)}><SquarePen />Discuss</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  );
}

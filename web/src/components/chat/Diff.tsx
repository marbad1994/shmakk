import { memo, useMemo } from 'react';
import { parseDiff } from '@/lib/diff';
import { cn } from '@/lib/utils';

export function diffStats(diff: string | null | undefined) {
  if (!diff) return null;
  const d = parseDiff(diff);
  return { added: d.added, removed: d.removed };
}

export const Diff = memo(function Diff({ diff, className, maxHeight = 420 }: { diff: string; className?: string; maxHeight?: number }) {
  const d = useMemo(() => parseDiff(diff), [diff]);
  return (
    <div className={cn('overflow-hidden rounded-[10px] border border-line bg-sunken font-mono text-[12.3px] leading-[1.5]', className)}>
      <div className="flex items-center gap-2.5 border-b border-line bg-panel px-3 py-1.5 text-dim">
        <span className="min-w-0 flex-1 truncate text-fg">{d.path || 'changes'}</span>
        <span className="text-accent">+{d.added}</span>
        <span className="text-danger">−{d.removed}</span>
      </div>
      <div className="overflow-auto" style={{ maxHeight }}>
        <table className="min-w-full border-collapse">
          <tbody>
            {d.lines.map((l, i) =>
              l.kind === 'hunk' ? (
                <tr key={i} className="bg-info/10 text-info"><td colSpan={4} className="px-2.5 py-0.5">{l.text}</td></tr>
              ) : (
                <tr key={i} className={cn(l.kind === 'add' && 'bg-accent/10', l.kind === 'del' && 'bg-danger/10')}>
                  <td className="w-[1%] min-w-9 select-none border-r border-line px-1.5 text-right text-faint">{l.oldNo ?? ''}</td>
                  <td className="w-[1%] min-w-9 select-none border-r border-line px-1.5 text-right text-faint">{l.newNo ?? ''}</td>
                  <td className={cn('w-[1%] select-none pl-2 pr-0.5 text-faint', l.kind === 'add' && 'text-accent', l.kind === 'del' && 'text-danger')}>
                    {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}
                  </td>
                  <td className="whitespace-pre pr-3">{l.text || ' '}</td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
});

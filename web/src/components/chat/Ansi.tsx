import { memo, useMemo } from 'react';
import { parseAnsi } from '@/lib/ansi';
import { cn } from '@/lib/utils';

export const Ansi = memo(function Ansi({ text, className }: { text: string; className?: string }) {
  const spans = useMemo(() => parseAnsi(text), [text]);
  return (
    <pre className={cn('m-0 whitespace-pre-wrap break-words font-mono text-[12.8px] leading-relaxed text-dim', className)}>
      {spans.map((s, i) => (s.cls ? <span key={i} className={s.cls}>{s.text}</span> : s.text))}
    </pre>
  );
});

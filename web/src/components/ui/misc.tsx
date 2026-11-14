import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-3.5 animate-spin text-accent', className)} aria-label="Loading" />;
}

export function Card({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('overflow-hidden rounded-2xl border border-line bg-raised', className)} {...props} />;
}

export function Empty({ icon, title, children }: { icon?: React.ReactNode; title: string; children?: React.ReactNode }) {
  return (
    <div className="grid justify-items-center gap-1.5 rounded-2xl border border-dashed border-line-strong px-5 py-9 text-center text-dim">
      {icon ? <div className="mb-1 text-faint [&_svg]:size-6">{icon}</div> : null}
      <strong className="font-semibold text-fg">{title}</strong>
      {children ? <div className="max-w-md text-[13px]">{children}</div> : null}
    </div>
  );
}

/** Segmented control (single choice). */
export function Segmented<T extends string>({ value, onChange, options, className, label }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: React.ReactNode }[]; className?: string; label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn('inline-flex rounded-full border border-line bg-sunken p-0.5', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn('rounded-full px-2.5 py-0.5 font-mono text-xs text-dim transition-colors touch:px-3.5 touch:py-1.5 touch:text-[13px]', value === o.value && 'bg-accent font-semibold text-accent-ink')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

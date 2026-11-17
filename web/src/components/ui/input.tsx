import * as React from 'react';
import { cn } from '@/lib/utils';

const base =
  'w-full rounded-[10px] border border-line-strong bg-sunken px-3 text-fg outline-none transition-[border-color,box-shadow] placeholder:text-faint focus:border-accent/45 focus:ring-[3px] focus:ring-accent/15 disabled:opacity-50';

export function Input({ className, ...props }: React.ComponentProps<'input'>) {
  return <input className={cn(base, 'h-9 touch:h-11', className)} {...props} />;
}

export function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return <textarea className={cn(base, 'min-h-52 resize-y py-2.5 font-mono text-[13px] leading-relaxed', className)} {...props} />;
}

export function Label({ className, ...props }: React.ComponentProps<'label'>) {
  return <label className={cn('text-[12.5px] font-medium text-dim', className)} {...props} />;
}

export function Field({ label, hint, htmlFor, className, children }: { label: string; hint?: React.ReactNode; htmlFor?: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={cn('grid gap-1.5', className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-faint">{hint}</p> : null}
    </div>
  );
}

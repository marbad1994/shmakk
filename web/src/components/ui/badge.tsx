import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva('inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 font-mono text-[11px] font-semibold leading-[18px]', {
  variants: {
    tone: {
      neutral: 'border-line-strong text-dim',
      ok: 'border-accent/35 bg-accent/10 text-accent',
      warn: 'border-warn/40 bg-warn/10 text-warn',
      danger: 'border-danger/40 bg-danger/10 text-danger',
      info: 'border-info/40 bg-info/10 text-info',
      violet: 'border-violet/40 bg-violet/10 text-violet',
    },
  },
  defaultVariants: { tone: 'neutral' },
});

export function Badge({ className, tone, ...props }: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

import * as React from 'react';
import { Slot } from 'radix-ui';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'border border-line-strong bg-raised text-fg hover:border-faint',
        primary: 'bg-accent text-accent-ink hover:bg-accent-strong',
        ghost: 'text-dim hover:bg-hover hover:text-fg',
        danger: 'border border-danger/40 text-danger hover:bg-danger/10',
        link: 'text-accent underline-offset-2 hover:underline',
      },
      size: {
        default: 'h-9 rounded-[10px] px-3.5 text-[13.5px] touch:h-11 touch:rounded-xl touch:px-4 touch:text-[15px] [&_svg]:size-4',
        sm: 'h-7 rounded-lg px-2.5 text-[12.5px] touch:h-9 touch:px-3 touch:text-[13.5px] [&_svg]:size-3.5',
        icon: 'size-8 rounded-lg touch:size-10 touch:rounded-xl [&_svg]:size-4 touch:[&_svg]:size-5',
        'icon-sm': 'size-7 rounded-md touch:size-9 touch:rounded-lg [&_svg]:size-3.5 touch:[&_svg]:size-[18px]',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps extends React.ComponentProps<'button'>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export function Button({ className, variant, size, asChild = false, type, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : 'button';
  return <Comp type={asChild ? undefined : (type ?? 'button')} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

import * as React from 'react';
import { Switch as SwitchPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';

export function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'peer relative inline-flex h-[21px] w-9 shrink-0 touch:scale-[1.2] before:absolute before:-inset-2.5 before:content-[\'\'] items-center rounded-full bg-line-strong transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/60 data-[state=checked]:bg-accent disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-4 translate-x-[2.5px] rounded-full bg-raised shadow transition-transform data-[state=checked]:translate-x-[17.5px] data-[state=checked]:bg-accent-ink" />
    </SwitchPrimitive.Root>
  );
}

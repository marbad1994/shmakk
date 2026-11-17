import * as React from 'react';
import { Tabs as Primitive } from 'radix-ui';
import { cn } from '@/lib/utils';

export const Tabs = Primitive.Root;

export function TabsList({ className, ...props }: React.ComponentProps<typeof Primitive.List>) {
  return <Primitive.List className={cn('no-scrollbar flex max-w-full overflow-x-auto gap-0.5 rounded-[10px] border border-line bg-sunken p-[3px]', className)} {...props} />;
}
export function TabsTrigger({ className, ...props }: React.ComponentProps<typeof Primitive.Trigger>) {
  return (
    <Primitive.Trigger
      className={cn(
        'shrink-0 touch:min-h-11 rounded-[7px] px-3 py-1 text-[13px] touch:px-4 touch:py-2 touch:text-[14px] font-medium text-dim outline-none transition-colors hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/60 data-[state=active]:bg-raised data-[state=active]:text-fg data-[state=active]:shadow-sm',
        className,
      )}
      {...props}
    />
  );
}
export function TabsContent({ className, ...props }: React.ComponentProps<typeof Primitive.Content>) {
  return <Primitive.Content className={cn('outline-none', className)} {...props} />;
}

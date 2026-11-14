import * as React from 'react';
import { Command as CommandPrimitive } from 'cmdk';
import { Search } from 'lucide-react';
import { cn } from '@/lib/utils';

export function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return <CommandPrimitive className={cn('flex min-h-0 flex-col', className)} {...props} />;
}
export function CommandInput({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div className="flex items-center gap-2.5 border-b border-line px-4">
      <Search className="size-4 shrink-0 text-faint" />
      <CommandPrimitive.Input className={cn('h-12 w-full bg-transparent text-[15px] outline-none placeholder:text-faint', className)} {...props} />
    </div>
  );
}
export function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
  return <CommandPrimitive.List className={cn('max-h-[52vh] overflow-y-auto p-1.5', className)} {...props} />;
}
export function CommandEmpty(props: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return <CommandPrimitive.Empty className="py-8 text-center text-sm text-dim" {...props} />;
}
export function CommandGroup({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      className={cn('[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[10.5px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-faint', className)}
      {...props}
    />
  );
}
export function CommandItem({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      className={cn('flex cursor-default select-none items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-[13.5px] touch:min-h-11 touch:text-[15px] outline-none data-[selected=true]:bg-accent/10 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-dim data-[selected=true]:[&_svg]:text-accent', className)}
      {...props}
    />
  );
}

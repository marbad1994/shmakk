import * as React from 'react';
import { Select as Primitive } from 'radix-ui';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export const Select = Primitive.Root;
export const SelectValue = Primitive.Value;

export function SelectTrigger({ className, children, ...props }: React.ComponentProps<typeof Primitive.Trigger>) {
  return (
    <Primitive.Trigger
      className={cn(
        'flex h-9 w-full items-center touch:h-11 justify-between gap-2 rounded-[10px] border border-line-strong bg-sunken px-3 text-left outline-none transition-[border-color,box-shadow] focus:border-accent/45 focus:ring-[3px] focus:ring-accent/15 data-[placeholder]:text-faint',
        className,
      )}
      {...props}
    >
      {children}
      <Primitive.Icon><ChevronDown className="size-4 text-faint" /></Primitive.Icon>
    </Primitive.Trigger>
  );
}
export function SelectContent({ className, children, ...props }: React.ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        position="popper"
        sideOffset={6}
        className={cn('z-[60] max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-xl border border-line-strong bg-raised shadow-pop animate-pop', className)}
        {...props}
      >
        <Primitive.Viewport className="p-1">{children}</Primitive.Viewport>
      </Primitive.Content>
    </Primitive.Portal>
  );
}
export function SelectItem({ className, children, ...props }: React.ComponentProps<typeof Primitive.Item>) {
  return (
    <Primitive.Item
      className={cn('relative flex cursor-default select-none items-center rounded-lg py-1.5 pl-2.5 pr-8 text-[13.5px] touch:min-h-11 touch:text-[15px] outline-none data-[highlighted]:bg-hover', className)}
      {...props}
    >
      <Primitive.ItemText>{children}</Primitive.ItemText>
      <Primitive.ItemIndicator className="absolute right-2.5"><Check className="size-4 text-accent" /></Primitive.ItemIndicator>
    </Primitive.Item>
  );
}

import * as React from 'react';
import { DropdownMenu as Primitive } from 'radix-ui';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export const DropdownMenu = Primitive.Root;
export const DropdownMenuTrigger = Primitive.Trigger;
export const DropdownMenuGroup = Primitive.Group;
export const DropdownMenuRadioGroup = Primitive.RadioGroup;

export function DropdownMenuContent({ className, sideOffset = 6, ...props }: React.ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        sideOffset={sideOffset}
        collisionPadding={10}
        className={cn('z-50 min-w-44 overflow-hidden rounded-xl touch:min-w-56 touch:rounded-2xl touch:p-1.5 border border-line-strong bg-raised p-1 shadow-pop animate-pop', className)}
        {...props}
      />
    </Primitive.Portal>
  );
}

const itemCls =
  'relative flex cursor-default select-none items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13.5px] touch:min-h-11 touch:gap-3 touch:rounded-xl touch:px-3 touch:text-[15px] outline-none data-[highlighted]:bg-hover data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:text-dim';

export function DropdownMenuItem({ className, danger, ...props }: React.ComponentProps<typeof Primitive.Item> & { danger?: boolean }) {
  return <Primitive.Item className={cn(itemCls, danger && 'text-danger [&_svg]:text-danger', className)} {...props} />;
}
export function DropdownMenuRadioItem({ className, children, ...props }: React.ComponentProps<typeof Primitive.RadioItem>) {
  return (
    <Primitive.RadioItem className={cn(itemCls, 'pr-8', className)} {...props}>
      {children}
      <Primitive.ItemIndicator className="absolute right-2.5"><Check className="!text-accent" /></Primitive.ItemIndicator>
    </Primitive.RadioItem>
  );
}
export function DropdownMenuLabel({ className, ...props }: React.ComponentProps<typeof Primitive.Label>) {
  return <Primitive.Label className={cn('px-2.5 pb-1 pt-1.5 font-mono text-[10.5px] font-semibold uppercase tracking-wider text-faint', className)} {...props} />;
}
export function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof Primitive.Separator>) {
  return <Primitive.Separator className={cn('mx-1 my-1 h-px bg-line', className)} {...props} />;
}

import * as React from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

/**
 * Centered modal on desktop; on phones it becomes a bottom sheet — full
 * width, rounded top, grab handle, padded for the home indicator — which is
 * what a native app would do.
 */
export function DialogContent({ className, children, hideClose, ...props }: React.ComponentProps<typeof DialogPrimitive.Content> & { hideClose?: boolean }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 animate-fade bg-black/55 backdrop-blur-[3px]" />
      <DialogPrimitive.Content
        className={cn(
          'fixed z-50 flex flex-col overflow-hidden border border-line-strong bg-raised shadow-pop outline-none',
          'md:left-1/2 md:top-[12vh] md:max-h-[76vh] md:w-[min(560px,calc(100vw-32px))] md:-translate-x-1/2 md:animate-pop md:rounded-2xl',
          'max-md:inset-x-0 max-md:bottom-0 max-md:max-h-[calc(var(--app-h)-var(--sat)-24px)] max-md:!w-full max-md:animate-sheet max-md:rounded-t-3xl max-md:border-x-0 max-md:border-b-0 max-md:pb-[var(--sab)]',
          className,
        )}
        {...props}
      >
        <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-line-strong md:hidden" aria-hidden />
        {children}
        {hideClose ? null : (
          <DialogPrimitive.Close className="absolute right-3 top-3 grid size-7 place-items-center rounded-md text-dim hover:bg-hover hover:text-fg touch:size-9 touch:rounded-full touch:bg-hover" aria-label="Close">
            <X className="size-4" />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('grid shrink-0 gap-1 border-b border-line px-4 py-3.5 pr-14', className)} {...props} />;
}
export function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn('text-[15px] font-semibold touch:text-[17px]', className)} {...props} />;
}
export function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cn('text-[13px] text-dim', className)} {...props} />;
}
export function DialogBody({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('scroll-touch grid gap-3 overflow-y-auto px-4 py-3.5', className)} {...props} />;
}
export function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex shrink-0 justify-end gap-2 border-t border-line bg-panel px-4 py-3 max-md:flex-col-reverse max-md:[&>button]:w-full', className)} {...props} />;
}

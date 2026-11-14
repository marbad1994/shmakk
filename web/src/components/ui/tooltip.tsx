import * as React from 'react';
import { Tooltip as Primitive } from 'radix-ui';

export const TooltipProvider = Primitive.Provider;

/** One-line tooltip wrapper: <Tip label="Copy"><Button …/></Tip> */
export function Tip({ label, side = 'bottom', children }: { label: React.ReactNode; side?: 'top' | 'bottom' | 'left' | 'right'; children: React.ReactElement }) {
  return (
    <Primitive.Root>
      <Primitive.Trigger asChild>{children}</Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Content
          side={side}
          sideOffset={6}
          className="z-[60] max-w-72 rounded-lg border border-line-strong bg-raised px-2.5 py-1 text-xs text-fg shadow-pop animate-pop"
        >
          {label}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}

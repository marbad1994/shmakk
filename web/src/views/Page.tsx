import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Page({ lead, actions, tabs, children }: { lead?: ReactNode; actions?: ReactNode; tabs?: ReactNode; children: ReactNode }) {
  return (
    <div className="scroll-touch min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto grid max-w-[940px] grid-cols-[minmax(0,1fr)] gap-5.5 px-6.5 pb-16 pt-2 max-md:px-3.5">
        {tabs}
        {lead || actions ? (
          <div className="flex flex-wrap items-start justify-between gap-3">
            {lead ? <p className="m-0 max-w-[680px] text-dim">{lead}</p> : <span />}
            {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
          </div>
        ) : null}
        {children}
      </div>
    </div>
  );
}

export function Section({ id, title, aside, children, className }: { id?: string; title: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section id={id} className={cn('grid min-w-0 gap-3', className)}>
      <h2 className="m-0 flex min-w-0 flex-wrap items-center gap-2 text-[13px] font-semibold text-dim after:h-px after:flex-1 after:bg-line">
        {title}{aside ? <span className="order-last max-w-full font-normal">{aside}</span> : null}
      </h2>
      {children}
    </section>
  );
}

export function Rows({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('overflow-hidden rounded-2xl border border-line bg-raised [&>*:last-child]:border-b-0', className)}>{children}</div>;
}

export function Row({ title, sub, children, className }: { title?: ReactNode; sub?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-center gap-3.5 border-b border-line px-4 py-3 max-sm:flex-wrap max-sm:gap-x-3 max-sm:gap-y-2', className)}>
      {title || sub ? (
        <div className="min-w-0 flex-1 max-sm:basis-[60%]">
          {title ? <div className="break-words font-medium">{title}</div> : null}
          {sub ? <div className="break-words text-[13px] text-dim">{sub}</div> : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}

export function Loading() {
  return <div className="h-24 animate-pulse rounded-2xl border border-line bg-raised" />;
}

import * as React from 'react';
import { Popover } from 'radix-ui';
import { Check, ChevronDown, X } from 'lucide-react';
import { Command, CommandEmpty, CommandItem, CommandInput, CommandList } from '@/components/ui/command';
import { cn } from '@/lib/utils';

export interface MultiOption {
  /** Stored value, e.g. a workspace path. */
  value: string;
  /** What the row and the chip say. */
  label: string;
  /** Optional second line, e.g. the full path. */
  hint?: string;
  /** Shown greyed out and unpickable (e.g. the workspace you are in). */
  disabled?: boolean;
}

/**
 * A dropdown that searches and picks several options. The trigger shows a
 * summary, the picked options become removable chips underneath, and an empty
 * selection means "any" — the caller decides what that means.
 */
export function MultiSelect({ value, onChange, options, placeholder = 'Any', searchPlaceholder = 'Search…', ariaLabel, emptyText = 'Nothing matches.', chips = true, id }: {
  value: string[];
  onChange(next: string[]): void;
  options: MultiOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  ariaLabel: string;
  emptyText?: string;
  chips?: boolean;
  id?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const picked = new Set(value);
  const byValue = React.useMemo(() => new Map(options.map((o) => [o.value, o])), [options]);
  const toggle = (v: string) => onChange(picked.has(v) ? value.filter((x) => x !== v) : [...value, v]);
  const summary = value.length === 0
    ? placeholder
    : value.length === 1
      ? (byValue.get(value[0])?.label ?? value[0])
      : `${value.length} selected`;

  return (
    <div className="grid gap-1.5">
      <Popover.Root open={open} onOpenChange={(o) => { setOpen(o); if (!o) setSearch(''); }}>
        <Popover.Trigger asChild>
          <button
            type="button"
            id={id}
            role="combobox"
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-label={ariaLabel}
            className={cn(
              'flex h-9 w-full items-center gap-2 rounded-[10px] border border-line-strong bg-sunken px-3 text-left text-[13.5px] text-fg outline-none touch:h-11',
              'transition-[border-color,box-shadow] hover:border-accent/35 focus-visible:border-accent/45 focus-visible:ring-[3px] focus-visible:ring-accent/15 data-[state=open]:border-accent/45',
            )}
          >
            <span className={cn('min-w-0 flex-1 truncate', value.length === 0 && 'text-faint')}>{summary}</span>
            <ChevronDown className="size-4 shrink-0 text-faint" aria-hidden />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="start"
            sideOffset={6}
            className="z-[60] w-[var(--radix-popover-trigger-width)] min-w-56 overflow-hidden rounded-xl border border-line-strong bg-raised shadow-pop"
            onOpenAutoFocus={(e) => e.preventDefault()}
          >
            <Command shouldFilter loop>
              <CommandInput autoFocus value={search} onValueChange={setSearch} placeholder={searchPlaceholder} aria-label={searchPlaceholder} />
              <CommandList>
                <CommandEmpty>{emptyText}</CommandEmpty>
                {options.map((o) => {
                  const on = picked.has(o.value);
                  return (
                    <CommandItem
                      key={o.value}
                      value={`${o.label} ${o.hint ?? ''} ${o.value}`}
                      disabled={o.disabled}
                      onSelect={() => toggle(o.value)}
                      aria-selected={on}
                    >
                      <span className={cn('grid size-4 shrink-0 place-items-center rounded-[5px] border', on ? 'border-accent bg-accent/20 text-accent' : 'border-line-strong')} aria-hidden>
                        {on ? <Check className="size-3" /> : null}
                      </span>
                      <span className="grid min-w-0 flex-1 leading-tight">
                        <span className="truncate">{o.label}</span>
                        {o.hint ? <span className="truncate text-[11.5px] text-faint">{o.hint}</span> : null}
                      </span>
                    </CommandItem>
                  );
                })}
              </CommandList>
            </Command>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      {chips && value.length ? (
        <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          {value.map((v) => (
            <li key={v} className="inline-flex max-w-full items-center gap-1 rounded-full border border-line-strong bg-raised py-0.5 pl-2.5 pr-1 text-[12.5px]">
              <span className="truncate">{byValue.get(v)?.label ?? v}</span>
              <button type="button" aria-label={`Remove ${byValue.get(v)?.label ?? v}`} onClick={() => onChange(value.filter((x) => x !== v))}
                className="grid size-4 shrink-0 place-items-center rounded-full text-faint hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

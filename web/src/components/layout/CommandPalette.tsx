import { useState } from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { CornerDownLeft, MessageSquare } from 'lucide-react';
import { COMMANDS, type Command as Cmd } from '@/lib/commands';
import { relTime } from '@/lib/utils';
import { useApp } from '@/store/app';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';

const GROUPS: Cmd['group'][] = ['Chat', 'Go to', 'Mode', 'Model', 'Skills & memory', 'Maintenance', 'App'];

export function CommandPalette() {
  const open = useApp((s) => s.paletteOpen);
  const setOpen = useApp((s) => s.setPalette);
  const convs = useApp((s) => s.convs);
  const openConv = useApp((s) => s.openConv);
  const setDraft = useApp((s) => s.setDraft);
  const [query, setQuery] = useState('');

  const run = (c: Cmd) => {
    setOpen(false);
    setQuery('');
    // Commands that need an argument continue in the composer as "/cmd ".
    if (c.argRequired) setDraft(`/${c.slash} `);
    else void c.run('');
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQuery(''); }}>
      <DialogContent hideClose className="w-[min(620px,calc(100vw-32px))]" aria-describedby={undefined}>
        <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
        <Command loop>
          <CommandInput value={query} onValueChange={setQuery} placeholder="Search conversations and commands…" />
          <CommandList>
            <CommandEmpty>Nothing matches “{query}”.</CommandEmpty>
            {GROUPS.map((g) => (
              <CommandGroup key={g} heading={g}>
                {COMMANDS.filter((c) => c.group === g).map((c) => (
                  <CommandItem key={c.id} value={`${c.title} ${c.slash} ${c.hint}`} onSelect={() => run(c)}>
                    {c.icon}
                    <span className="min-w-0 flex-1 truncate">{c.title}<span className="ml-2 text-[12.5px] text-faint">{c.hint}</span></span>
                    <span className="shrink-0 font-mono text-[11.5px] text-faint">/{c.slash}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
            {convs.length ? (
              <CommandGroup heading="Conversations">
                {convs.slice(0, 40).map((c) => (
                  <CommandItem key={c.id} value={`${c.title} ${c.preview} ${c.id}`} onSelect={() => { setOpen(false); setQuery(''); void openConv(c.id); }}>
                    <MessageSquare />
                    <span className="min-w-0 flex-1 truncate">{c.title}</span>
                    <span className="shrink-0 font-mono text-[11.5px] text-faint">{relTime(c.updatedAt)}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
          <div className="flex gap-3.5 border-t border-line bg-panel px-3.5 py-2 text-[11.5px] text-faint">
            <span><kbd>↑</kbd> <kbd>↓</kbd> navigate</span>
            <span className="inline-flex items-center gap-1"><kbd><CornerDownLeft className="inline size-2.5" /></kbd> run</span>
            <span><kbd>Esc</kbd> close</span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

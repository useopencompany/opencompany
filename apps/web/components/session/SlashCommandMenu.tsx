"use client";

import { Command, CommandItem, CommandList } from "@/components/ui/command";
import type { SlashCommand } from "@/lib/slash-commands/registry";

type SlashCommandMenuProps = {
  id: string;
  commands: SlashCommand[];
  /** The id of the currently highlighted command (driven by the composer). */
  activeId: string | null;
  onSelect: (command: SlashCommand) => void;
  onHover: (id: string) => void;
};

/**
 * Floating slash-command menu, anchored above the composer. Filtering and keyboard
 * navigation are owned by the composer (focus stays in the textarea); this component
 * is presentational and reflects the active command via cmdk's controlled `value`.
 */
export function SlashCommandMenu({
  id,
  commands,
  activeId,
  onSelect,
  onHover,
}: SlashCommandMenuProps) {
  if (commands.length === 0) return null;

  return (
    <div
      id={id}
      role="listbox"
      aria-label="Slash commands"
      className="absolute bottom-[calc(100%+8px)] left-0 z-30 w-[min(320px,calc(100vw-4rem))] overflow-hidden rounded-lg border border-border bg-surface shadow-[0_8px_24px_-8px_rgba(15,15,15,0.12),0_2px_4px_rgba(15,15,15,0.05)]"
    >
      <Command shouldFilter={false} {...(activeId ? { value: activeId } : {})}>
        <CommandList className="p-1">
          {commands.map((command) => {
            const Icon = command.icon;
            return (
              <CommandItem
                id={`${id}-option-${command.id}`}
                key={command.id}
                role="option"
                aria-selected={activeId === command.id}
                value={command.id}
                className="gap-2 px-2 py-1.5"
                // cmdk would otherwise re-pick the first item on every render;
                // we drive selection ourselves so onSelect must not change it.
                onMouseMove={() => onHover(command.id)}
                onSelect={() => onSelect(command)}
              >
                <Icon size={13} strokeWidth={1.8} className="shrink-0 text-ink-muted" />
                <span className="font-mono text-[12px] text-ink">{command.trigger}</span>
                <span className="truncate text-[11.5px] text-ink-subtle">
                  {command.description}
                </span>
              </CommandItem>
            );
          })}
        </CommandList>
      </Command>
    </div>
  );
}

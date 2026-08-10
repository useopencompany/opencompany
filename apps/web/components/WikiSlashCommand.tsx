"use client";

// Notion-style "/" menu for the wiki editor. Typing "/" opens a small command
// list; "page" creates a sub-page of the current page, inserts a bare
// [[slug]] link at the cursor (the chip renders the target's live title), and
// opens the new page ready to name. Page creation is optimistic (local-first),
// so the whole interaction is synchronous.
//
// The list itself is the design system's cmdk-based Command component — the
// same battle-tested primitive as the app's command palette. The editor keeps
// keyboard focus; the tiptap Suggestion plugin forwards ArrowUp/ArrowDown/
// Enter to cmdk as native keydown events, which is the established pattern
// for tiptap slash menus built on cmdk.

import {
  Command,
  CommandEmpty,
  CommandItem,
  CommandList,
} from "@opencompany/ui/components/command";
import { PluginKey } from "@tiptap/pm/state";
import { ReactRenderer } from "@tiptap/react";
import { Suggestion, type SuggestionOptions } from "@tiptap/suggestion";
import { FilePlus2 } from "lucide-react";

export type WikiSlashCommandItem = {
  id: string;
  label: string;
  description: string;
};

export type WikiSlashCreatedPage = {
  id: string;
  slug: string;
  path: string;
  title: string;
};

export type WikiSlashCommandHandlers = {
  /**
   * Creates the sub-page (optimistically — must return synchronously) and
   * returns it, or null when creation is not possible.
   */
  createPage: () => WikiSlashCreatedPage | null;
  /** Called after the link is inserted, e.g. to open the new page. */
  onPageCreated?: (page: WikiSlashCreatedPage) => void;
};

const WIKI_SLASH_ITEMS: WikiSlashCommandItem[] = [
  { id: "page", label: "Page", description: "Create a sub-page and link it here" },
];

// A dedicated key: the default Suggestion key is shared module-wide and would
// collide with any other suggestion plugin on the same editor.
const WIKI_SLASH_PLUGIN_KEY = new PluginKey("wikiSlashCommand");

const FORWARDED_KEYS = new Set(["ArrowUp", "ArrowDown", "Enter", "Tab"]);

export function filterWikiSlashItems(query: string): WikiSlashCommandItem[] {
  const q = query.trim().toLowerCase();
  return q
    ? WIKI_SLASH_ITEMS.filter((item) => `${item.id} ${item.label}`.toLowerCase().includes(q))
    : WIKI_SLASH_ITEMS;
}

export function createWikiSlashCommandSuggestion(
  handlers: WikiSlashCommandHandlers,
): Omit<SuggestionOptions<WikiSlashCommandItem>, "editor"> {
  return {
    char: "/",
    pluginKey: WIKI_SLASH_PLUGIN_KEY,
    allowSpaces: false,
    items: ({ query }) => filterWikiSlashItems(query),
    command: ({ editor, range, props }) => {
      if (props.id !== "page") return;
      const created = handlers.createPage();
      if (!created) return;
      editor.chain().focus().deleteRange(range).insertContent(`[[${created.slug}]] `).run();
      handlers.onPageCreated?.(created);
    },
    render: () => {
      let component: ReactRenderer<unknown, WikiSlashMenuProps> | null = null;
      let container: HTMLDivElement | null = null;

      const position = (clientRect?: (() => DOMRect | null) | null) => {
        const rect = clientRect?.();
        if (!container || !rect) return;
        container.style.left = `${rect.left}px`;
        container.style.top = `${rect.bottom + 6}px`;
      };

      return {
        onStart: (props) => {
          component = new ReactRenderer(WikiSlashMenu, {
            props: {
              items: props.items,
              command: (item: WikiSlashCommandItem) => props.command(item),
            },
            editor: props.editor,
          });
          container = document.createElement("div");
          container.style.position = "fixed";
          container.style.zIndex = "90";
          container.appendChild(component.element);
          document.body.appendChild(container);
          position(props.clientRect);
        },
        onUpdate: (props) => {
          component?.updateProps({
            items: props.items,
            command: (item: WikiSlashCommandItem) => props.command(item),
          });
          position(props.clientRect);
        },
        onKeyDown: ({ event }) => {
          if (!FORWARDED_KEYS.has(event.key)) return false;
          // The editor keeps focus; drive cmdk by replaying the key on its
          // root element (Tab confirms like Enter).
          const commandRoot = container?.querySelector("[cmdk-root]");
          if (!commandRoot) return false;
          commandRoot.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: event.key === "Tab" ? "Enter" : event.key,
              bubbles: true,
              cancelable: true,
            }),
          );
          return true;
        },
        onExit: () => {
          component?.destroy();
          container?.remove();
          component = null;
          container = null;
        },
      };
    },
  };
}

export function createWikiSlashCommandPlugin(
  editor: Parameters<typeof Suggestion>[0]["editor"],
  handlers: WikiSlashCommandHandlers,
) {
  return Suggestion({ editor, ...createWikiSlashCommandSuggestion(handlers) });
}

type WikiSlashMenuProps = {
  items: WikiSlashCommandItem[];
  command: (item: WikiSlashCommandItem) => void;
};

function WikiSlashMenu({ items, command }: WikiSlashMenuProps) {
  if (items.length === 0) return null;

  return (
    <Command
      shouldFilter={false}
      // Keep focus (and the caret) in the editor while clicking the menu.
      onMouseDown={(event) => event.preventDefault()}
      className="min-w-56 rounded-lg border border-edge bg-surface shadow-lg"
    >
      <CommandList>
        <CommandEmpty>No commands.</CommandEmpty>
        {items.map((item) => (
          <CommandItem key={item.id} value={item.id} onSelect={() => command(item)}>
            <FilePlus2 className="h-3.5 w-3.5 shrink-0 text-ink-subtle" />
            <span className="flex min-w-0 flex-col">
              <span className="text-[13px] font-medium">{item.label}</span>
              <span className="truncate text-[11.5px] text-ink-subtle">{item.description}</span>
            </span>
          </CommandItem>
        ))}
      </CommandList>
    </Command>
  );
}

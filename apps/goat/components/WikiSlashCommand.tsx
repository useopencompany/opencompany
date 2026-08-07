"use client";

// Notion-style "/" menu for the wiki editor. Typing "/" opens a small command
// list; "page" creates a sub-page of the current page, inserts a [[slug|Name]]
// link at the cursor, and navigates into it. The command list is data-driven
// so more entries can join without another plugin.

import { ReactRenderer } from "@tiptap/react";
import { Suggestion, type SuggestionOptions } from "@tiptap/suggestion";
import { FilePlus2 } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useState } from "react";

export type WikiSlashCommandItem = {
  id: string;
  label: string;
  description: string;
};

export type WikiSlashCommandHandlers = {
  /** Creates the sub-page and returns its link target, or null on failure. */
  createPage: () => Promise<{ slug: string; title: string } | null>;
};

const WIKI_SLASH_ITEMS: WikiSlashCommandItem[] = [
  { id: "page", label: "Page", description: "Create a sub-page and link it here" },
];

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
    allowSpaces: false,
    items: ({ query }) => filterWikiSlashItems(query),
    command: ({ editor, range, props }) => {
      if (props.id !== "page") return;
      editor.chain().focus().deleteRange(range).run();
      void handlers.createPage().then((created) => {
        if (!created) return;
        editor.chain().focus().insertContent(`[[${created.slug}|${created.title}]] `).run();
      });
    },
    render: () => {
      let component: ReactRenderer<WikiSlashListHandle, WikiSlashListProps> | null = null;
      let container: HTMLDivElement | null = null;

      const position = (clientRect?: (() => DOMRect | null) | null) => {
        const rect = clientRect?.();
        if (!container || !rect) return;
        container.style.left = `${rect.left}px`;
        container.style.top = `${rect.bottom + 6}px`;
      };

      return {
        onStart: (props) => {
          component = new ReactRenderer(WikiSlashList, {
            props: {
              items: props.items,
              command: (item: WikiSlashCommandItem) => props.command(item),
            },
            editor: props.editor,
          });
          container = document.createElement("div");
          container.style.position = "fixed";
          container.style.zIndex = "50";
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
        onKeyDown: (props) => component?.ref?.onKeyDown(props) ?? false,
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

type WikiSlashListProps = {
  items: WikiSlashCommandItem[];
  command: (item: WikiSlashCommandItem) => void;
};

type WikiSlashListHandle = {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
};

const WikiSlashList = forwardRef<WikiSlashListHandle, WikiSlashListProps>(function WikiSlashList(
  { items, command },
  ref,
) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    setSelectedIndex(0);
  }, [items]);

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (event.key === "ArrowDown") {
        setSelectedIndex((index) => (index + 1) % Math.max(items.length, 1));
        return true;
      }
      if (event.key === "ArrowUp") {
        setSelectedIndex((index) => (index - 1 + items.length) % Math.max(items.length, 1));
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const item = items[selectedIndex];
        if (item) command(item);
        return true;
      }
      return false;
    },
  }));

  if (items.length === 0) return null;

  return (
    <div className="min-w-52 overflow-hidden rounded-lg border border-edge bg-surface shadow-lg">
      {items.map((item, index) => (
        <button
          key={item.id}
          type="button"
          onMouseDown={(event) => {
            event.preventDefault();
            command(item);
          }}
          className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] ${
            index === selectedIndex ? "bg-surface-sunken text-ink" : "text-ink-muted"
          }`}
        >
          <FilePlus2 className="h-3.5 w-3.5 shrink-0 text-ink-subtle" />
          <span className="flex min-w-0 flex-col">
            <span className="font-medium">{item.label}</span>
            <span className="truncate text-[11.5px] text-ink-subtle">{item.description}</span>
          </span>
        </button>
      ))}
    </div>
  );
});

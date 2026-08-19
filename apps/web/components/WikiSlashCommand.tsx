"use client";

// Notion-style "/" menu for the wiki editor. Typing "/" opens a command list of
// block types (headings, lists, plain text), a searchable existing-page link,
// plus "Page", which creates a sibling of the current page and inserts its
// full [[path]] at the cursor (the chip renders the target's live title). Page
// creation is optimistic (local-first), so the whole interaction is synchronous.
//
// Rendering, keyboard navigation, and positioning are handled by the shared
// EditorSuggestionMenu; this file only defines the commands and their rows.

import type { Editor, Range } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import { Suggestion, type SuggestionOptions } from "@tiptap/suggestion";
import {
  FilePlus2,
  Heading1,
  Heading2,
  Heading3,
  Link2,
  List,
  ListOrdered,
  type LucideIcon,
  Type,
} from "lucide-react";
import { createSuggestionRenderer } from "@/components/EditorSuggestionMenu";
import { wikiLinkContent } from "@/components/WikiLinkNode";

export type WikiSlashCreatedPage = {
  id: string;
  slug: string;
  path: string;
  title: string;
};

export type WikiSlashCommandHandlers = {
  /**
   * Creates the sibling page (optimistically — must return synchronously) and
   * returns it, or null when creation is not possible.
   */
  createPage: () => WikiSlashCreatedPage | null;
  /** Called after the link is inserted, e.g. to open the new page. */
  onPageCreated?: (page: WikiSlashCreatedPage) => void;
};

type WikiSlashRunContext = {
  editor: Editor;
  range: Range;
  handlers: WikiSlashCommandHandlers;
};

export type WikiSlashCommandItem = {
  id: string;
  label: string;
  description: string;
  // Extra terms the query matches against, so "list" finds both list kinds and
  // "title" finds Heading 1 even though the label doesn't contain the word.
  keywords: string[];
  icon: LucideIcon;
  // Runs against the block the "/" was typed in. `range` covers the "/query"
  // text, which every command deletes before applying itself.
  run: (context: WikiSlashRunContext) => void;
};

const WIKI_SLASH_ITEMS: WikiSlashCommandItem[] = [
  {
    id: "text",
    label: "Text",
    description: "Plain paragraph",
    keywords: ["paragraph", "plain", "body"],
    icon: Type,
    run: ({ editor, range }) => editor.chain().focus().deleteRange(range).setParagraph().run(),
  },
  {
    id: "h1",
    label: "Heading 1",
    description: "Large section heading",
    keywords: ["heading", "title", "large"],
    icon: Heading1,
    run: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setNode("heading", { level: 1 }).run(),
  },
  {
    id: "h2",
    label: "Heading 2",
    description: "Medium section heading",
    keywords: ["heading", "subtitle", "medium"],
    icon: Heading2,
    run: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setNode("heading", { level: 2 }).run(),
  },
  {
    id: "h3",
    label: "Heading 3",
    description: "Small section heading",
    keywords: ["heading", "small"],
    icon: Heading3,
    run: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setNode("heading", { level: 3 }).run(),
  },
  {
    id: "bulletList",
    label: "Bulleted list",
    description: "Simple bulleted list",
    keywords: ["bullet", "list", "unordered", "ul"],
    icon: List,
    run: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleBulletList().run(),
  },
  {
    id: "numberedList",
    label: "Numbered list",
    description: "Ordered list with numbers",
    keywords: ["numbered", "ordered", "list", "ol"],
    icon: ListOrdered,
    run: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
  },
  {
    id: "page",
    label: "Page",
    description: "Create a sibling page and link it here",
    keywords: ["page", "sibling", "new"],
    icon: FilePlus2,
    run: ({ editor, range, handlers }) => {
      const created = handlers.createPage();
      if (!created) return;
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent([wikiLinkContent(`[[${created.path}]]`), { type: "text", text: " " }])
        .run();
      handlers.onPageCreated?.(created);
    },
  },
  {
    id: "linkToPage",
    label: "Link to page",
    description: "Link to an existing wiki page",
    keywords: ["link", "reference", "existing", "wiki"],
    icon: Link2,
    run: ({ editor, range }) => {
      // Hand off to the wiki-page suggestion plugin. Inserting its `[[`
      // trigger opens the searchable page picker in the same transaction that
      // closes this slash menu.
      editor.chain().focus().deleteRange(range).insertContent("[[").run();
    },
  },
];

// A dedicated key: the default Suggestion key is shared module-wide and would
// collide with any other suggestion plugin on the same editor.
const WIKI_SLASH_PLUGIN_KEY = new PluginKey("wikiSlashCommand");

export function filterWikiSlashItems(query: string): WikiSlashCommandItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return WIKI_SLASH_ITEMS;
  return WIKI_SLASH_ITEMS.filter((item) =>
    `${item.id} ${item.label} ${item.keywords.join(" ")}`.toLowerCase().includes(q),
  );
}

export function createWikiSlashCommandSuggestion(
  handlers: WikiSlashCommandHandlers,
): Omit<SuggestionOptions<WikiSlashCommandItem>, "editor"> {
  return {
    char: "/",
    pluginKey: WIKI_SLASH_PLUGIN_KEY,
    allowSpaces: false,
    items: ({ query }) => filterWikiSlashItems(query),
    command: ({ editor, range, props }) => props.run({ editor, range, handlers }),
    render: createSuggestionRenderer<WikiSlashCommandItem>({
      ariaLabel: "Slash commands",
      emptyLabel: "No commands.",
      getKey: (item) => item.id,
      renderItem: (item) => {
        const Icon = item.icon;
        return (
          <>
            <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-subtle" />
            <span className="flex min-w-0 flex-col">
              <span className="text-[13px] font-medium leading-4 text-ink">{item.label}</span>
              <span className="mt-0.5 truncate text-[11.5px] leading-4 text-ink-subtle">
                {item.description}
              </span>
            </span>
          </>
        );
      },
    }),
  };
}

export function createWikiSlashCommandPlugin(
  editor: Parameters<typeof Suggestion>[0]["editor"],
  handlers: WikiSlashCommandHandlers,
) {
  return Suggestion({ editor, ...createWikiSlashCommandSuggestion(handlers) });
}

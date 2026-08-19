"use client";

import type { Editor } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import { Suggestion, type SuggestionOptions } from "@tiptap/suggestion";
import { FileText } from "lucide-react";
import { createSuggestionRenderer } from "@/components/EditorSuggestionMenu";
import { wikiLinkContent } from "@/components/WikiLinkNode";

export type WikiPageSuggestionItem = { path: string; title: string };

const WIKI_PAGE_SUGGESTION_KEY = new PluginKey("wikiPageSuggestion");

export function filterWikiPageSuggestions(
  pageTitles: Record<string, string>,
  query: string,
): WikiPageSuggestionItem[] {
  const normalized = query.trim().toLowerCase();
  return Object.entries(pageTitles)
    .map(([path, title]) => ({ path, title }))
    .filter(
      (page) =>
        !normalized ||
        page.path.toLowerCase().includes(normalized) ||
        page.title.toLowerCase().includes(normalized),
    )
    .toSorted(
      (a, b) =>
        a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) ||
        a.path.localeCompare(b.path),
    )
    .slice(0, 20);
}

export function createWikiPageSuggestion(
  getPageTitles: () => Record<string, string>,
): Omit<SuggestionOptions<WikiPageSuggestionItem>, "editor"> {
  return {
    char: "[[",
    pluginKey: WIKI_PAGE_SUGGESTION_KEY,
    allowSpaces: false,
    allowedPrefixes: null,
    items: ({ query }) => filterWikiPageSuggestions(getPageTitles(), query),
    command: ({ editor, range, props }) => {
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent(wikiLinkContent(`[[${props.path}]]`))
        .run();
    },
    render: createSuggestionRenderer<WikiPageSuggestionItem>({
      ariaLabel: "Wiki pages",
      emptyLabel: "No matching pages.",
      getKey: (item) => item.path,
      renderItem: (item) => {
        const folder = item.path.includes("/")
          ? item.path.slice(0, item.path.lastIndexOf("/"))
          : "Root";
        return (
          <>
            <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-subtle" />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-[13px] font-medium leading-4 text-ink">
                {item.title || "Untitled"}
              </span>
              <span className="mt-0.5 truncate text-[11.5px] leading-4 text-ink-subtle">
                {folder}
              </span>
            </span>
          </>
        );
      },
    }),
  };
}

export function createWikiPageSuggestionPlugin(
  editor: Editor,
  getPageTitles: () => Record<string, string>,
) {
  return Suggestion({ editor, ...createWikiPageSuggestion(getPageTitles) });
}

"use client";

import { Suggestion, type SuggestionOptions } from "@tiptap/suggestion";
import { Sparkles } from "lucide-react";
import { createSuggestionRenderer } from "@/components/EditorSuggestionMenu";
import { skillMentionContent } from "@/components/SkillMentionNode";
import type { SkillCatalogItem } from "@/lib/skills";

export function filterSkillMentionItems(
  skills: SkillCatalogItem[],
  query: string,
): SkillCatalogItem[] {
  const q = query.trim().toLowerCase();
  const matches = q
    ? skills.filter((skill) =>
        `${skill.id} ${skill.name} ${skill.description}`.toLowerCase().includes(q),
      )
    : skills;
  return matches.slice(0, 8);
}

// `skills` is captured once (the workflow editor passes a static server-fetched
// catalog for the lifetime of the page), so no ref/live-update plumbing is
// needed here — unlike `brainLinks` in MarkdownBrainEditor, which changes
// while a Brain document stays mounted.
export function createSkillMentionSuggestion(
  skills: SkillCatalogItem[],
): Omit<SuggestionOptions<SkillCatalogItem>, "editor"> {
  return {
    char: "@",
    allowSpaces: false,
    items: ({ query }) => filterSkillMentionItems(skills, query),
    command: ({ editor, range, props }) => {
      editor.chain().focus().insertContentAt(range, skillMentionContent(props)).run();
    },
    render: createSuggestionRenderer<SkillCatalogItem>({
      ariaLabel: "Skill mentions",
      emptyLabel: "No matching skills",
      getKey: (item) => item.id,
      renderItem: (item) => (
        <>
          <Sparkles size={14} strokeWidth={2} className="mt-0.5 shrink-0 text-ink-subtle" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium leading-4 text-ink">
              {item.name}
            </span>
            <span className="mt-0.5 block truncate text-[12px] leading-4 text-ink-subtle">
              {item.scope === "company"
                ? "Company"
                : item.scope === "personal"
                  ? "Personal"
                  : "Plugin"}
              {item.description ? ` · ${item.description}` : ""}
            </span>
          </span>
        </>
      ),
    }),
  };
}

export function createSkillMentionPlugin(
  editor: Parameters<typeof Suggestion>[0]["editor"],
  skills: SkillCatalogItem[],
) {
  return Suggestion({ editor, ...createSkillMentionSuggestion(skills) });
}

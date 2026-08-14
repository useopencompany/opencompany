"use client";

import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { Suggestion, type SuggestionOptions } from "@tiptap/suggestion";
import { Sparkles } from "lucide-react";
import { createSuggestionRenderer } from "@/components/EditorSuggestionMenu";
import type { GoatSkillCatalogItem } from "@/lib/skills";

// Workflow instructions are plain markdown compiled server-side
// (extractGoatWorkflowSkillMentionRefs in lib/workflow-tasks.ts scans the raw
// text for `@skill/<id>` tokens when the workflow fires) — so this extension
// only needs to make that token easy to discover and type correctly. It
// inserts literal `@skill/<id>` text, not a special mention node, so it
// round-trips through the Markdown extension like any other text.
export function filterSkillMentionItems(
  skills: GoatSkillCatalogItem[],
  query: string,
): GoatSkillCatalogItem[] {
  const q = query.trim().toLowerCase();
  const matches = q
    ? skills.filter((skill) =>
        `${skill.id} ${skill.name} ${skill.description}`.toLowerCase().includes(q),
      )
    : skills;
  return matches.slice(0, 8);
}

export function skillMentionInsertText(skill: GoatSkillCatalogItem): string {
  return `@skill/${skill.id} `;
}

// `skills` is captured once (the workflow editor passes a static server-fetched
// catalog for the lifetime of the page), so no ref/live-update plumbing is
// needed here — unlike `brainLinks` in MarkdownGoatBrainEditor, which changes
// while a Brain document stays mounted.
export function createSkillMentionSuggestion(
  skills: GoatSkillCatalogItem[],
): Omit<SuggestionOptions<GoatSkillCatalogItem>, "editor"> {
  return {
    char: "@",
    allowSpaces: false,
    items: ({ query }) => filterSkillMentionItems(skills, query),
    command: ({ editor, range, props }) => {
      editor.chain().focus().insertContentAt(range, skillMentionInsertText(props)).run();
    },
    render: createSuggestionRenderer<GoatSkillCatalogItem>({
      ariaLabel: "Skill mentions",
      emptyLabel: "No matching skills",
      getKey: (item) => item.id,
      renderItem: (item) => (
        <>
          <Sparkles size={14} strokeWidth={2} className="mt-0.5 shrink-0 text-ink-subtle" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium leading-4 text-ink">
              @skill/{item.id}
            </span>
            <span className="mt-0.5 block truncate text-[12px] leading-4 text-ink-subtle">
              {item.name}
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
  skills: GoatSkillCatalogItem[],
) {
  return Suggestion({ editor, ...createSkillMentionSuggestion(skills) });
}

// Paints each literal `@skill/<id>` token as a subtle chip so mentions read as
// distinct atoms, mirroring the main chat composer's selected-mention styling
// (see renderComposerInputOverlay in GoatSurface). This is a view-only
// decoration: the underlying text stays plain `@skill/<id>` and round-trips
// through Markdown untouched. The shadow spread (not padding) creates the chip
// gutter so caret metrics and line height are unaffected.
const SKILL_MENTION_CHIP_CLASS =
  "rounded-sm bg-ink/8 text-ink shadow-[0_0_0_3px_rgba(15,15,15,0.08)]";

const SKILL_MENTION_TOKEN_REGEX = /@skill\/[a-zA-Z0-9][a-zA-Z0-9._-]*/g;

const SKILL_MENTION_DECORATION_KEY = new PluginKey("skillMentionDecoration");

export function createSkillMentionDecorationPlugin() {
  return new Plugin({
    key: SKILL_MENTION_DECORATION_KEY,
    props: {
      decorations(state) {
        const decorations: Decoration[] = [];
        state.doc.descendants((node, pos) => {
          if (!node.isTextblock) return;
          if (node.type.spec.code) return false;
          let offset = pos + 1;
          node.forEach((child) => {
            if (
              child.isText &&
              child.text &&
              !child.marks.some((mark) => mark.type.name === "code")
            ) {
              const text = child.text;
              SKILL_MENTION_TOKEN_REGEX.lastIndex = 0;
              let match = SKILL_MENTION_TOKEN_REGEX.exec(text);
              while (match !== null) {
                const start = offset + match.index;
                decorations.push(
                  Decoration.inline(start, start + match[0].length, {
                    class: SKILL_MENTION_CHIP_CLASS,
                  }),
                );
                match = SKILL_MENTION_TOKEN_REGEX.exec(text);
              }
            }
            offset += child.nodeSize;
          });
          return false;
        });
        return DecorationSet.create(state.doc, decorations);
      },
    },
  });
}

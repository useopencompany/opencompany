"use client";

import type { Editor } from "@tiptap/core";
import { Suggestion } from "@tiptap/suggestion";
import { Sparkles } from "lucide-react";
import {
  type ContextReferenceOption,
  fetchContextReferenceCatalog,
  filterContextReferences,
} from "@/lib/context-reference-catalog";
import type { SkillCatalogItem } from "@/lib/skills";
import { ContextReferenceIcon } from "./ContextReference";
import { createSuggestionRenderer } from "./EditorSuggestionMenu";
import { skillMentionContent } from "./SkillMentionNode";
import { filterSkillMentionItems } from "./SkillMentionSuggestion";

type Item =
  | { kind: "reference"; reference: ContextReferenceOption }
  | { kind: "skill"; skill: SkillCatalogItem }
  | { kind: "status"; label: string };

export function createContextReferenceSuggestion(editor: Editor, skills: SkillCatalogItem[]) {
  let catalog: ReturnType<typeof fetchContextReferenceCatalog> | null = null;
  return Suggestion<Item>({
    editor,
    char: "@",
    allowSpaces: false,
    items: async ({ query }) => {
      catalog ??= fetchContextReferenceCatalog();
      const result = await catalog;
      if (result.error) catalog = null;
      const items: Item[] = [
        ...filterContextReferences(result.items, query).map(
          (reference): Item => ({ kind: "reference", reference }),
        ),
        ...filterSkillMentionItems(skills, query).map((skill): Item => ({ kind: "skill", skill })),
      ];
      if (result.error) items.push({ kind: "status", label: result.error });
      if (!items.length)
        items.push({
          kind: "status",
          label: "No matching mentions. Manage connections in Plugins.",
        });
      return items;
    },
    command: ({ editor, range, props }) => {
      if (props.kind === "status") return;
      const content =
        props.kind === "skill"
          ? skillMentionContent(props.skill)
          : [
              {
                type: "contextReference",
                attrs: { href: props.reference.href, label: props.reference.label },
              },
              { type: "text", text: " " },
            ];
      editor.chain().focus().insertContentAt(range, content).run();
    },
    render: createSuggestionRenderer<Item>({
      ariaLabel: "Mention menu",
      emptyLabel: "Loading mentions…",
      getKey: (item) =>
        item.kind === "reference"
          ? item.reference.href
          : item.kind === "skill"
            ? item.skill.id
            : item.label,
      renderItem: (item) =>
        item.kind === "status" ? (
          <span role="status" className="text-xs text-ink-subtle">
            {item.label}
          </span>
        ) : (
          <>
            {item.kind === "reference" ? (
              <ContextReferenceIcon plugin={item.reference.plugin} />
            ) : (
              <Sparkles size={14} />
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-ink">
                {item.kind === "reference" ? item.reference.label : item.skill.name}
              </span>
              <span className="block truncate text-xs text-ink-subtle">
                {item.kind === "reference" ? item.reference.description : "Skill"}
              </span>
            </span>
          </>
        ),
    }),
  });
}

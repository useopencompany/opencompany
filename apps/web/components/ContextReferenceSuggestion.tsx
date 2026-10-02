"use client";

import type { Editor } from "@tiptap/core";
import { Suggestion } from "@tiptap/suggestion";
import { Sparkles, Workflow } from "lucide-react";
import {
  type ContextReferenceOption,
  fetchContextReferenceCatalog,
  filterContextReferences,
} from "@/lib/context-reference-catalog";
import type { SkillCatalogItem } from "@/lib/skills";
import { ContextReferenceOptionContent } from "./ContextReference";
import { createSuggestionRenderer } from "./EditorSuggestionMenu";
import { skillMentionContent } from "./SkillMentionNode";
import { filterSkillMentionItems } from "./SkillMentionSuggestion";
import {
  filterWorkflowMentionItems,
  type WorkflowMentionItem,
  workflowMentionContent,
} from "./WorkflowMentionNode";

type Item =
  | { kind: "reference"; reference: ContextReferenceOption }
  | { kind: "skill"; skill: SkillCatalogItem }
  | { kind: "workflow"; workflow: WorkflowMentionItem }
  | { kind: "status"; label: string };

export function createContextReferenceSuggestion(
  editor: Editor,
  skills: SkillCatalogItem[],
  workflows: readonly WorkflowMentionItem[] = [],
) {
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
        ...filterWorkflowMentionItems(workflows, query).map(
          (workflow): Item => ({ kind: "workflow", workflow }),
        ),
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
          : props.kind === "workflow"
            ? workflowMentionContent(props.workflow)
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
      className: "context-mention-menu context-mention-floating",
      heading: "Context",
      emptyLabel: "Loading mentions…",
      getKey: (item) =>
        item.kind === "reference"
          ? item.reference.href
          : item.kind === "skill"
            ? item.skill.id
            : item.kind === "workflow"
              ? `workflow:${item.workflow.id}`
              : item.label,
      renderItem: (item) =>
        item.kind === "status" ? (
          <span role="status" className="text-xs text-ink-subtle">
            {item.label}
          </span>
        ) : item.kind === "reference" ? (
          <ContextReferenceOptionContent reference={item.reference} />
        ) : item.kind === "workflow" ? (
          <>
            <Workflow size={20} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-ink">
                {item.workflow.name}
              </span>
              <span className="block truncate text-xs text-ink-subtle">
                {item.workflow.active
                  ? "Workflow · this step can start it"
                  : "Workflow · draft, activate it to start it from here"}
              </span>
            </span>
          </>
        ) : (
          <>
            <Sparkles size={20} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-ink">
                {item.skill.name}
              </span>
              <span className="block truncate text-xs text-ink-subtle">Skill</span>
            </span>
          </>
        ),
    }),
  });
}

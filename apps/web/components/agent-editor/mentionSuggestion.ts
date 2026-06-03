import type { JsonValue } from "@opencompany/agent-runtime/types";
import { ReactRenderer } from "@tiptap/react";
import type { SuggestionOptions } from "@tiptap/suggestion";
import tippy, { type Instance as TippyInstance } from "tippy.js";
import { MentionList, type MentionListHandle } from "./MentionList";
import { type AgentMentionItem } from "./tools";

type MentionCommandItem = { id: string; label: string } & Record<string, JsonValue>;

export function createMentionSuggestion({
  getItems,
  onSelect,
  char = "@",
  showCategories = true,
}: {
  getItems: () => AgentMentionItem[];
  onSelect?: (item: AgentMentionItem) => void;
  char?: string;
  showCategories?: boolean;
}): Omit<SuggestionOptions<AgentMentionItem>, "editor"> {
  const base: Omit<SuggestionOptions<AgentMentionItem>, "editor"> = {
    char,
    items: ({ query }) => {
      const q = query.toLowerCase();
      return getItems().filter((item) => {
        return (
          item.kind.includes(q) ||
          item.id.toLowerCase().includes(q) ||
          item.mentionId.toLowerCase().includes(q) ||
          item.label.toLowerCase().includes(q) ||
          item.displayLabel.toLowerCase().includes(q) ||
          item.description.toLowerCase().includes(q)
        );
      });
    },
    render: () => {
      let component: ReactRenderer<MentionListHandle> | null = null;
      let popup: TippyInstance | null = null;

      return {
        onStart: (props) => {
          component = new ReactRenderer(MentionList, {
            props: {
              ...props,
              command: (item: MentionCommandItem) => {
                if (item.action === "schedule") {
                  props.editor.chain().focus().deleteRange(props.range).run();
                  return;
                }
                props.command(item);
              },
              onSelect,
              showCategories,
            },
            editor: props.editor,
          });

          if (!props.clientRect) return;

          popup = tippy(document.body, {
            getReferenceClientRect: () => props.clientRect?.() ?? new DOMRect(),
            appendTo: () => document.body,
            content: component.element,
            showOnCreate: true,
            interactive: true,
            trigger: "manual",
            placement: "bottom-start",
            offset: [0, 4],
            // Sit beneath the model dropdown (a Radix Select at z-50) instead of
            // tippy's default z-index (9999), so the popup never paints on top
            // of that menu — it stays underneath when both are open.
            zIndex: 40,
          });
        },
        onUpdate: (props) => {
          component?.updateProps({
            ...props,
            command: (item: MentionCommandItem) => {
              if (item.action === "schedule") {
                props.editor.chain().focus().deleteRange(props.range).run();
                return;
              }
              props.command(item);
            },
            onSelect,
            showCategories,
          });
          if (!props.clientRect || !popup) return;
          popup.setProps({
            getReferenceClientRect: () => props.clientRect?.() ?? new DOMRect(),
          });
        },
        onKeyDown: (props) => {
          if (props.event.key === "Escape") {
            popup?.hide();
            return true;
          }
          return component?.ref?.onKeyDown(props.event) ?? false;
        },
        onExit: () => {
          popup?.destroy();
          component?.destroy();
          popup = null;
          component = null;
        },
      };
    },
  };

  // `#` opens the hook menu (`#after-session`) and also prefixes markdown
  // headings (`# `). We deliberately let `#` open the hook menu everywhere,
  // including a lone `#` at the start of a line, so the hooks stay discoverable.
  // The two don't collide: a heading needs a trailing space, and typing that
  // space closes the suggestion (allowSpaces is off) so the heading input rule
  // still fires. So `#` shows the menu and `# ` still turns into a heading.

  return base;
}

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

  if (char === "#") {
    // Don't intercept `#` when it could be a markdown heading shortcut.
    // The heading input rule fires on the current visual line, so a `#`
    // that sits right after a hard break should pass through. We walk the
    // current text block manually: text nodes contribute their characters,
    // hard breaks reset the "current line" buffer, and other leaf nodes
    // (mentions etc.) count as non-empty content so an inline mention
    // before the `#` still suppresses the heading rule.
    base.allow = ({ state, range }) => {
      const $from = state.doc.resolve(range.from);
      const parent = $from.parent;
      const parentStart = $from.start();
      let currentLine = "";
      parent.descendants((node, offset) => {
        const absoluteStart = parentStart + offset;
        if (absoluteStart >= range.from) return false;
        if (node.type.name === "hardBreak") {
          currentLine = "";
          return false;
        }
        if (node.isText && typeof node.text === "string") {
          const available = range.from - absoluteStart;
          currentLine += node.text.slice(0, Math.max(0, available));
          return false;
        }
        if (node.isLeaf) {
          // Mentions and other inline atoms count as non-whitespace content.
          currentLine += "x";
          return false;
        }
        return true;
      });
      return currentLine.trim().length > 0;
    };
  }

  return base;
}

import { ReactRenderer } from "@tiptap/react";
import type { SuggestionOptions } from "@tiptap/suggestion";
import tippy, { type Instance as TippyInstance } from "tippy.js";
import { MentionList, type MentionListHandle } from "./MentionList";
import { type AgentMentionItem } from "./tools";

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
  return {
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
            props: { ...props, onSelect, showCategories },
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
          component?.updateProps({ ...props, onSelect, showCategories });
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
}

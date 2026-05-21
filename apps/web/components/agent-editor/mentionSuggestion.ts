import { ReactRenderer } from "@tiptap/react";
import type { SuggestionOptions } from "@tiptap/suggestion";
import tippy, { type Instance as TippyInstance } from "tippy.js";
import { MentionList, type MentionListHandle } from "./MentionList";
import { AGENT_TOOLS, type AgentTool } from "./tools";

export const mentionSuggestion: Omit<SuggestionOptions<AgentTool>, "editor"> = {
  char: "@",
  items: ({ query }) => {
    const q = query.toLowerCase();
    return AGENT_TOOLS.filter((t) => t.label.toLowerCase().includes(q));
  },
  render: () => {
    let component: ReactRenderer<MentionListHandle> | null = null;
    let popup: TippyInstance | null = null;

    return {
      onStart: (props) => {
        component = new ReactRenderer(MentionList, {
          props,
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
        component?.updateProps(props);
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

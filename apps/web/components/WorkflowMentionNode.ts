"use client";

import { workflowSlugFromName } from "@opencompany/agent/workflow-slug";
import { type JSONContent, Node } from "@tiptap/core";

/** A workflow a step's instructions can mention, and so hand work off to. */
export type WorkflowMentionItem = {
  /** The workflow's stable slug: the identity `@workflow/<slug>` carries. */
  id: string;
  name: string;
  description: string;
  active: boolean;
};

const WORKFLOW_MENTION_AT_START = /^@workflow\/([a-z0-9][a-z0-9-]{0,63})(?![a-z0-9_-])/i;
const WORKFLOW_MENTION_CHIP_CLASS = "rounded-sm bg-ink/8 px-1 text-ink";

// Keep the slug in markdown and resolve the display handle from the catalog, like skill chips.
// The handle matches what `#` shows in the chat composer, so a workflow reads the same everywhere.
export const WorkflowMention = Node.create<{ workflows: WorkflowMentionItem[] }>({
  name: "workflowMention",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addOptions() {
    return { workflows: [] };
  },

  addAttributes() {
    return {
      id: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-workflow-mention") ?? "",
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-workflow-mention]" }];
  },

  renderHTML({ node }) {
    return ["span", { "data-workflow-mention": node.attrs.id }, `@workflow/${node.attrs.id}`];
  },

  renderText({ node }) {
    return `@workflow/${node.attrs.id}`;
  },

  addNodeView() {
    const byId = new Map(this.options.workflows.map((workflow) => [workflow.id, workflow]));
    return ({ node }) => {
      const id = (node.attrs.id as string).toLowerCase();
      const workflow = byId.get(id);
      const dom = document.createElement("span");
      dom.className = WORKFLOW_MENTION_CHIP_CLASS;
      dom.contentEditable = "false";
      dom.setAttribute("data-workflow-mention", id);
      dom.textContent = workflow ? `#${workflowSlugFromName(workflow.name)}` : `@workflow/${id}`;
      dom.title = !workflow
        ? "This workflow is unavailable"
        : workflow.active
          ? `This step can start ${workflow.name}`
          : `${workflow.name} is a draft. Activate it to start it from here.`;
      return { dom };
    };
  },

  markdownTokenizer: {
    name: "workflowMention",
    level: "inline",
    start(src: string) {
      return src.toLowerCase().indexOf("@workflow/");
    },
    tokenize(src: string) {
      const match = WORKFLOW_MENTION_AT_START.exec(src);
      if (!match) return undefined;
      return { type: "workflowMention", raw: match[0], id: match[1]?.toLowerCase() };
    },
  },

  parseMarkdown(token) {
    return { type: "workflowMention", attrs: { id: token.id ?? "" } };
  },

  renderMarkdown(node: JSONContent) {
    return `@workflow/${node.attrs?.id ?? ""}`;
  },
});

export function workflowMentionContent(workflow: WorkflowMentionItem): JSONContent[] {
  return [
    { type: WorkflowMention.name, attrs: { id: workflow.id } },
    { type: "text", text: " " },
  ];
}

export function filterWorkflowMentionItems(
  workflows: readonly WorkflowMentionItem[],
  query: string,
): WorkflowMentionItem[] {
  const q = query.trim().toLowerCase();
  const matches = q
    ? workflows.filter((workflow) =>
        `${workflow.id} ${workflow.name} ${workflow.description}`.toLowerCase().includes(q),
      )
    : workflows;
  return matches.slice(0, 8);
}

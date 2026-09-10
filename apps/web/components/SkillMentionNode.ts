"use client";

import { type JSONContent, Node } from "@tiptap/core";
import type { SkillCatalogItem } from "@/lib/skills";

// Accept the escaped underscores written by the old plain-text editor too.
const SKILL_MENTION_AT_START = /^@skill\/([a-z0-9](?:[a-z0-9_-]|\\_){0,199})(?![a-z0-9_-])/i;
const SKILL_MENTION_CHIP_CLASS = "rounded-sm bg-ink/8 px-1 text-ink";

// Keep identity in markdown and resolve the display name from the catalog.
// An atom also prevents caret edits from corrupting an installation ID.
export const SkillMention = Node.create<{ skills: SkillCatalogItem[] }>({
  name: "skillMention",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addOptions() {
    return { skills: [] };
  },

  addAttributes() {
    return {
      id: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-skill-mention") ?? "",
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-skill-mention]" }];
  },

  // Clipboard HTML/text retain the reference even when pasted into an editor
  // with a different catalog (or a plain-text destination).
  renderHTML({ node }) {
    return ["span", { "data-skill-mention": node.attrs.id }, `@skill/${node.attrs.id}`];
  },

  renderText({ node }) {
    return `@skill/${node.attrs.id}`;
  },

  addNodeView() {
    const byId = new Map(this.options.skills.map((skill) => [skill.id, skill]));
    const byName = new Map<string, SkillCatalogItem>();
    for (const skill of this.options.skills) {
      if (this.options.skills.filter((candidate) => candidate.name === skill.name).length === 1) {
        byName.set(skill.name, skill);
      }
    }
    return ({ node }) => {
      const id = node.attrs.id as string;
      const skill = byId.get(id.toLowerCase()) ?? byName.get(id.toLowerCase());
      const dom = document.createElement("span");
      dom.className = SKILL_MENTION_CHIP_CLASS;
      dom.contentEditable = "false";
      dom.setAttribute("data-skill-mention", id);
      dom.textContent = skill ? `@${skill.name}` : `@skill/${id}`;
      dom.title = skill ? skill.name : "This skill is unavailable";
      return { dom };
    };
  },

  markdownTokenizer: {
    name: "skillMention",
    level: "inline",
    start(src: string) {
      return src.toLowerCase().indexOf("@skill/");
    },
    tokenize(src: string) {
      const match = SKILL_MENTION_AT_START.exec(src);
      if (!match) return undefined;
      return { type: "skillMention", raw: match[0], id: match[1]?.replace(/\\_/g, "_") };
    },
  },

  parseMarkdown(token: { id?: string }) {
    return { type: "skillMention", attrs: { id: token.id ?? "" } };
  },

  renderMarkdown(node: JSONContent) {
    return `@skill/${node.attrs?.id ?? ""}`;
  },
});

export function skillMentionContent(skill: SkillCatalogItem): JSONContent[] {
  return [
    { type: SkillMention.name, attrs: { id: skill.id } },
    { type: "text", text: " " },
  ];
}

import type { RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { SkillMentionRef } from "./skills";

const SKILL_MENTION_PATTERN = /(^|\s)@skill\/([a-z0-9][a-z0-9_-]{0,199})(?![a-z0-9_-])/gi;

export function extractWorkflowSkillMentionRefs(instructions: string): SkillMentionRef[] {
  // Workflow editors serialize Markdown escapes (including underscores in installation IDs).
  // Read prose text after parsing so formatting and code examples cannot corrupt references.
  const root = fromMarkdown(instructions, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const ids = new Set<string>();
  function visit(node: RootContent) {
    if (node.type === "text") {
      for (const match of node.value.matchAll(SKILL_MENTION_PATTERN)) {
        ids.add(match[2]!.toLowerCase());
      }
    } else if ("children" in node) {
      for (const child of node.children) visit(child);
    }
  }
  for (const node of root.children) visit(node);
  return [...ids].map((id) => ({ id }));
}

import { fromMarkdown } from "mdast-util-from-markdown";

export type ContextReference = {
  kind: "plugin" | "repository";
  label: string;
  href: string;
  plugin: string;
};

export function contextReference(href: string, label: string): ContextReference | null {
  const plugin = /^\/plugins\/([a-z0-9][a-z0-9_-]*)$/.exec(href);
  if (plugin) return { kind: "plugin", label, href, plugin: plugin[1]! };
  const repository = /^https:\/\/github\.com\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)\/?$/.exec(href);
  if (repository && ![".", ".."].includes(repository[2]!)) {
    return { kind: "repository", label, href, plugin: "github" };
  }
  return null;
}

export function referenceMarkdown(reference: Pick<ContextReference, "label" | "href">) {
  return `[${reference.label.replace(/[\\`*_\[\]<>!&]/g, "\\$&")}](${reference.href})`;
}

export type ContextReferenceRange = ContextReference & { start: number; end: number; raw: string };

// Parse Markdown rather than matching names: code examples, escaped links, and ordinary
// prose stay literal. Offsets preserve every byte outside the selected reference.
export function contextReferenceRanges(text: string): ContextReferenceRange[] {
  if (!text.includes("](")) return [];
  const root = fromMarkdown(text);
  const ranges: ContextReferenceRange[] = [];
  function visit(node: (typeof root.children)[number]) {
    if (node.type === "link" && node.children.every((child) => child.type === "text")) {
      const label = node.children.map((child) => ("value" in child ? child.value : "")).join("");
      const reference = contextReference(node.url, label);
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (reference && start !== undefined && end !== undefined && text[start] === "[") {
        ranges.push({ ...reference, start, end, raw: text.slice(start, end) });
      }
    } else if ("children" in node) {
      for (const child of node.children) visit(child);
    }
  }
  for (const node of root.children) visit(node);
  return ranges;
}

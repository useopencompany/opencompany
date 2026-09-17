"use client";

import { Node } from "@tiptap/core";
import { type NodeViewProps, NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import {
  contextReference,
  contextReferenceRanges,
  referenceMarkdown,
} from "@/lib/context-references";
import { ContextReferenceIcon, contextReferenceClassName } from "./ContextReference";

function ReferenceNodeView({ node }: NodeViewProps) {
  const reference = contextReference(node.attrs.href, node.attrs.label);
  return (
    <NodeViewWrapper
      as="span"
      className={contextReferenceClassName(reference?.plugin ?? "")}
      contentEditable={false}
      data-context-reference={reference?.kind}
      title={node.attrs.href}
    >
      <ContextReferenceIcon plugin={reference?.plugin ?? ""} />
      <span>{node.attrs.label}</span>
    </NodeViewWrapper>
  );
}

export const ContextReferenceNode = Node.create({
  name: "contextReference",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { href: { default: "" }, label: { default: "" }, raw: { default: null } };
  },
  parseHTML() {
    return [
      {
        tag: "a[href]",
        priority: 100,
        getAttrs: (element) => {
          const href = element.getAttribute("href") ?? "";
          const label = element.textContent ?? "";
          return contextReference(href, label) ? { href, label } : false;
        },
      },
    ];
  },
  renderHTML({ node }) {
    return ["a", { href: node.attrs.href, class: "context-reference" }, node.attrs.label];
  },
  renderText({ node }) {
    return node.attrs.raw ?? referenceMarkdown({ href: node.attrs.href, label: node.attrs.label });
  },
  addNodeView() {
    return ReactNodeViewRenderer(ReferenceNodeView);
  },
  markdownTokenizer: {
    name: "contextReference",
    level: "inline",
    start: (src) => src.indexOf("["),
    tokenize(src) {
      const match =
        /^\[(?:\\.|[^\]\\\n])*\]\((?:\/plugins\/[^\s)]+|https:\/\/github\.com\/[^\s)]+)\)/.exec(
          src,
        );
      if (!match) return undefined;
      const reference = contextReferenceRanges(match[0])[0];
      if (!reference) return undefined;
      return {
        type: "contextReference",
        raw: match[0],
        href: reference.href,
        label: reference.label,
      };
    },
  },
  parseMarkdown(token) {
    return {
      type: "contextReference",
      attrs: { href: token.href, label: token.label, raw: token.raw },
    };
  },
  renderMarkdown(node) {
    return (
      node.attrs?.raw ??
      referenceMarkdown({ href: node.attrs?.href ?? "", label: node.attrs?.label ?? "" })
    );
  },
});

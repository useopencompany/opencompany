"use client";

import { Mention } from "@tiptap/extension-mention";
import {
  EditorContent,
  Extension,
  type JSONContent,
  mergeAttributes,
  useEditor,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useMemo, useState } from "react";
import { createMentionSuggestion } from "./mentionSuggestion";
import { AGENT_TOOL_MENTION_ITEMS, type AgentMentionItem } from "./tools";

type Props = {
  initialBody: string;
  onChange: (body: string) => void;
  mentionItems?: AgentMentionItem[];
};

const plainTextKeysExtension = Extension.create({
  name: "plainTextKeys",
  addKeyboardShortcuts() {
    return {
      Enter: () => this.editor.commands.setHardBreak(),
      Tab: () => this.editor.commands.insertContent("  "),
    };
  },
});

export function AgentEditor({
  initialBody,
  onChange,
  mentionItems = AGENT_TOOL_MENTION_ITEMS,
}: Props) {
  const [isEmpty, setIsEmpty] = useState(initialBody.trim().length === 0);
  const mentionExtension = useMemo(
    () =>
      Mention.configure({
        HTMLAttributes: {
          class: "agent-mention",
        },
        suggestion: createMentionSuggestion(mentionItems),
        renderText({ node, suggestion }) {
          return `${suggestion?.char ?? "@"}${node.attrs.label ?? node.attrs.id}`;
        },
        renderHTML({ options, node }) {
          const id = typeof node.attrs.id === "string" ? node.attrs.id : "";
          const kind = id.startsWith("model:")
            ? "model"
            : id.startsWith("tool:")
              ? "tool"
              : id.startsWith("brain/")
                ? "brain"
                : undefined;

          return [
            "span",
            mergeAttributes(options.HTMLAttributes, kind ? { "data-kind": kind } : {}),
            `${node.attrs.mentionSuggestionChar ?? "@"}${node.attrs.label ?? node.attrs.id}`,
          ];
        },
      }),
    [mentionItems],
  );
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        blockquote: false,
        bulletList: false,
        codeBlock: false,
        heading: false,
        horizontalRule: false,
        listItem: false,
        orderedList: false,
      }),
      mentionExtension,
      plainTextKeysExtension,
    ],
    content: bodyToTiptapDoc(initialBody, mentionItems),
    editorProps: {
      attributes: {
        class: "tiptap-agent min-h-[320px] w-full text-[13.5px] leading-7 text-ink/90 outline-none",
      },
    },
    onUpdate: ({ editor }) => {
      setIsEmpty(editor.isEmpty);
      onChange(tiptapDocToBody(editor.getJSON()));
    },
    onCreate: ({ editor }) => {
      setIsEmpty(editor.isEmpty);
    },
  });

  return (
    <div className="relative">
      {isEmpty && (
        <div className="pointer-events-none absolute left-0 top-0 text-[13.5px] leading-7 text-ink-subtle/70">
          Describe what this agent should do. Mention tools or brain files with @.
        </div>
      )}
      <EditorContent editor={editor} />
    </div>
  );
}

function bodyToTiptapDoc(body: string, mentionItems: AgentMentionItem[]): JSONContent {
  const normalized = body.replace(/\r\n/g, "\n");
  if (normalized.trim().length === 0) {
    return { type: "doc", content: [{ type: "paragraph" }] };
  }

  return {
    type: "doc",
    content: normalized.split(/\n{2,}/).map((block) => ({
      type: "paragraph",
      content: parseInlineContent(block, mentionItems),
    })),
  };
}

function parseInlineContent(text: string, mentionItems: AgentMentionItem[]): JSONContent[] {
  const content: JSONContent[] = [];
  const lines = text.split("\n");

  lines.forEach((line, lineIndex) => {
    if (lineIndex > 0) content.push({ type: "hardBreak" });
    content.push(...parseMentionText(line, mentionItems));
  });

  return content;
}

function parseMentionText(text: string, mentionItems: AgentMentionItem[]): JSONContent[] {
  const content: JSONContent[] = [];
  let cursor = 0;

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "@") continue;
    if (index > 0 && !/[\s([{]/.test(text[index - 1] ?? "")) continue;

    let end = index + 1;
    while (end < text.length && isMentionChar(text[end] ?? "")) end += 1;

    const rawToken = text.slice(index + 1, end);
    const token = rawToken.replace(/[.,;:!?)}\]]+$/g, "");
    const trailing = rawToken.slice(token.length);
    const item = findMentionItem(token, mentionItems);
    if (!item) continue;

    pushText(content, text.slice(cursor, index));
    content.push({
      type: "mention",
      attrs: {
        id: item.mentionId,
        label: item.label,
        mentionSuggestionChar: "@",
      },
    });
    pushText(content, trailing);
    cursor = end;
    index = end - 1;
  }

  pushText(content, text.slice(cursor));
  return content;
}

function findMentionItem(
  id: string,
  mentionItems: AgentMentionItem[],
): AgentMentionItem | undefined {
  return (
    mentionItems.find((item) => item.mentionId === id) ??
    mentionItems.find((item) => item.id === id)
  );
}

function pushText(content: JSONContent[], text: string) {
  if (text.length === 0) return;
  content.push({ type: "text", text });
}

function tiptapDocToBody(doc: JSONContent) {
  return (doc.content ?? [])
    .map((node) => nodeText(node))
    .join("\n\n")
    .replace(/\s+$/g, "");
}

function nodeText(node: JSONContent): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  if (node.type === "mention") {
    const label = typeof node.attrs?.label === "string" ? node.attrs.label : null;
    const id = typeof node.attrs?.id === "string" ? node.attrs.id : "";
    return `@${label ?? id}`;
  }

  return (node.content ?? []).map((child) => nodeText(child)).join("");
}

function isMentionChar(char: string) {
  return (
    (char >= "a" && char <= "z") ||
    (char >= "A" && char <= "Z") ||
    (char >= "0" && char <= "9") ||
    char === "_" ||
    char === "." ||
    char === "/" ||
    char === "-"
  );
}

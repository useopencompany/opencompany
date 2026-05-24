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
import { forwardRef, useImperativeHandle, useMemo, useState } from "react";
import { createMentionSuggestion } from "./mentionSuggestion";
import { type AgentMentionItem, buildAgentMentionItems, findMentionItem } from "./tools";

type Props = {
  initialBody: string;
  initialContent?: JSONContent | null;
  onChange: (body: string, content: JSONContent) => void;
  mentionItems?: AgentMentionItem[];
  onMentionSelect?: (item: AgentMentionItem) => void;
};

export type AgentEditorHandle = {
  selectRepositoryMention: (repository: { fullName: string; defaultBranch: string }) => void;
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

export const AgentEditor = forwardRef<AgentEditorHandle, Props>(function AgentEditor(
  {
    initialBody,
    initialContent,
    onChange,
    mentionItems = buildAgentMentionItems(),
    onMentionSelect,
  },
  ref,
) {
  const [isEmpty, setIsEmpty] = useState(initialBody.trim().length === 0);
  const mentionExtension = useMemo(
    () =>
      Mention.configure({
        HTMLAttributes: {
          class: "agent-mention",
        },
        suggestion: createMentionSuggestion({
          getItems: () => mentionItems,
          ...(onMentionSelect ? { onSelect: onMentionSelect } : {}),
        }),
        renderText({ node, suggestion }) {
          return renderMentionText(node.attrs, suggestion?.char ?? "@");
        },
        renderHTML({ options, node }) {
          const id = typeof node.attrs.id === "string" ? node.attrs.id : "";
          const kind = mentionKindFromId(id);

          return [
            "span",
            mergeAttributes(options.HTMLAttributes, kind ? { "data-kind": kind } : {}),
            renderMentionText(node.attrs),
          ];
        },
      }),
    [mentionItems, onMentionSelect],
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
    content: hasUsableDocumentContent(initialContent)
      ? initialContent
      : bodyToTiptapDoc(initialBody, mentionItems),
    editorProps: {
      attributes: {
        class: "tiptap-agent min-h-[320px] w-full text-[13.5px] leading-7 text-ink/90 outline-none",
      },
    },
    onUpdate: ({ editor }) => {
      const doc = stripEmptyMentions(editor.getJSON());
      setIsEmpty(editor.isEmpty);
      onChange(tiptapDocToBody(doc), doc);
    },
    onCreate: ({ editor }) => {
      setIsEmpty(editor.isEmpty);
    },
  });

  useImperativeHandle(
    ref,
    () => ({
      selectRepositoryMention(repository) {
        if (!editor) return;
        const item = findMentionItem(repository.fullName, buildAgentMentionItems([repository]));
        if (!item) return;

        const nextDoc = withRepositoryMention(stripEmptyMentions(editor.getJSON()), item);
        editor.commands.setContent(nextDoc);
        setIsEmpty(false);
        onChange(tiptapDocToBody(nextDoc), nextDoc);
      },
    }),
    [editor, onChange],
  );

  return (
    <div className="relative">
      {isEmpty && (
        <div className="pointer-events-none absolute left-0 top-0 text-[13.5px] leading-7 text-ink-subtle/70">
          Describe what this agent should do. Mention tools with @.
        </div>
      )}
      <EditorContent editor={editor} />
    </div>
  );
});

function hasUsableDocumentContent(content: JSONContent | null | undefined): content is JSONContent {
  return (
    content?.type === "doc" &&
    Array.isArray(content.content) &&
    content.content.length > 0 &&
    mentionsHaveDisplayText(content)
  );
}

function mentionsHaveDisplayText(node: JSONContent): boolean {
  if (node.type === "mention" && mentionDisplayText(node.attrs).length === 0) {
    return false;
  }

  return (node.content ?? []).every(mentionsHaveDisplayText);
}

function stripEmptyMentions(node: JSONContent): JSONContent {
  if (!node.content) return node;
  const next = (node.content ?? [])
    .filter((child) => !(child.type === "mention" && mentionDisplayText(child.attrs).length === 0))
    .map(stripEmptyMentions);
  return { ...node, content: next };
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

function withRepositoryMention(doc: JSONContent, item: AgentMentionItem): JSONContent {
  const mention = mentionNode(item);
  const next = cloneJsonContent(doc);
  const path = lastGitHubMentionPath(next);

  if (path) {
    replaceAtPath(next, path, mention);
    return next;
  }

  const paragraph = lastParagraph(next);
  if (paragraph) {
    paragraph.content ??= [];
    if (paragraph.content.length > 0) {
      paragraph.content.push({ type: "text", text: " " });
    }
    paragraph.content.push(mention);
    return next;
  }

  return { type: "doc", content: [{ type: "paragraph", content: [mention] }] };
}

function mentionNode(item: AgentMentionItem): JSONContent {
  return {
    type: "mention",
    attrs: {
      id: item.mentionId,
      label: item.label,
      mentionSuggestionChar: "@",
    },
  };
}

function lastGitHubMentionPath(doc: JSONContent) {
  let found: number[] | null = null;

  walkContent(doc, [], (node, path) => {
    if (node.type !== "mention") return;
    const id = typeof node.attrs?.id === "string" ? node.attrs.id : "";
    const label = typeof node.attrs?.label === "string" ? node.attrs.label : "";
    if (id === "integration:github" || id === "github" || id.startsWith("integration:github:")) {
      found = path;
      return;
    }
    if (label.includes("/")) {
      found = path;
    }
  });

  return found;
}

function walkContent(
  node: JSONContent,
  path: number[],
  visit: (node: JSONContent, path: number[]) => void,
) {
  visit(node, path);
  node.content?.forEach((child, index) => walkContent(child, [...path, index], visit));
}

function replaceAtPath(doc: JSONContent, path: number[], nextNode: JSONContent) {
  const parentPath = path.slice(0, -1);
  const index = path.at(-1);
  const parent = parentPath.reduce<JSONContent | undefined>(
    (node, item) => node?.content?.[item],
    doc,
  );
  if (!parent?.content || index === undefined) return;
  parent.content[index] = nextNode;
}

function lastParagraph(doc: JSONContent) {
  const blocks = doc.content ?? [];
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (blocks[index]?.type === "paragraph") return blocks[index];
  }
  return null;
}

function cloneJsonContent(doc: JSONContent): JSONContent {
  return JSON.parse(JSON.stringify(doc)) as JSONContent;
}

function nodeText(node: JSONContent): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  if (node.type === "mention") {
    const displayText = mentionDisplayText(node.attrs);
    return displayText.length > 0 ? `@${displayText}` : "";
  }

  return (node.content ?? []).map((child) => nodeText(child)).join("");
}

function renderMentionText(attrs: JSONContent["attrs"], fallbackChar = "@") {
  const suggestionChar =
    typeof attrs?.mentionSuggestionChar === "string" ? attrs.mentionSuggestionChar : fallbackChar;
  const displayText = mentionDisplayText(attrs);
  return displayText.length > 0 ? `${suggestionChar}${displayText}` : "";
}

function mentionDisplayText(attrs: JSONContent["attrs"]) {
  const label = typeof attrs?.label === "string" ? attrs.label : "";
  if (label.trim().length > 0) return label;

  const id = typeof attrs?.id === "string" ? attrs.id : "";
  return id.trim().length > 0 ? id : "";
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

function mentionKindFromId(id: string) {
  if (id.startsWith("model:")) return "model";
  if (id.startsWith("tool:")) return "tool";
  if (id.startsWith("integration:")) return "integration";
  return undefined;
}

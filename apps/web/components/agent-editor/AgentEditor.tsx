"use client";

import { buildAgentTiptapDoc, type MentionResolver } from "@opencompany/agent-runtime";
import { Mention } from "@tiptap/extension-mention";
import { Fragment, Slice } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import {
  EditorContent,
  Extension,
  type JSONContent,
  mergeAttributes,
  useEditor,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from "react";
import { createMentionSuggestion } from "./mentionSuggestion";
import {
  AGENT_AFTER_SESSION_MENTION_ITEMS,
  type AgentIntegration,
  type AgentMentionItem,
  buildAgentMentionItems,
  findMentionItem,
} from "./tools";

type Props = {
  initialBody: string;
  initialContent?: JSONContent | null;
  onChange: (body: string, content: JSONContent) => void;
  mentionItems?: AgentMentionItem[];
  onMentionSelect?: (item: AgentMentionItem) => void;
};

export type AgentEditorHandle = {
  selectRepositoryMention: (
    repository: Pick<AgentIntegration, "fullName" | "defaultBranch" | "binding"> & {
      fullName: string;
      defaultBranch: string;
    },
  ) => void;
};

const plainTextKeysExtension = Extension.create({
  name: "plainTextKeys",
  addKeyboardShortcuts() {
    const swallowInStructuredBlock = () => {
      // Inside headings and list items, a hard break would survive locally
      // but the markdown round-trip cannot represent it (list items would
      // turn into "item line one\nitem line two", which the parser splits
      // into separate blocks). Swallow the shortcut instead of inserting a
      // hard break there.
      if (this.editor.isActive("heading") || this.editor.isActive("listItem")) {
        return true;
      }
      return this.editor.commands.setHardBreak();
    };
    return {
      Enter: () => {
        if (this.editor.isActive("heading") || this.editor.isActive("listItem")) {
          return false;
        }
        return this.editor.commands.setHardBreak();
      },
      "Shift-Enter": swallowInStructuredBlock,
      "Mod-Enter": swallowInStructuredBlock,
      Tab: () => this.editor.commands.insertContent("  "),
    };
  },
});

const AUTO_MENTION_TOKEN_RE = /([@#])([\w./\-]+)/g;
const AUTO_MENTION_IDLE_MS = 600;
const autoMentionPluginKey = new PluginKey<{ force: boolean }>("autoMentionConvert");

const createAutoMentionExtension = (getItems: () => AgentMentionItem[]) =>
  Extension.create({
    name: "autoMentionConvert",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: autoMentionPluginKey,
          view() {
            let timer: ReturnType<typeof setTimeout> | null = null;
            const clear = () => {
              if (timer) {
                clearTimeout(timer);
                timer = null;
              }
            };
            return {
              update: (view, prevState) => {
                const docSame = view.state.doc.eq(prevState.doc);
                const selSame = view.state.selection.eq(prevState.selection);
                if (docSame && selSame) return;

                let pending = false;
                view.state.doc.descendants((node) => {
                  if (pending) return false;
                  if (node.isText && node.text && /[@#]/.test(node.text)) pending = true;
                });

                clear();
                if (!pending) return;

                timer = setTimeout(() => {
                  timer = null;
                  if ((view as { isDestroyed?: boolean }).isDestroyed) return;
                  view.dispatch(view.state.tr.setMeta(autoMentionPluginKey, { force: true }));
                }, AUTO_MENTION_IDLE_MS);
              },
              destroy: clear,
            };
          },
          appendTransaction: (transactions, oldState, newState) => {
            const docChanged = transactions.some((tr) => tr.docChanged);
            const selectionChanged = !newState.selection.eq(oldState.selection);
            const force = transactions.some(
              (tr) => tr.getMeta(autoMentionPluginKey)?.force === true,
            );
            if (!docChanged && !selectionChanged && !force) return null;

            const wasTypingForward =
              docChanged &&
              !force &&
              newState.selection.empty &&
              oldState.selection.empty &&
              newState.selection.from === oldState.selection.from + 1;

            const items = getItems();
            const cursorEmpty = newState.selection.empty;
            const cursorPos = newState.selection.from;
            const replacements: Array<{
              from: number;
              to: number;
              trigger: string;
              item: AgentMentionItem;
            }> = [];

            newState.doc.descendants((node, pos) => {
              if (!node.isText || !node.text) return;
              const text = node.text;
              AUTO_MENTION_TOKEN_RE.lastIndex = 0;
              let match: RegExpExecArray | null;
              while ((match = AUTO_MENTION_TOKEN_RE.exec(text)) !== null) {
                const matchStart = pos + match.index;
                const trigger = match[1] ?? "";
                const rawToken = match[2] ?? "";
                const token = rawToken.replace(/[.,;:!?)}\]]+$/g, "");
                if (!token) continue;

                if (matchStart > 0) {
                  const charBefore = newState.doc.textBetween(matchStart - 1, matchStart, "\n", "");
                  if (charBefore && !/[\s([{]/.test(charBefore)) continue;
                }

                const tokenEnd = matchStart + 1 + token.length;
                if (
                  wasTypingForward &&
                  cursorEmpty &&
                  cursorPos >= matchStart &&
                  cursorPos <= tokenEnd
                ) {
                  continue;
                }

                const item =
                  trigger === "@"
                    ? (findMentionItem(token, items) ?? findMentionItem(`${token}/`, items))
                    : findMentionItem(token, AGENT_AFTER_SESSION_MENTION_ITEMS);
                if (!item || item.kind === "schedule") continue;

                replacements.push({ from: matchStart, to: tokenEnd, trigger, item });
              }
            });

            if (replacements.length === 0) return null;

            const mentionType = newState.schema.nodes.mention;
            if (!mentionType) return null;

            const tr = newState.tr;
            replacements.sort((a, b) => b.from - a.from);
            for (const r of replacements) {
              const mentionNode = mentionType.create({
                id: r.item.mentionId,
                label: r.item.label,
                mentionSuggestionChar: r.trigger,
              });
              tr.replaceWith(r.from, r.to, mentionNode);
            }
            return tr;
          },
        }),
      ];
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
  const mentionItemsRef = useRef(mentionItems);
  const onMentionSelectRef = useRef(onMentionSelect);
  mentionItemsRef.current = mentionItems;
  onMentionSelectRef.current = onMentionSelect;
  const initialEditorContent = useMemo(
    () => getInitialEditorContent(initialContent, initialBody, mentionItems),
    [initialBody, initialContent, mentionItems],
  );
  const mentionExtension = useMemo(
    () =>
      Mention.extend({
        addAttributes() {
          return {
            ...this.parent?.(),
            fullName: { default: null },
            defaultBranch: { default: null },
            binding: { default: null },
          };
        },
      }).configure({
        HTMLAttributes: {
          class: "agent-mention",
        },
        suggestions: [
          createMentionSuggestion({
            getItems: () => mentionItemsRef.current,
            onSelect: (item) => onMentionSelectRef.current?.(item),
          }),
          createMentionSuggestion({
            getItems: () => AGENT_AFTER_SESSION_MENTION_ITEMS,
            char: "#",
            showCategories: false,
          }),
        ],
        renderText({ node, suggestion }) {
          return renderMentionText(node.attrs, suggestion?.char ?? "@");
        },
        renderHTML({ options, node }) {
          const id = typeof node.attrs.id === "string" ? node.attrs.id : "";
          const char =
            typeof node.attrs.mentionSuggestionChar === "string"
              ? node.attrs.mentionSuggestionChar
              : "@";
          const kind = char === "#" ? "hook" : mentionKindFromId(id);

          return [
            "span",
            mergeAttributes(options.HTMLAttributes, kind ? { "data-kind": kind } : {}),
            renderMentionText(node.attrs),
          ];
        },
      }),
    [],
  );
  const autoMentionExtension = useMemo(
    () => createAutoMentionExtension(() => mentionItemsRef.current),
    [],
  );
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        blockquote: false,
        codeBlock: false,
        heading: { levels: [1, 2, 3] },
        horizontalRule: false,
      }),
      mentionExtension,
      autoMentionExtension,
      plainTextKeysExtension,
    ],
    content: initialEditorContent,
    editorProps: {
      attributes: {
        class: "tiptap-agent min-h-[320px] w-full text-[13.5px] leading-7 text-ink/90 outline-none",
      },
      handlePaste: (view, event) => {
        const text = event.clipboardData?.getData("text/plain");
        if (!text || (!text.includes("@") && !text.includes("#"))) return false;

        const doc = bodyToTiptapDoc(text, mentionItemsRef.current);
        if (collectMentionDisplayTexts(doc).length === 0) return false;

        const paragraphs = doc.content ?? [];
        const inline: JSONContent[] = [];
        paragraphs.forEach((paragraph, index) => {
          if (index > 0) inline.push({ type: "hardBreak" });
          inline.push(...(paragraph.content ?? []));
        });

        const { schema, tr } = view.state;
        const nodes = inline.map((node) => schema.nodeFromJSON(node));
        view.dispatch(tr.replaceSelection(new Slice(Fragment.from(nodes), 0, 0)));
        event.preventDefault();
        return true;
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
          Describe what this agent should do. Mention tools or brain files with @.
        </div>
      )}
      <EditorContent editor={editor} />
    </div>
  );
});

function getInitialEditorContent(
  content: JSONContent | null | undefined,
  body: string,
  mentionItems: AgentMentionItem[],
): JSONContent {
  const savedContentUsable = isDocumentWithContent(content);
  const mentionsRenderable = savedContentUsable ? mentionsHaveDisplayText(content) : false;
  const bodyMatchesSavedContent = savedContentUsable ? bodyMatchesContent(body, content) : false;
  const bodyMentionsRepresented = savedContentUsable
    ? contentRepresentsBodyMentions(body, content, mentionItems)
    : false;
  const useSavedContent =
    savedContentUsable && mentionsRenderable && bodyMatchesSavedContent && bodyMentionsRepresented;

  return useSavedContent ? content : bodyToTiptapDoc(body, mentionItems);
}

function isDocumentWithContent(content: JSONContent | null | undefined): content is JSONContent {
  return content?.type === "doc" && Array.isArray(content.content) && content.content.length > 0;
}

function bodyMatchesContent(body: string, content: JSONContent) {
  return normalizeBodyForComparison(tiptapDocToBody(content)) === normalizeBodyForComparison(body);
}

function normalizeBodyForComparison(body: string) {
  return body
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .join("\n\n");
}

function mentionsHaveDisplayText(node: JSONContent): boolean {
  if (node.type === "mention" && mentionDisplayText(node.attrs).length === 0) {
    return false;
  }

  return (node.content ?? []).every(mentionsHaveDisplayText);
}

function contentRepresentsBodyMentions(
  body: string,
  content: JSONContent,
  mentionItems: AgentMentionItem[],
) {
  const bodyMentions = recognizedBodyMentionDisplays(body, mentionItems);
  if (bodyMentions.length === 0) return true;

  const contentMentions = new Set(collectMentionDisplayTexts(content).map(normalizeMentionDisplay));
  return bodyMentions.every((mention) => contentMentions.has(normalizeMentionDisplay(mention)));
}

function recognizedBodyMentionDisplays(body: string, mentionItems: AgentMentionItem[]) {
  const displays: string[] = [];

  for (const rawId of extractMentionIds(body)) {
    const item = findMentionItem(rawId, mentionItems);
    if (item) displays.push(item.label);
  }

  return displays;
}

function extractMentionIds(body: string) {
  const ids: string[] = [];

  for (let index = 0; index < body.length; index += 1) {
    if (body[index] !== "@") continue;
    if (index > 0 && !/[\s([{]/.test(body[index - 1] ?? "")) continue;

    let end = index + 1;
    while (end < body.length && isMentionChar(body[end] ?? "")) end += 1;

    const id = body.slice(index + 1, end).replace(/[.,;:!?)}\]]+$/g, "");
    if (id) ids.push(id);
    index = end;
  }

  return ids;
}

function collectMentionDisplayTexts(node: JSONContent): string[] {
  const mentions: string[] = [];
  walkContent(node, [], (child) => {
    if (child.type !== "mention") return;
    const display = mentionDisplayText(child.attrs);
    if (display) mentions.push(display);
  });
  return mentions;
}

function normalizeMentionDisplay(value: string) {
  return value.trim().toLowerCase();
}

function stripEmptyMentions(node: JSONContent): JSONContent {
  if (!node.content) return node;
  const next = (node.content ?? [])
    .filter((child) => !(child.type === "mention" && mentionDisplayText(child.attrs).length === 0))
    .map(stripEmptyMentions);
  return { ...node, content: next };
}

// Thin wrapper over the shared `buildAgentTiptapDoc` parser (in
// `@opencompany/agent-runtime`, also used by the runner's self-edit path so a
// runner-built `content` round-trips identically). The web editor supplies a
// resolver backed by its rich mention catalog: `@` resolves against
// `mentionItems`, `#` against the after-session hook items, and schedule items
// never become pills.
function bodyToTiptapDoc(body: string, mentionItems: AgentMentionItem[]): JSONContent {
  const resolve: MentionResolver = (token, char) => {
    const item =
      char === "@"
        ? findMentionItem(token, mentionItems)
        : findMentionItem(token, AGENT_AFTER_SESSION_MENTION_ITEMS);
    if (!item || item.kind === "schedule") return null;
    return { id: item.mentionId, label: item.label };
  };
  return buildAgentTiptapDoc(body, resolve) as unknown as JSONContent;
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
      ...(item.kind === "integration" && item.fullName ? { fullName: item.fullName } : {}),
      ...(item.kind === "integration" && item.defaultBranch
        ? { defaultBranch: item.defaultBranch }
        : {}),
      ...(item.kind === "integration" && item.binding ? { binding: item.binding } : {}),
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
    const char =
      typeof node.attrs?.mentionSuggestionChar === "string"
        ? node.attrs.mentionSuggestionChar
        : "@";
    return displayText.length > 0 ? `${char}${displayText}` : "";
  }
  if (node.type === "heading") {
    const rawLevel = typeof node.attrs?.level === "number" ? node.attrs.level : 1;
    const level = Math.min(3, Math.max(1, Math.floor(rawLevel)));
    const inner = (node.content ?? []).map(nodeText).join("");
    return `${"#".repeat(level)} ${inner}`;
  }
  if (node.type === "bulletList" || node.type === "orderedList") {
    const ordered = node.type === "orderedList";
    const rawStart = ordered && typeof node.attrs?.start === "number" ? node.attrs.start : 1;
    const start = Number.isFinite(rawStart) && rawStart >= 1 ? Math.floor(rawStart) : 1;
    return (node.content ?? [])
      .map((item, index) => {
        const marker = ordered ? `${start + index}.` : "-";
        const inner = (item.content ?? []).map(nodeText).join("\n");
        return `${marker} ${inner}`;
      })
      .join("\n");
  }
  if (node.type === "listItem") {
    return (node.content ?? []).map(nodeText).join("\n");
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
  const id = typeof attrs?.id === "string" ? attrs.id : "";
  const idDisplay = mentionIdDisplayText(id);
  if (idDisplay) return idDisplay;

  const label = typeof attrs?.label === "string" ? attrs.label.trim() : "";
  return label;
}

function mentionIdDisplayText(id: string) {
  const trimmed = id.trim();
  if (trimmed.startsWith("tool:")) return trimmed.slice("tool:".length);
  if (trimmed.startsWith("model:")) return trimmed.slice("model:".length);
  if (trimmed.startsWith("brain/")) return trimmed;
  if (trimmed.startsWith("agent/")) return trimmed;
  if (trimmed === "integration:github") return "github";
  if (trimmed === "after-session") return "after-session";
  return "";
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
  if (id.startsWith("brain/")) return "brain";
  if (id.startsWith("agent/")) return "agent";
  return undefined;
}

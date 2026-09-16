"use client";

import { Extension, type JSONContent, Node as TiptapNode } from "@tiptap/core";
import { UndoRedo } from "@tiptap/extensions";
import { closeHistory } from "@tiptap/pm/history";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { EditorContent, useEditor } from "@tiptap/react";
import {
  type ClipboardEvent,
  type KeyboardEvent,
  type Ref,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";
import { ContextReferenceNode } from "@/components/ContextReferenceNode";
import { contextReferenceRanges, referenceMarkdown } from "@/lib/context-references";

export type ComposerInputHandle = {
  readonly element: HTMLElement | null;
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly maxLength: number;
  focus: (options?: FocusOptions) => void;
  setSelectionRange: (start: number, end: number) => void;
};
export type ComposerInputChange = { target: Pick<ComposerInputHandle, "value" | "selectionStart"> };
export type ComposerHighlight = {
  start: number;
  end: number;
  kind: string;
  mention?: { kind: string };
};

function nodeText(node: ProseMirrorNode): string {
  if (node.isText) return node.text ?? "";
  if (node.type.name === "contextReference")
    return node.attrs.raw ?? referenceMarkdown(node.attrs as { href: string; label: string });
  let text = "";
  node.forEach((child) => {
    text += nodeText(child);
  });
  return text;
}

export function composerDocument(value: string): JSONContent {
  const content: JSONContent[] = [];
  let offset = 0;
  for (const reference of contextReferenceRanges(value)) {
    if (reference.start > offset)
      content.push({ type: "text", text: value.slice(offset, reference.start) });
    content.push({
      type: "contextReference",
      attrs: { href: reference.href, label: reference.label, raw: reference.raw },
    });
    offset = reference.end;
  }
  if (offset < value.length) content.push({ type: "text", text: value.slice(offset) });
  return { type: "doc", content };
}

// The parent works in saved-text offsets; an editor atom occupies one position.
// Keeping that translation here leaves mention shortcuts and draft persistence unchanged.
function textOffset(doc: ProseMirrorNode, position: number) {
  let offset = 0;
  doc.forEach((node, pos) => {
    if (pos >= position) return;
    offset += node.isText ? Math.min(position - pos, node.nodeSize) : nodeText(node).length;
  });
  return offset;
}
function editorPosition(doc: ProseMirrorNode, offset: number) {
  let result = doc.content.size;
  let consumed = 0;
  doc.forEach((node, pos) => {
    const length = nodeText(node).length;
    if (offset >= consumed && offset < consumed + length)
      result = pos + (node.isText ? offset - consumed : offset === consumed ? 0 : 1);
    consumed += length;
  });
  return result;
}

const COMPOSER_HIGHLIGHTS = new PluginKey<ComposerHighlight[]>("composerHighlights");
const ComposerBehavior = Extension.create({
  name: "composerBehavior",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: COMPOSER_HIGHLIGHTS,
        state: {
          init: () => [],
          apply: (transaction, highlights) =>
            transaction.getMeta(COMPOSER_HIGHLIGHTS) ?? highlights,
        },
        filterTransaction: (transaction) =>
          !transaction.docChanged || nodeText(transaction.doc).length <= 10_000,
        props: {
          decorations: (state) =>
            DecorationSet.create(
              state.doc,
              (COMPOSER_HIGHLIGHTS.getState(state) ?? [])
                .map((range) =>
                  Decoration.inline(
                    editorPosition(state.doc, range.start),
                    editorPosition(state.doc, range.end),
                    {
                      class: "rounded-sm bg-ink/8 text-ink",
                      ...(range.mention
                        ? { "data-opencompany-chat-mention": range.mention.kind }
                        : { "data-opencompany-chat-directive": "background" }),
                    },
                  ),
                )
                .filter((decoration) => decoration.from < decoration.to),
            ),
        },
      }),
    ];
  },
});

export function ReferenceComposerInput({
  ref: forwardedRef,
  ...props
}: {
  ref: Ref<ComposerInputHandle>;
  id: string;
  value: string;
  placeholder: string;
  disabled?: boolean;
  readOnly?: boolean;
  highlights: ComposerHighlight[];
  onChange: (event: ComposerInputChange) => void;
  onSelectionChange: (value: string, caret: number) => void;
  onBlur: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onPaste: (event: ClipboardEvent<HTMLDivElement>) => void;
}) {
  const pendingFocus = useRef(false);
  const current = useRef(props);
  useLayoutEffect(() => {
    current.current = props;
  });
  const editor = useEditor(
    {
      immediatelyRender: false,
      extensions: [
        TiptapNode.create({ name: "doc", topNode: true, content: "inline*" }),
        TiptapNode.create({ name: "text", group: "inline" }),
        ContextReferenceNode,
        UndoRedo,
        ComposerBehavior,
      ],
      content: composerDocument(props.value),
      editorProps: {
        attributes: {
          role: "textbox",
          "aria-multiline": "true",
          id: props.id,
          "aria-label": props.placeholder,
          "data-placeholder": props.placeholder,
          class:
            "reference-composer min-h-[26px] max-h-32 w-full overflow-y-auto whitespace-pre-wrap break-words py-[3px] text-[13.5px] leading-5 text-ink outline-none",
        },
        handleKeyDown(view, event) {
          if (event.key === "Enter" && event.shiftKey && !event.isComposing) {
            view.dispatch(view.state.tr.insertText("\n"));
            return true;
          }
          return false;
        },
        handlePaste(view, event) {
          const text = event.clipboardData?.getData("text/plain") ?? "";
          const available =
            10_000 -
            (nodeText(view.state.doc).length -
              nodeText(view.state.doc.cut(view.state.selection.from, view.state.selection.to))
                .length);
          const content = composerDocument(text.slice(0, available));
          const nodes = view.state.schema.nodeFromJSON(content);
          view.dispatch(
            view.state.tr.replaceWith(
              view.state.selection.from,
              view.state.selection.to,
              nodes.content,
            ),
          );
          return true;
        },
        clipboardTextSerializer: (slice) => {
          let text = "";
          slice.content.forEach((node) => {
            text += nodeText(node);
          });
          return text;
        },
      },
      onUpdate: ({ editor }) =>
        current.current.onChange({
          target: {
            value: nodeText(editor.state.doc),
            selectionStart: textOffset(editor.state.doc, editor.state.selection.from),
          },
        }),
      onSelectionUpdate: ({ editor }) =>
        current.current.onSelectionChange(
          nodeText(editor.state.doc),
          textOffset(editor.state.doc, editor.state.selection.from),
        ),
    },
    [],
  );

  useImperativeHandle(
    forwardedRef,
    () => ({
      get element() {
        return editor?.view.dom ?? null;
      },
      get value() {
        return editor ? nodeText(editor.state.doc) : current.current.value;
      },
      get selectionStart() {
        return editor
          ? textOffset(editor.state.doc, editor.state.selection.from)
          : current.current.value.length;
      },
      get selectionEnd() {
        return editor
          ? textOffset(editor.state.doc, editor.state.selection.to)
          : current.current.value.length;
      },
      maxLength: 10_000,
      focus: (options) => {
        if (editor) editor.view.dom.focus(options);
        else pendingFocus.current = true;
      },
      setSelectionRange: (start, end) => {
        if (editor)
          editor.commands.setTextSelection({
            from: editorPosition(editor.state.doc, start),
            to: editorPosition(editor.state.doc, end),
          });
      },
    }),
    [editor],
  );

  useLayoutEffect(() => {
    if (!editor) return;
    const value = nodeText(editor.state.doc);
    if (value !== props.value) {
      // Keep a selected reference separate from the typing that opened its picker in undo
      // history. Replacing the document avoids slicing through serialized atomic links.
      const document = editor.schema.nodeFromJSON(composerDocument(props.value));
      editor.view.dispatch(
        closeHistory(editor.state.tr).replaceWith(
          0,
          editor.state.doc.content.size,
          document.content,
        ),
      );
    }
    if (pendingFocus.current) {
      pendingFocus.current = false;
      editor.view.dom.focus();
    }
    editor.view.dom.setAttribute("aria-label", props.placeholder);
    editor.view.dom.setAttribute("data-placeholder", props.placeholder);
    editor.setEditable(!props.disabled && !props.readOnly, false);
    editor.view.dom.setAttribute("aria-disabled", String(Boolean(props.disabled)));
    editor.view.dom.setAttribute("aria-readonly", String(Boolean(props.readOnly)));
    editor.view.dom.setAttribute("data-empty", String(!props.value));
    editor.view.dispatch(editor.state.tr.setMeta(COMPOSER_HIGHLIGHTS, props.highlights));
  }, [editor, props.value, props.disabled, props.readOnly, props.highlights, props.placeholder]);

  return (
    <div
      onKeyDownCapture={(event) => {
        if (!event.nativeEvent.isComposing) props.onKeyDown(event);
      }}
      onPasteCapture={props.onPaste}
      onBlur={props.onBlur}
    >
      <EditorContent editor={editor} />
    </div>
  );
}

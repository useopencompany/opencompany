"use client";

import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";
import { editorLanguageLoader } from "@/lib/coding-workspace-editor-language";

// Colours come from the app theme, so the editor follows light/dark without a second
// theme definition. See the `--color-code-*` tokens in app/globals.css.
const highlightStyle = HighlightStyle.define([
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment],
    color: "var(--color-code-comment)",
    fontStyle: "italic",
  },
  {
    tag: [
      tags.keyword,
      tags.controlKeyword,
      tags.moduleKeyword,
      tags.operatorKeyword,
      tags.self,
      tags.null,
    ],
    color: "var(--color-code-keyword)",
  },
  {
    tag: [tags.string, tags.special(tags.string), tags.regexp],
    color: "var(--color-code-string)",
  },
  {
    tag: [tags.number, tags.bool, tags.atom, tags.unit],
    color: "var(--color-code-number)",
  },
  {
    tag: [
      tags.function(tags.variableName),
      tags.function(tags.propertyName),
      tags.definition(tags.variableName),
      tags.labelName,
    ],
    color: "var(--color-code-function)",
  },
  {
    tag: [tags.typeName, tags.className, tags.namespace, tags.annotation],
    color: "var(--color-code-type)",
  },
  {
    tag: [tags.tagName, tags.heading],
    color: "var(--color-code-tag)",
    fontWeight: "600",
  },
  { tag: [tags.attributeName, tags.propertyName], color: "var(--color-code-attribute)" },
  {
    tag: [tags.meta, tags.processingInstruction, tags.punctuation, tags.operator],
    color: "var(--color-code-meta)",
  },
  { tag: tags.link, color: "var(--color-code-attribute)", textDecoration: "underline" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "600" },
  { tag: tags.invalid, color: "var(--color-danger)" },
]);

const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "12px",
    backgroundColor: "var(--color-canvas)",
    color: "var(--color-ink)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    lineHeight: "1.55",
  },
  ".cm-gutters": {
    backgroundColor: "var(--color-canvas)",
    color: "var(--color-ink-faint)",
    borderRight: "1px solid var(--color-border-subtle)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--color-code-active-line)",
    color: "var(--color-ink-muted)",
  },
  ".cm-activeLine": { backgroundColor: "var(--color-code-active-line)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--color-ink)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--color-code-selection)",
  },
  ".cm-selectionMatch": { backgroundColor: "var(--color-surface-active)" },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
    backgroundColor: "var(--color-surface-active)",
    outline: "none",
  },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--color-surface-subtle)",
    border: "none",
    color: "var(--color-ink-muted)",
  },
  ".cm-panels": {
    backgroundColor: "var(--color-surface)",
    color: "var(--color-ink)",
    borderColor: "var(--color-border)",
  },
  ".cm-panel input, .cm-panel button, .cm-panel label": { fontSize: "11px" },
  ".cm-tooltip": {
    backgroundColor: "var(--color-surface-raised)",
    borderColor: "var(--color-border)",
    color: "var(--color-ink)",
  },
});

export type CodingWorkspaceCodeEditorProps = {
  /** File the buffer belongs to. Changing it rebuilds the document. */
  path: string;
  /** Text the buffer starts from. Later values for the same path are ignored, so a save
   *  or an external refresh never discards the user's undo history and cursor. */
  initialContent: string;
  readOnly: boolean;
  /** False while the editor is hidden behind another tab. */
  active: boolean;
  onChange: (content: string) => void;
  onSave: () => void;
};

export default function CodingWorkspaceCodeEditor({
  path,
  initialContent,
  readOnly,
  active,
  onChange,
  onSave,
}: CodingWorkspaceCodeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Props are read through refs so a new closure or a post-save content update never
  // rebuilds the editor.
  const initialContentRef = useRef(initialContent);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  // Declared before the editor effect so a rebuild always reads the current props.
  useEffect(() => {
    initialContentRef.current = initialContent;
    onChangeRef.current = onChange;
    onSaveRef.current = onSave;
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const startingContent = initialContentRef.current;
    const language = new Compartment();
    const view = new EditorView({
      parent: container,
      state: EditorState.create({
        doc: startingContent,
        extensions: [
          // Ahead of basicSetup so Cmd/Ctrl+S wins over the browser's save dialog. Tab is
          // deliberately left unbound: the panel traps focus, so Tab has to stay a way out.
          keymap.of([
            {
              key: "Mod-s",
              run: () => {
                onSaveRef.current();
                return true;
              },
            },
          ]),
          // Not a fallback, and ahead of basicSetup: CodeMirror's own default style is
          // registered as a fallback there and would otherwise keep its light palette.
          syntaxHighlighting(highlightStyle),
          basicSetup,
          editorTheme,
          language.of([] as Extension),
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
          // CRLF files stay CRLF. CodeMirror otherwise rewrites every line ending and
          // turns a one-character edit into a whole-file diff.
          ...(startingContent.includes("\r\n") ? [EditorState.lineSeparator.of("\r\n")] : []),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
        ],
      }),
    });

    viewRef.current = view;
    let cancelled = false;
    const loadLanguage = editorLanguageLoader(path.split("/").at(-1) ?? path);
    if (loadLanguage) {
      void loadLanguage()
        .then((extension) => {
          if (!cancelled) view.dispatch({ effects: language.reconfigure(extension) });
        })
        .catch(() => {
          // A missing grammar only costs syntax colour; the file still opens and edits.
        });
    }

    return () => {
      cancelled = true;
      viewRef.current = null;
      view.destroy();
    };
  }, [path, readOnly]);

  // The panel keeps this editor mounted but display:none while another tab is showing,
  // so CodeMirror needs to re-measure once it is visible again.
  useEffect(() => {
    if (active) viewRef.current?.requestMeasure();
  }, [active]);

  return (
    <div
      ref={containerRef}
      className="min-h-0 flex-1 overflow-hidden"
      data-testid="workspace-code-editor"
    />
  );
}

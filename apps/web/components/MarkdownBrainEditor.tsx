"use client";

import { offset } from "@floating-ui/dom";
import { Extension } from "@tiptap/core";
import { DragHandle } from "@tiptap/extension-drag-handle-react";
import { Placeholder } from "@tiptap/extensions";
import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import { Bold, Code, GripVertical, Heading1, Heading2, Italic } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import {
  createSkillMentionDecorationPlugin,
  createSkillMentionPlugin,
} from "@/components/SkillMentionSuggestion";
import { WIKI_LINK_STATE_KEY, WikiLink, type WikiLinkState } from "@/components/WikiLinkNode";
import {
  createWikiSlashCommandPlugin,
  type WikiSlashCommandHandlers,
} from "@/components/WikiSlashCommand";
import type { SkillCatalogItem } from "@/lib/skills";

const EMPTY_BRAIN_LINKS: Record<string, string> = {};
const EMPTY_PAGE_TITLES: Record<string, string> = {};
// Stable identity: DragHandle lists computePositionConfig in an effect's deps,
// so a fresh literal per render would re-register the plugin on every re-render.
// `offset` pushes the handle a few px into the left margin so it sits just
// outside the text (which stays aligned with the page title), not on top of it.
const DRAG_HANDLE_POSITION = {
  placement: "left-start" as const,
  middleware: [offset(6)],
};
const NO_ACTIVE_MARKS = {
  isH1: false,
  isH2: false,
  isBold: false,
  isItalic: false,
  isCode: false,
};

export function MarkdownBrainEditor({
  content,
  onChange,
  brainLinks = EMPTY_BRAIN_LINKS,
  pageTitles = EMPTY_PAGE_TITLES,
  readOnly = false,
  onNavigateInternal,
  compact = false,
  placeholder = "Start writing...",
  skillMentions,
  wikiSlashCommands,
  blockHandles = false,
}: {
  content: string;
  onChange: (content: string) => void;
  brainLinks?: Record<string, string>;
  // Live titles for `page` links, keyed by slug. When a target resolves here,
  // its chip renders this title instead of the authored label, so renaming a
  // page updates every link to it instantly (Notion-style).
  pageTitles?: Record<string, string>;
  readOnly?: boolean;
  // Handle an internal brain href client-side. Return true if handled; when
  // omitted or it returns false, the link falls back to a full-page navigation.
  onNavigateInternal?: (href: string) => boolean;
  // Smaller min-height/type scale for embedding in a bordered form field
  // (e.g. workflow/skill instructions) instead of a full brain document page.
  compact?: boolean;
  placeholder?: string;
  // When set, typing "@" opens an autocomplete of these skills and inserts
  // literal `@skill/<id>` text — the same token workflow-tasks.ts already
  // resolves at fire time. Captured once at mount, like `content`; callers
  // that need this pass a stable, server-fetched catalog.
  skillMentions?: SkillCatalogItem[];
  // Wiki surfaces only: typing "/" opens a Notion-style command menu (e.g.
  // "page" creates a sub-page). Captured once at mount like skillMentions.
  wikiSlashCommands?: WikiSlashCommandHandlers;
  // Full-document surfaces (wiki page body): show a Notion-style drag handle in
  // the left gutter to grab and reorder blocks. Off for compact form fields.
  blockHandles?: boolean;
}) {
  const [initialContent] = useState(() => content);
  const onChangeRef = useRef(onChange);
  const readOnlyRef = useRef(readOnly);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  // Callers routinely pass a fresh navigation closure on every render; route it
  // through a ref with a stable wrapper so it never invalidates the plugin-state
  // effect below (re-dispatching per render loops onUpdate → parent setState).
  const navigateRef = useRef(onNavigateInternal);
  useEffect(() => {
    navigateRef.current = onNavigateInternal;
  }, [onNavigateInternal]);
  const [navigateInternal] = useState(() => (href: string) => navigateRef.current?.(href) ?? false);
  const editor = useEditor(
    {
      immediatelyRender: false,
      extensions: [
        // Regular markdown links default to target="_blank" + a window.open click
        // handler in tiptap's Link extension; disable both so the wiki plugin's
        // handleClick can route internal hrefs same-tab like wiki chips.
        StarterKit.configure({
          link: { openOnClick: false, HTMLAttributes: { target: null } },
        }),
        Markdown.configure({
          indentation: { style: "space", size: 2 },
          markedOptions: { gfm: true, breaks: false },
        }),
        Placeholder.configure({
          // Show the hint whenever the whole doc is empty, focused or not (the
          // CSS targets `.is-editor-empty:first-child`, so per-line empties are
          // ignored). Read-only surfaces still get a hint ("No content yet.").
          showOnlyWhenEditable: false,
          showOnlyCurrent: false,
          placeholder: ({ editor }) => (editor.isEditable ? placeholder : "No content yet."),
        }),
        WikiLink.configure({
          initialState: {
            brainLinks,
            pageTitles,
            editingEnabled: !readOnly,
            onNavigateInternal: navigateInternal,
          },
        }),
        ...(wikiSlashCommands
          ? [
              Extension.create({
                name: "wikiSlashCommand",
                addProseMirrorPlugins() {
                  if (readOnly) return [];
                  return [createWikiSlashCommandPlugin(this.editor, wikiSlashCommands)];
                },
              }),
            ]
          : []),
        ...(skillMentions
          ? [
              Extension.create({
                name: "skillMention",
                addProseMirrorPlugins() {
                  // Always paint mention chips; only wire the "@" typeahead when
                  // the field is editable.
                  const plugins = [createSkillMentionDecorationPlugin()];
                  if (!readOnly) {
                    plugins.unshift(createSkillMentionPlugin(this.editor, skillMentions));
                  }
                  return plugins;
                },
              }),
            ]
          : []),
      ],
      content: initialContent,
      contentType: "markdown",
      editable: !readOnly,
      editorProps: {
        attributes: {
          class: compact
            ? "tiptap-brain tiptap-brain-compact min-h-[220px] w-full text-[13.5px] leading-6 text-ink outline-none"
            : "tiptap-brain min-h-[560px] w-full pb-20 text-[15px] leading-7 text-ink outline-none",
        },
      },
      onUpdate: ({ editor }) => {
        if (readOnlyRef.current) return;
        onChangeRef.current(editor.getMarkdown());
      },
    },
    [],
  );

  // Subscribe to just the toolbar's active-mark state so typing no longer
  // re-renders this component on every keystroke or selection change. BubbleMenu
  // owns its own show/hide and positioning.
  const toolbar =
    useEditorState({
      editor,
      selector: ({ editor }) =>
        editor
          ? {
              isH1: editor.isActive("heading", { level: 1 }),
              isH2: editor.isActive("heading", { level: 2 }),
              isBold: editor.isActive("bold"),
              isItalic: editor.isActive("italic"),
              isCode: editor.isActive("code"),
            }
          : NO_ACTIVE_MARKS,
    }) ?? NO_ACTIVE_MARKS;

  useEffect(() => {
    readOnlyRef.current = readOnly;
    if (!editor) return;
    // Never emit "update" here: tiptap's setEditable emits unconditionally, which
    // would fire onUpdate → onChange without a real edit (phantom dirty/autosave).
    if (editor.isEditable !== !readOnly) editor.setEditable(!readOnly, false);
    const current = WIKI_LINK_STATE_KEY.getState(editor.state);
    if (
      current &&
      current.brainLinks === brainLinks &&
      current.pageTitles === pageTitles &&
      current.editingEnabled === !readOnly
    ) {
      return;
    }
    editor.view.dispatch(
      editor.state.tr.setMeta(WIKI_LINK_STATE_KEY, {
        brainLinks,
        pageTitles,
        editingEnabled: !readOnly,
        onNavigateInternal: navigateInternal,
      } satisfies WikiLinkState),
    );
  }, [brainLinks, editor, navigateInternal, pageTitles, readOnly]);

  return (
    <div className="relative">
      {editor && !readOnly ? (
        <BubbleMenu
          editor={editor}
          className="flex items-center gap-0.5 rounded-lg border border-black/[0.08] bg-surface-raised p-1 shadow-[0_12px_28px_rgba(0,0,0,0.14),0_2px_8px_rgba(0,0,0,0.08)]"
        >
          <FormatButton
            label="Heading 1"
            active={toolbar.isH1}
            onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
          >
            <Heading1 size={14} strokeWidth={1.8} />
          </FormatButton>
          <FormatButton
            label="Heading 2"
            active={toolbar.isH2}
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          >
            <Heading2 size={14} strokeWidth={1.8} />
          </FormatButton>
          <Divider />
          <FormatButton
            label="Bold"
            active={toolbar.isBold}
            onClick={() => editor.chain().focus().toggleBold().run()}
          >
            <Bold size={14} strokeWidth={1.9} />
          </FormatButton>
          <FormatButton
            label="Italic"
            active={toolbar.isItalic}
            onClick={() => editor.chain().focus().toggleItalic().run()}
          >
            <Italic size={14} strokeWidth={1.9} />
          </FormatButton>
          <FormatButton
            label="Inline code"
            active={toolbar.isCode}
            onClick={() => editor.chain().focus().toggleCode().run()}
          >
            <Code size={14} strokeWidth={1.9} />
          </FormatButton>
        </BubbleMenu>
      ) : null}

      {editor && blockHandles && !readOnly ? (
        <DragHandle
          editor={editor}
          className="wiki-drag-handle"
          computePositionConfig={DRAG_HANDLE_POSITION}
        >
          <span className="wiki-drag-handle-grip" aria-hidden="true">
            <GripVertical size={15} strokeWidth={1.8} />
          </span>
        </DragHandle>
      ) : null}

      <EditorContent editor={editor} />
    </div>
  );
}

function FormatButton({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean | undefined;
  disabled?: boolean | undefined;
  onClick: () => void | boolean | undefined;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:opacity-35 ${
        active
          ? "bg-surface-active text-ink"
          : "text-ink-muted hover:bg-surface-subtle hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span className="mx-1 h-4 w-px bg-border" />;
}

"use client";

import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import { Bold, Code, Heading1, Heading2, Italic } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";

export function MarkdownGoatBrainEditor({
  content,
  onChange,
}: {
  content: string;
  onChange: (content: string) => void;
}) {
  const [isEmpty, setIsEmpty] = useState(content.trim().length === 0);
  const [, refreshToolbar] = useState(0);
  const [initialContent] = useState(() => content);
  const editor = useEditor(
    {
      immediatelyRender: false,
      extensions: [
        StarterKit,
        Markdown.configure({
          indentation: { style: "space", size: 2 },
          markedOptions: { gfm: true, breaks: false },
        }),
      ],
      content: initialContent,
      contentType: "markdown",
      editorProps: {
        attributes: {
          class:
            "tiptap-brain min-h-[560px] w-full pb-20 text-[15px] leading-7 text-ink outline-none",
        },
      },
      onCreate: ({ editor }) => {
        setIsEmpty(editor.isEmpty);
      },
      onSelectionUpdate: () => {
        refreshToolbar((value) => value + 1);
      },
      onUpdate: ({ editor }) => {
        setIsEmpty(editor.isEmpty);
        refreshToolbar((value) => value + 1);
        onChange(editor.getMarkdown());
      },
    },
    [],
  );

  return (
    <div className="relative">
      {editor ? (
        <BubbleMenu
          editor={editor}
          className="flex items-center gap-0.5 rounded-lg border border-black/[0.08] bg-surface-raised p-1 shadow-[0_12px_28px_rgba(0,0,0,0.14),0_2px_8px_rgba(0,0,0,0.08)]"
        >
          <FormatButton
            label="Heading 1"
            active={editor.isActive("heading", { level: 1 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
          >
            <Heading1 size={14} strokeWidth={1.8} />
          </FormatButton>
          <FormatButton
            label="Heading 2"
            active={editor.isActive("heading", { level: 2 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          >
            <Heading2 size={14} strokeWidth={1.8} />
          </FormatButton>
          <Divider />
          <FormatButton
            label="Bold"
            active={editor.isActive("bold")}
            onClick={() => editor.chain().focus().toggleBold().run()}
          >
            <Bold size={14} strokeWidth={1.9} />
          </FormatButton>
          <FormatButton
            label="Italic"
            active={editor.isActive("italic")}
            onClick={() => editor.chain().focus().toggleItalic().run()}
          >
            <Italic size={14} strokeWidth={1.9} />
          </FormatButton>
          <FormatButton
            label="Inline code"
            active={editor.isActive("code")}
            onClick={() => editor.chain().focus().toggleCode().run()}
          >
            <Code size={14} strokeWidth={1.9} />
          </FormatButton>
        </BubbleMenu>
      ) : null}

      <div className="relative">
        {isEmpty ? (
          <div className="pointer-events-none absolute left-0 top-0 text-[15px] leading-7 text-ink-subtle/70">
            Start writing...
          </div>
        ) : null}
        <EditorContent editor={editor} />
      </div>
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

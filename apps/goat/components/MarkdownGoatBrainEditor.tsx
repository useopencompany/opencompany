"use client";

import { parseGoatBrainInlineLinks } from "@opencompany/goat-brain/inline-links";
import { Extension } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { EditorContent, useEditor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import { Bold, Code, Heading1, Heading2, Italic } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";

export function MarkdownGoatBrainEditor({
  content,
  onChange,
  brainLinks = {},
}: {
  content: string;
  onChange: (content: string) => void;
  brainLinks?: Record<string, string>;
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
        WikiLinkDecoration.configure({ brainLinks }),
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

const WIKI_LINK_ICON =
  '<svg class="wiki-brain-chip-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><line x1="8" x2="16" y1="12" y2="12"/></svg>';

const WikiLinkDecoration = Extension.create<{ brainLinks: Record<string, string> }>({
  name: "wikiLinkDecoration",
  addOptions() {
    return { brainLinks: {} };
  },
  addProseMirrorPlugins() {
    const links = this.options.brainLinks;
    return [
      new Plugin({
        props: {
          decorations(state) {
            const decorations: Decoration[] = [];
            const { from, to } = state.selection;
            state.doc.descendants((node, pos) => {
              if (!node.isText || !node.text) return;
              for (const link of parseGoatBrainInlineLinks(node.text)) {
                const href = inlineLinkHref(link, links) ?? "";
                const start = pos + link.index;
                const end = start + link.raw.length;
                const bounds = linkLabelBounds(link.raw);
                const label = link.raw.slice(bounds.labelStart, bounds.labelEnd).trim();
                // Reveal the raw markup for editing while the caret sits inside/adjacent.
                const editing = from <= end && to >= start;

                if (editing) {
                  if (bounds.labelStart > 0) {
                    decorations.push(
                      Decoration.inline(start, start + bounds.labelStart, {
                        class: "wiki-brain-syntax",
                      }),
                    );
                  }
                  if (bounds.labelEnd < link.raw.length) {
                    decorations.push(
                      Decoration.inline(start + bounds.labelEnd, end, {
                        class: "wiki-brain-syntax",
                      }),
                    );
                  }
                  decorations.push(
                    Decoration.inline(start + bounds.labelStart, start + bounds.labelEnd, {
                      class: href
                        ? "wiki-brain-link"
                        : "wiki-brain-link wiki-brain-link-unresolved",
                      title: href ? "Open brain link" : "Unresolved brain link",
                      ...(href ? { "data-brain-href": href } : {}),
                    }),
                  );
                  continue;
                }

                // Collapsed: hide the raw markup and render a compact chip in its place.
                decorations.push(Decoration.inline(start, end, { class: "wiki-brain-hidden" }));
                decorations.push(
                  Decoration.widget(start, () => buildWikiChip(label, href), {
                    side: -1,
                    marks: [],
                    key: `wiki:${href || "unresolved"}:${label}`,
                    ignoreSelection: true,
                  }),
                );
              }
            });
            return DecorationSet.create(state.doc, decorations);
          },
          handleClick(_view, _pos, event) {
            const target = event.target instanceof Element ? event.target : null;
            const href = target?.closest("[data-brain-href]")?.getAttribute("data-brain-href");
            if (!href) return false;
            event.preventDefault();
            window.location.href = href;
            return true;
          },
        },
      }),
    ];
  },
});

function buildWikiChip(label: string, href: string): HTMLElement {
  const chip = document.createElement("span");
  chip.className = href ? "wiki-brain-chip" : "wiki-brain-chip wiki-brain-chip-unresolved";
  chip.title = href ? "Open brain link" : "Unresolved brain link";
  chip.innerHTML = WIKI_LINK_ICON;
  const text = document.createElement("span");
  text.className = "wiki-brain-chip-label";
  text.textContent = label || "Untitled";
  chip.appendChild(text);
  if (href) {
    chip.setAttribute("data-brain-href", href);
    chip.setAttribute("role", "link");
    chip.addEventListener("mousedown", (event) => {
      event.preventDefault();
      window.location.href = href;
    });
  }
  return chip;
}

// Offsets of the visible label within a raw link token like `[[page:slug|Title]]`.
function linkLabelBounds(raw: string): { labelStart: number; labelEnd: number } {
  if (raw.startsWith("[[") && raw.endsWith("]]")) {
    const innerStart = 2;
    const innerEnd = raw.length - 2;
    const pipe = raw.indexOf("|", innerStart);
    if (pipe !== -1 && pipe < innerEnd) {
      return { labelStart: pipe + 1, labelEnd: innerEnd };
    }
    const colon = raw.indexOf(":", innerStart);
    if (colon !== -1 && colon < innerEnd) {
      const prefix = raw.slice(innerStart, colon);
      if (prefix === "page" || prefix === "evidence" || prefix === "source") {
        return { labelStart: colon + 1, labelEnd: innerEnd };
      }
    }
    return { labelStart: innerStart, labelEnd: innerEnd };
  }
  // Legacy evidence citation `[^ev:...]`.
  const colon = raw.indexOf(":");
  if (raw.startsWith("[^") && raw.endsWith("]") && colon !== -1) {
    return { labelStart: colon + 1, labelEnd: raw.length - 1 };
  }
  return { labelStart: 0, labelEnd: raw.length };
}

function inlineLinkHref(
  link: ReturnType<typeof parseGoatBrainInlineLinks>[number],
  links: Record<string, string>,
) {
  return links[`${link.kind}:${link.target}`] ?? (link.kind === "page" ? links[link.target] : "");
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

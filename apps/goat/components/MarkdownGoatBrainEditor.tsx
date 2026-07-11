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
import { useEffect, useRef, useState } from "react";
import { isExternalHref, sourceChipDisplay, sourceHrefForRef } from "@/lib/brain-source-links";

export function MarkdownGoatBrainEditor({
  content,
  onChange,
  brainLinks = {},
  readOnly = false,
  onNavigateInternal,
}: {
  content: string;
  onChange: (content: string) => void;
  brainLinks?: Record<string, string>;
  readOnly?: boolean;
  // Handle an internal brain href client-side. Return true if handled; when
  // omitted or it returns false, the link falls back to a full-page navigation.
  onNavigateInternal?: (href: string) => boolean;
}) {
  const [isEmpty, setIsEmpty] = useState(content.trim().length === 0);
  const [, refreshToolbar] = useState(0);
  const [initialContent] = useState(() => content);
  // Keep the latest navigation handler reachable from the ProseMirror plugin,
  // which is created once (useEditor deps are []) and would otherwise capture a
  // stale closure.
  const navigateRef = useRef(onNavigateInternal);
  useEffect(() => {
    navigateRef.current = onNavigateInternal;
  }, [onNavigateInternal]);
  const [navigateInternal] = useState(() => (href: string) => navigateRef.current?.(href) ?? false);
  const editor = useEditor(
    {
      immediatelyRender: false,
      extensions: [
        StarterKit,
        Markdown.configure({
          indentation: { style: "space", size: 2 },
          markedOptions: { gfm: true, breaks: false },
        }),
        WikiLinkDecoration.configure({ brainLinks, onNavigateInternal: navigateInternal }),
      ],
      content: initialContent,
      contentType: "markdown",
      editable: !readOnly,
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
        if (readOnly) return;
        setIsEmpty(editor.isEmpty);
        refreshToolbar((value) => value + 1);
        onChange(editor.getMarkdown());
      },
    },
    [],
  );

  return (
    <div className="relative">
      {editor && !readOnly ? (
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
            {readOnly ? "No content yet." : "Start writing..."}
          </div>
        ) : null}
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

const WIKI_LINK_ICON =
  '<svg class="wiki-brain-chip-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><line x1="8" x2="16" y1="12" y2="12"/></svg>';

const GITHUB_ICON =
  '<svg class="wiki-brain-chip-icon wiki-brain-chip-icon-github" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>';

const WikiLinkDecoration = Extension.create<{
  brainLinks: Record<string, string>;
  onNavigateInternal?: (href: string) => boolean;
}>({
  name: "wikiLinkDecoration",
  addOptions() {
    return { brainLinks: {} };
  },
  addProseMirrorPlugins() {
    const links = this.options.brainLinks;
    const onNavigate = this.options.onNavigateInternal;
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
                      title: href ? linkTitle(link.kind, href) : unresolvedLinkTitle(link.kind),
                      ...(href ? { "data-brain-href": href } : {}),
                    }),
                  );
                  continue;
                }

                // Collapsed: hide the raw markup and render a compact chip in its place.
                const chip =
                  link.kind === "source"
                    ? sourceChipDisplay(link.target, label)
                    : { icon: "link" as const, label };
                // Preserve the fuller authored label as a tooltip when we shorten it.
                const chipTitle = chip.label !== label ? label : undefined;
                decorations.push(Decoration.inline(start, end, { class: "wiki-brain-hidden" }));
                decorations.push(
                  Decoration.widget(
                    start,
                    () =>
                      buildWikiChip(chip.label, href, link.kind, chip.icon, chipTitle, onNavigate),
                    {
                      side: -1,
                      marks: [],
                      key: `wiki:${href || "unresolved"}:${chip.icon}:${chip.label}`,
                      ignoreSelection: true,
                    },
                  ),
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
            openDecoratedHref(href, onNavigate);
            return true;
          },
        },
      }),
    ];
  },
});

function buildWikiChip(
  label: string,
  href: string,
  kind: ReturnType<typeof parseGoatBrainInlineLinks>[number]["kind"],
  icon: "github" | "link" = "link",
  title?: string,
  onNavigate?: (href: string) => boolean,
): HTMLElement {
  const chip = document.createElement("span");
  chip.className = href ? "wiki-brain-chip" : "wiki-brain-chip wiki-brain-chip-unresolved";
  chip.title = title ?? (href ? linkTitle(kind, href) : unresolvedLinkTitle(kind));
  chip.innerHTML = icon === "github" ? GITHUB_ICON : WIKI_LINK_ICON;
  const text = document.createElement("span");
  text.className = "wiki-brain-chip-label";
  text.textContent = label || "Untitled";
  chip.appendChild(text);
  if (href) {
    chip.setAttribute("data-brain-href", href);
    chip.setAttribute("role", "link");
    chip.addEventListener("mousedown", (event) => {
      event.preventDefault();
      openDecoratedHref(href, onNavigate);
    });
  }
  return chip;
}

function linkTitle(
  kind: ReturnType<typeof parseGoatBrainInlineLinks>[number]["kind"],
  href: string,
) {
  if (kind === "source" || isExternalHref(href)) return "Open source";
  return "Open brain link";
}

function unresolvedLinkTitle(kind: ReturnType<typeof parseGoatBrainInlineLinks>[number]["kind"]) {
  return kind === "source" ? "Unresolved source link" : "Unresolved brain link";
}

function openDecoratedHref(href: string, onNavigate?: (href: string) => boolean) {
  if (isExternalHref(href)) {
    window.open(href, "_blank", "noopener,noreferrer");
    return;
  }
  // Prefer client-side navigation (same instant behavior as the sidebar); fall
  // back to a full navigation when the target isn't in the current brain view.
  if (onNavigate?.(href)) return;
  window.location.href = href;
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
  const mapped = links[`${link.kind}:${link.target}`];
  if (mapped) return mapped;
  if (link.kind === "page") return links[link.target] ?? "";
  if (link.kind === "source") return sourceHrefForRef(link.target) ?? "";
  return "";
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

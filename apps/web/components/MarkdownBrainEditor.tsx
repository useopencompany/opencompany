"use client";

import { parseBrainInlineLinks } from "@opencompany/brain/inline-links";
import { Extension } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { EditorContent, useEditor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import { Bold, Code, Heading1, Heading2, Italic } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import {
  createSkillMentionDecorationPlugin,
  createSkillMentionPlugin,
} from "@/components/SkillMentionSuggestion";
import {
  createWikiSlashCommandPlugin,
  type WikiSlashCommandHandlers,
} from "@/components/WikiSlashCommand";
import { isExternalHref, sourceChipDisplay, sourceHrefForRef } from "@/lib/brain-source-links";
import type { SkillCatalogItem } from "@/lib/skills";

const EMPTY_BRAIN_LINKS: Record<string, string> = {};
const EMPTY_PAGE_TITLES: Record<string, string> = {};

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
}) {
  const [isEmpty, setIsEmpty] = useState(content.trim().length === 0);
  const [, refreshToolbar] = useState(0);
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
        WikiLinkDecoration.configure({
          brainLinks,
          pageTitles,
          editingEnabled: !readOnly,
          onNavigateInternal: navigateInternal,
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
      onCreate: ({ editor }) => {
        setIsEmpty(editor.isEmpty);
      },
      onSelectionUpdate: () => {
        refreshToolbar((value) => value + 1);
      },
      onUpdate: ({ editor }) => {
        if (readOnlyRef.current) return;
        setIsEmpty(editor.isEmpty);
        refreshToolbar((value) => value + 1);
        onChangeRef.current(editor.getMarkdown());
      },
    },
    [],
  );

  useEffect(() => {
    readOnlyRef.current = readOnly;
    if (!editor) return;
    // Never emit "update" here: tiptap's setEditable emits unconditionally, which
    // would fire onUpdate → onChange without a real edit (phantom dirty/autosave).
    if (editor.isEditable !== !readOnly) editor.setEditable(!readOnly, false);
    const current = WIKI_LINK_PLUGIN_KEY.getState(editor.state);
    if (
      current &&
      current.brainLinks === brainLinks &&
      current.pageTitles === pageTitles &&
      current.editingEnabled === !readOnly
    ) {
      return;
    }
    editor.view.dispatch(
      editor.state.tr.setMeta(WIKI_LINK_PLUGIN_KEY, {
        brainLinks,
        pageTitles,
        editingEnabled: !readOnly,
        onNavigateInternal: navigateInternal,
      } satisfies WikiLinkPluginState),
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
          <div
            className={`pointer-events-none absolute left-0 top-0 text-ink-subtle/70 ${
              compact ? "text-[13.5px] leading-6" : "text-[15px] leading-7"
            }`}
          >
            {readOnly ? "No content yet." : placeholder}
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

type WikiLinkPluginState = {
  brainLinks: Record<string, string>;
  pageTitles: Record<string, string>;
  editingEnabled: boolean;
  onNavigateInternal: ((href: string) => boolean) | undefined;
};

const WIKI_LINK_PLUGIN_KEY = new PluginKey<WikiLinkPluginState>("wikiLinkDecoration");

const WikiLinkDecoration = Extension.create<WikiLinkPluginState>({
  name: "wikiLinkDecoration",
  addOptions() {
    return { brainLinks: {}, pageTitles: {}, editingEnabled: true, onNavigateInternal: undefined };
  },
  addProseMirrorPlugins() {
    const initialState = this.options;
    return [
      new Plugin({
        key: WIKI_LINK_PLUGIN_KEY,
        state: {
          init: () => initialState,
          apply(transaction, value) {
            return transaction.getMeta(WIKI_LINK_PLUGIN_KEY) ?? value;
          },
        },
        props: {
          decorations(state) {
            const pluginState = WIKI_LINK_PLUGIN_KEY.getState(state) ?? initialState;
            const decorations: Decoration[] = [];
            const { from, to } = state.selection;
            const links = pluginState.brainLinks;
            state.doc.descendants((node, pos) => {
              if (!node.isTextblock || node.type.spec.code) return;
              for (const run of inlineTextRuns(node, pos + 1)) {
                for (const link of parseBrainInlineLinks(run.text)) {
                  const href = inlineLinkHref(link, links) ?? "";
                  const start = run.start + link.index;
                  const end = start + link.raw.length;
                  const bounds = linkLabelBounds(link.raw);
                  const label = link.raw.slice(bounds.labelStart, bounds.labelEnd).trim();
                  // Reveal the raw markup for editing while the caret sits inside/adjacent.
                  const editing = pluginState.editingEnabled && from <= end && to >= start;

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
                  // Page links prefer the target's live title over the authored
                  // label, so renames propagate to every referencing document.
                  const liveTitle =
                    link.kind === "page" ? pluginState.pageTitles[link.target] : undefined;
                  const chip =
                    link.kind === "source"
                      ? sourceChipDisplay(link.target, label)
                      : { icon: "link" as const, label: liveTitle || label };
                  // Preserve the fuller authored label as a tooltip when we shorten
                  // it — but not when the live page title replaced it on purpose.
                  const chipTitle = !liveTitle && chip.label !== label ? label : undefined;
                  decorations.push(Decoration.inline(start, end, { class: "wiki-brain-hidden" }));
                  decorations.push(
                    Decoration.widget(
                      start,
                      (view) =>
                        buildWikiChip(
                          chip.label,
                          href,
                          link.kind,
                          chip.icon,
                          chipTitle,
                          () => WIKI_LINK_PLUGIN_KEY.getState(view.state) ?? initialState,
                        ),
                      {
                        side: -1,
                        marks: [],
                        key: `wiki:${href || "unresolved"}:${chip.icon}:${chip.label}`,
                        ignoreSelection: true,
                      },
                    ),
                  );
                }
              }
              return false;
            });
            return DecorationSet.create(state.doc, decorations);
          },
          handleClick(view, _pos, event) {
            const target = event.target instanceof Element ? event.target : null;
            const decoratedLink = target?.closest("[data-brain-href]");
            const href = decoratedLink?.getAttribute("data-brain-href");
            if (!href) return false;

            // Widget decorations are real anchors. Preserve their native external,
            // modifier-key, and full-page navigation behavior, only intercepting a
            // plain internal click when the latest client-side handler accepts it.
            if (decoratedLink instanceof HTMLAnchorElement) {
              if (
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey ||
                isExternalHref(href)
              ) {
                return false;
              }
              const pluginState = WIKI_LINK_PLUGIN_KEY.getState(view.state) ?? initialState;
              if (!pluginState.onNavigateInternal?.(href)) return false;
              event.preventDefault();
              return true;
            }

            event.preventDefault();
            const pluginState = WIKI_LINK_PLUGIN_KEY.getState(view.state) ?? initialState;
            openDecoratedHref(href, pluginState.onNavigateInternal);
            return true;
          },
          handleDOMEvents: {
            click(view, event) {
              const target = event.target instanceof Element ? event.target : null;
              // Decorated wiki links are handled above (and chips carry their own
              // click listener); this only covers regular tiptap Link marks.
              if (target?.closest("[data-brain-href]")) return false;
              return handlePlainLinkClick(view, event, target, initialState);
            },
          },
        },
      }),
    ];
  },
});

function buildWikiChip(
  label: string,
  href: string,
  kind: ReturnType<typeof parseBrainInlineLinks>[number]["kind"],
  icon: "github" | "link" = "link",
  title?: string,
  getPluginState?: () => WikiLinkPluginState,
): HTMLElement {
  const chip = document.createElement(href ? "a" : "span");
  chip.className = href ? "wiki-brain-chip" : "wiki-brain-chip wiki-brain-chip-unresolved";
  chip.title = title ?? (href ? linkTitle(kind, href) : unresolvedLinkTitle(kind));
  chip.innerHTML = icon === "github" ? GITHUB_ICON : WIKI_LINK_ICON;
  const text = document.createElement("span");
  text.className = "wiki-brain-chip-label";
  text.textContent = label || "Untitled";
  chip.appendChild(text);
  if (href) {
    chip.setAttribute("href", href);
    chip.setAttribute("data-brain-href", href);
    if (isExternalHref(href)) {
      chip.setAttribute("target", "_blank");
      chip.setAttribute("rel", "noopener noreferrer");
    }
    chip.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!(event instanceof MouseEvent)) return;
      if (
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        isExternalHref(href)
      ) {
        return;
      }
      if (getPluginState?.().onNavigateInternal?.(href)) event.preventDefault();
    });
  }
  return chip;
}

type InlineTextRun = { text: string; start: number };

function inlineTextRuns(node: ProseMirrorNode, contentStart: number): InlineTextRun[] {
  const runs: InlineTextRun[] = [];
  let current: InlineTextRun | null = null;
  const flush = () => {
    if (current?.text) runs.push(current);
    current = null;
  };

  node.forEach((child, offset) => {
    const text = child.isText ? child.text : null;
    const isCode = child.marks.some((mark) => mark.type.name === "code");
    if (!text || isCode) {
      flush();
      return;
    }

    const start = contentStart + offset;
    if (!current || current.start + current.text.length !== start) {
      flush();
      current = { text, start };
      return;
    }
    current.text += text;
  });
  flush();
  return runs;
}

function linkTitle(kind: ReturnType<typeof parseBrainInlineLinks>[number]["kind"], href: string) {
  if (kind === "source" || isExternalHref(href)) return "Open source";
  return "Open brain link";
}

function unresolvedLinkTitle(kind: ReturnType<typeof parseBrainInlineLinks>[number]["kind"]) {
  return kind === "source" ? "Unresolved source link" : "Unresolved brain link";
}

// Regular markdown links (tiptap Link marks) have no wiki decoration. Plain
// left-clicks navigate internal hrefs same-tab (client-side when possible) and
// external hrefs in a new tab; modifier clicks keep native browser behavior.
function handlePlainLinkClick(
  view: EditorView,
  event: MouseEvent,
  target: Element | null,
  initialState: WikiLinkPluginState,
): boolean {
  const anchor = target?.closest("a[href]");
  if (!(anchor instanceof HTMLAnchorElement) || !view.dom.contains(anchor)) return false;
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return false;
  }
  const href = anchor.getAttribute("href");
  if (!href) return false;
  event.preventDefault();
  const pluginState = WIKI_LINK_PLUGIN_KEY.getState(view.state) ?? initialState;
  openDecoratedHref(href, pluginState.onNavigateInternal);
  return true;
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
  link: ReturnType<typeof parseBrainInlineLinks>[number],
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

"use client";

import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { ReactRenderer } from "@tiptap/react";
import { Suggestion, type SuggestionOptions } from "@tiptap/suggestion";
import { Sparkles } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import type { SkillCatalogItem } from "@/lib/skills";

// Workflow instructions are plain markdown compiled server-side
// (extractWorkflowSkillMentionRefs in lib/workflow-tasks.ts scans the raw
// text for `@skill/<id>` tokens when the workflow fires) — so this extension
// only needs to make that token easy to discover and type correctly. It
// inserts literal `@skill/<id>` text, not a special mention node, so it
// round-trips through the Markdown extension like any other text.
export function filterSkillMentionItems(
  skills: SkillCatalogItem[],
  query: string,
): SkillCatalogItem[] {
  const q = query.trim().toLowerCase();
  const matches = q
    ? skills.filter((skill) =>
        `${skill.id} ${skill.name} ${skill.description}`.toLowerCase().includes(q),
      )
    : skills;
  return matches.slice(0, 8);
}

export function skillMentionInsertText(skill: SkillCatalogItem): string {
  return `@skill/${skill.id} `;
}

type SkillMentionListProps = {
  items: SkillCatalogItem[];
  command: (item: SkillCatalogItem) => void;
};

type SkillMentionListHandle = {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
};

const SkillMentionList = forwardRef<SkillMentionListHandle, SkillMentionListProps>(
  function SkillMentionList({ items, command }, ref) {
    const [index, setIndex] = useState(0);

    useEffect(() => {
      setIndex(0);
    }, []);

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }) => {
        if (items.length === 0) return false;
        if (event.key === "ArrowDown") {
          setIndex((current) => (current + 1) % items.length);
          return true;
        }
        if (event.key === "ArrowUp") {
          setIndex((current) => (current - 1 + items.length) % items.length);
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          const item = items[index];
          if (item) command(item);
          return true;
        }
        return false;
      },
    }));

    if (items.length === 0) {
      return (
        <div className="w-72 rounded-lg border border-border bg-surface px-3 py-2.5 text-[12.5px] leading-4 text-ink-subtle shadow-[0_8px_24px_rgba(15,15,15,0.12)]">
          No matching skills
        </div>
      );
    }

    return (
      <div
        role="listbox"
        aria-label="Skill mentions"
        className="max-h-72 w-80 overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-[0_8px_24px_rgba(15,15,15,0.12)]"
      >
        {items.map((item, itemIndex) => (
          <button
            key={item.id}
            type="button"
            role="option"
            aria-selected={itemIndex === index}
            onMouseEnter={() => setIndex(itemIndex)}
            onMouseDown={(event) => {
              event.preventDefault();
              command(item);
            }}
            className={`flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left transition-colors duration-150 hover:bg-surface-hover focus:bg-surface-hover focus:outline-none ${
              itemIndex === index ? "bg-surface-hover" : ""
            }`}
          >
            <Sparkles size={14} strokeWidth={2} className="mt-0.5 shrink-0 text-ink-subtle" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium leading-4 text-ink">
                @skill/{item.id}
              </span>
              <span className="mt-0.5 block truncate text-[12px] leading-4 text-ink-subtle">
                {item.name}
                {item.description ? ` · ${item.description}` : ""}
              </span>
            </span>
          </button>
        ))}
      </div>
    );
  },
);

// `skills` is captured once (the workflow editor passes a static server-fetched
// catalog for the lifetime of the page), so no ref/live-update plumbing is
// needed here — unlike `brainLinks` in MarkdownBrainEditor, which changes
// while a Brain document stays mounted.
export function createSkillMentionSuggestion(
  skills: SkillCatalogItem[],
): Omit<SuggestionOptions<SkillCatalogItem>, "editor"> {
  return {
    char: "@",
    allowSpaces: false,
    items: ({ query }) => filterSkillMentionItems(skills, query),
    command: ({ editor, range, props }) => {
      editor.chain().focus().insertContentAt(range, skillMentionInsertText(props)).run();
    },
    render: () => {
      let component: ReactRenderer<SkillMentionListHandle, SkillMentionListProps> | null = null;
      let container: HTMLDivElement | null = null;

      const position = (clientRect?: (() => DOMRect | null) | null) => {
        const rect = clientRect?.();
        if (!container || !rect) return;
        container.style.left = `${rect.left}px`;
        container.style.top = `${rect.bottom + 6}px`;
      };

      return {
        onStart: (props) => {
          component = new ReactRenderer(SkillMentionList, {
            props: {
              items: props.items,
              command: (item: SkillCatalogItem) => props.command(item),
            },
            editor: props.editor,
          });
          container = document.createElement("div");
          container.style.position = "fixed";
          container.style.zIndex = "50";
          container.appendChild(component.element);
          document.body.appendChild(container);
          position(props.clientRect);
        },
        onUpdate: (props) => {
          component?.updateProps({
            items: props.items,
            command: (item: SkillCatalogItem) => props.command(item),
          });
          position(props.clientRect);
        },
        onKeyDown: (props) => component?.ref?.onKeyDown(props) ?? false,
        onExit: () => {
          component?.destroy();
          container?.remove();
          component = null;
          container = null;
        },
      };
    },
  };
}

export function createSkillMentionPlugin(
  editor: Parameters<typeof Suggestion>[0]["editor"],
  skills: SkillCatalogItem[],
) {
  return Suggestion({ editor, ...createSkillMentionSuggestion(skills) });
}

// Paints each literal `@skill/<id>` token as a subtle chip so mentions read as
// distinct atoms, mirroring the main chat composer's selected-mention styling
// (see renderComposerInputOverlay in ChatSurface). This is a view-only
// decoration: the underlying text stays plain `@skill/<id>` and round-trips
// through Markdown untouched. The shadow spread (not padding) creates the chip
// gutter so caret metrics and line height are unaffected.
const SKILL_MENTION_CHIP_CLASS =
  "rounded-sm bg-ink/8 text-ink shadow-[0_0_0_3px_rgba(15,15,15,0.08)]";

const SKILL_MENTION_TOKEN_REGEX = /@skill\/[a-zA-Z0-9][a-zA-Z0-9._-]*/g;

const SKILL_MENTION_DECORATION_KEY = new PluginKey("skillMentionDecoration");

export function createSkillMentionDecorationPlugin() {
  return new Plugin({
    key: SKILL_MENTION_DECORATION_KEY,
    props: {
      decorations(state) {
        const decorations: Decoration[] = [];
        state.doc.descendants((node, pos) => {
          if (!node.isTextblock) return;
          if (node.type.spec.code) return false;
          let offset = pos + 1;
          node.forEach((child) => {
            if (
              child.isText &&
              child.text &&
              !child.marks.some((mark) => mark.type.name === "code")
            ) {
              const text = child.text;
              SKILL_MENTION_TOKEN_REGEX.lastIndex = 0;
              let match = SKILL_MENTION_TOKEN_REGEX.exec(text);
              while (match !== null) {
                const start = offset + match.index;
                decorations.push(
                  Decoration.inline(start, start + match[0].length, {
                    class: SKILL_MENTION_CHIP_CLASS,
                  }),
                );
                match = SKILL_MENTION_TOKEN_REGEX.exec(text);
              }
            }
            offset += child.nodeSize;
          });
          return false;
        });
        return DecorationSet.create(state.doc, decorations);
      },
    },
  });
}

"use client";

// Wiki links (`[[slug]]`, `[[page:slug|Title]]`, `[[source:...]]`, legacy
// `[^ev:...]`) are stored in the markdown body verbatim, but in the editor they
// are a single atomic inline node — not editable raw text. You can select and
// delete a link as one unit, but you can't put the caret inside and corrupt the
// `[[...]]` syntax. This is the foundation for treating a sub-page reference as
// a solid pointer at a real page in the tree.
//
// The node stores the exact `raw` token as its only attribute and serializes it
// back verbatim, so the markdown round-trip is lossless and agents keep reading
// and writing `[[slug]]` exactly as before. Live page titles, hrefs, and click
// navigation are resolved at render time from plugin state (kept in sync by the
// host editor), fed to the node views through node decorations so a rename
// updates every chip instantly.

import { parseBrainInlineLinks } from "@opencompany/brain/inline-links";
import { type JSONContent, Node } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { isExternalHref, sourceChipDisplay, sourceHrefForRef } from "@/lib/brain-source-links";

// Live data the chips resolve against. The host editor keeps this current by
// dispatching a WIKI_LINK_STATE_KEY meta transaction whenever its props change.
export type WikiLinkState = {
  // Page slug / "kind:target" -> href. Also drives whether a link is resolved.
  brainLinks: Record<string, string>;
  // Live page titles keyed by slug, so a rename re-labels every `[[slug]]` chip.
  pageTitles: Record<string, string>;
  editingEnabled: boolean;
  onNavigateInternal: ((href: string) => boolean) | undefined;
};

export const WIKI_LINK_STATE_KEY = new PluginKey<WikiLinkState>("wikiLinkState");

const DEFAULT_STATE: WikiLinkState = {
  brainLinks: {},
  pageTitles: {},
  editingEnabled: true,
  onNavigateInternal: undefined,
};

// Single token anchored at the start of the source, mirroring the grammar in
// parseBrainInlineLinks so the editor and the shared parser never disagree.
const BRACKET_AT_START = /^\[\[([^[\]\n|]+)(?:\|([^[\]\n]+))?\]\]/;
const LEGACY_EVIDENCE_AT_START = /^\[\^ev:([^\]\n]+)\]/;

const WIKI_LINK_ICON =
  '<svg class="wiki-brain-chip-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><line x1="8" x2="16" y1="12" y2="12"/></svg>';

const GITHUB_ICON =
  '<svg class="wiki-brain-chip-icon wiki-brain-chip-icon-github" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>';

type ResolvedWikiLink = {
  href: string; // "" when the target doesn't resolve yet
  label: string;
  icon: "link" | "github";
  external: boolean;
  title: string;
};

function hrefForLink(
  link: ReturnType<typeof parseBrainInlineLinks>[number],
  links: Record<string, string>,
): string {
  const mapped = links[`${link.kind}:${link.target}`];
  if (mapped) return mapped;
  if (link.kind === "page") return links[link.target] ?? "";
  if (link.kind === "source") return sourceHrefForRef(link.target) ?? "";
  return "";
}

export function resolveWikiLink(raw: string, state: WikiLinkState): ResolvedWikiLink {
  const link = parseBrainInlineLinks(raw)[0];
  if (!link) {
    return { href: "", label: raw, icon: "link", external: false, title: raw };
  }
  const href = hrefForLink(link, state.brainLinks);
  if (link.kind === "source") {
    const chip = sourceChipDisplay(link.target, link.label);
    return {
      href,
      label: chip.label,
      icon: chip.icon,
      external: href ? isExternalHref(href) : false,
      title: href ? "Open source" : "Unresolved source link",
    };
  }
  // A page link prefers the target's live title over the authored label, so a
  // rename propagates to every reference (Notion-style).
  const liveTitle = link.kind === "page" ? state.pageTitles[link.target] : undefined;
  const label = liveTitle || link.label;
  return {
    href,
    label,
    icon: "link",
    external: href ? isExternalHref(href) : false,
    title: href ? "Open link" : `Unresolved ${link.kind} link`,
  };
}

function isPlainLeftClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

function buildChip(resolved: ResolvedWikiLink, getState: () => WikiLinkState): HTMLElement {
  const { href, label, icon, external, title } = resolved;
  const chip = document.createElement(href ? "a" : "span");
  chip.className = href ? "wiki-brain-chip" : "wiki-brain-chip wiki-brain-chip-unresolved";
  chip.title = title;
  chip.setAttribute("data-wiki-link", "");
  chip.contentEditable = "false";
  chip.innerHTML = icon === "github" ? GITHUB_ICON : WIKI_LINK_ICON;
  const text = document.createElement("span");
  text.className = "wiki-brain-chip-label";
  text.textContent = label || "Untitled";
  chip.appendChild(text);
  if (href) {
    chip.setAttribute("href", href);
    if (external) {
      chip.setAttribute("target", "_blank");
      chip.setAttribute("rel", "noopener noreferrer");
    }
    chip.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!(event instanceof MouseEvent)) return;
      if (!isPlainLeftClick(event) || external) return;
      if (getState().onNavigateInternal?.(href)) event.preventDefault();
    });
  }
  return chip;
}

function sameResolved(a: ResolvedWikiLink, b: ResolvedWikiLink): boolean {
  return (
    a.href === b.href &&
    a.label === b.label &&
    a.icon === b.icon &&
    a.external === b.external &&
    a.title === b.title
  );
}

// Regular markdown links (tiptap Link marks) aren't wiki nodes. A plain internal
// left-click routes client-side; external opens a new tab; modified clicks keep
// native behavior.
function handlePlainLinkClick(view: EditorView, event: MouseEvent): boolean {
  const target = event.target instanceof Element ? event.target : null;
  const anchor = target?.closest("a[href]");
  if (!(anchor instanceof HTMLAnchorElement) || !view.dom.contains(anchor)) return false;
  // Chips carry their own click handler (and stopPropagation); ignore them here.
  if (anchor.hasAttribute("data-wiki-link")) return false;
  if (!isPlainLeftClick(event)) return false;
  const href = anchor.getAttribute("href");
  if (!href) return false;
  event.preventDefault();
  const state = WIKI_LINK_STATE_KEY.getState(view.state) ?? DEFAULT_STATE;
  if (isExternalHref(href)) {
    window.open(href, "_blank", "noopener,noreferrer");
    return true;
  }
  if (state.onNavigateInternal?.(href)) return true;
  window.location.href = href;
  return true;
}

function resolvedFromDecorations(
  decorations: readonly Decoration[],
  fallback: () => ResolvedWikiLink,
): ResolvedWikiLink {
  for (const decoration of decorations) {
    const resolved = (decoration.spec as { resolved?: ResolvedWikiLink }).resolved;
    if (resolved) return resolved;
  }
  return fallback();
}

export type WikiLinkOptions = {
  // Seeded into the plugin so chips resolve on first paint; the host editor then
  // keeps it current with WIKI_LINK_STATE_KEY meta transactions.
  initialState: WikiLinkState;
};

export const WikiLink = Node.create<WikiLinkOptions>({
  name: "wikiLink",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addOptions() {
    return { initialState: DEFAULT_STATE };
  },

  addAttributes() {
    return {
      raw: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-wiki-link") ?? "",
        renderHTML: (attributes) => ({ "data-wiki-link": attributes.raw }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-wiki-link]" }];
  },

  // Fallback rendering (copy/paste, non-editor contexts): the raw token text.
  renderHTML({ node }) {
    return ["span", { "data-wiki-link": node.attrs.raw as string }, node.attrs.raw as string];
  },

  renderText({ node }) {
    return node.attrs.raw as string;
  },

  addNodeView() {
    return ({ node, editor, decorations }) => {
      const getState = () => WIKI_LINK_STATE_KEY.getState(editor.state) ?? DEFAULT_STATE;
      const fallback = () => resolveWikiLink(node.attrs.raw as string, getState());
      let raw = node.attrs.raw as string;
      let resolved = resolvedFromDecorations(decorations as Decoration[], fallback);
      let dom = buildChip(resolved, getState);
      return {
        dom,
        update: (updatedNode, updatedDecorations) => {
          if (updatedNode.type.name !== "wikiLink") return false;
          const nextRaw = updatedNode.attrs.raw as string;
          const nextResolved = resolvedFromDecorations(updatedDecorations as Decoration[], () =>
            resolveWikiLink(nextRaw, getState()),
          );
          if (nextRaw === raw && sameResolved(nextResolved, resolved)) return true;
          raw = nextRaw;
          resolved = nextResolved;
          const next = buildChip(resolved, getState);
          dom.replaceWith(next);
          dom = next;
          return true;
        },
      };
    };
  },

  addProseMirrorPlugins() {
    const { initialState } = this.options;
    return [
      new Plugin<WikiLinkState>({
        key: WIKI_LINK_STATE_KEY,
        state: {
          init: () => initialState,
          apply: (transaction, value) => transaction.getMeta(WIKI_LINK_STATE_KEY) ?? value,
        },
        props: {
          // Node decorations carry each link's resolved title/href so the node
          // views re-render when only the plugin state (e.g. a page title)
          // changes, not just when the node itself changes.
          decorations(state) {
            const pluginState = WIKI_LINK_STATE_KEY.getState(state) ?? DEFAULT_STATE;
            const decorations: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              if (node.type.name !== "wikiLink") return;
              const resolved = resolveWikiLink(node.attrs.raw as string, pluginState);
              decorations.push(Decoration.node(pos, pos + node.nodeSize, {}, { resolved }));
            });
            return DecorationSet.create(state.doc, decorations);
          },
          handleDOMEvents: {
            click: (view, event) => handlePlainLinkClick(view, event),
          },
        },
      }),
    ];
  },

  // --- markdown round-trip (via @tiptap/markdown) ---------------------------

  markdownTokenizer: {
    name: "wikiLink",
    level: "inline",
    start(src: string) {
      const bracket = src.indexOf("[[");
      const legacy = src.indexOf("[^ev:");
      const candidates = [bracket, legacy].filter((index) => index >= 0);
      return candidates.length > 0 ? Math.min(...candidates) : -1;
    },
    tokenize(src: string) {
      const match = BRACKET_AT_START.exec(src) ?? LEGACY_EVIDENCE_AT_START.exec(src);
      if (!match) return undefined;
      return { type: "wikiLink", raw: match[0] };
    },
  },

  parseMarkdown(token: { raw?: string }) {
    return { type: "wikiLink", attrs: { raw: token.raw ?? "" } };
  },

  renderMarkdown(node: JSONContent) {
    return (node.attrs?.raw as string | undefined) ?? "";
  },
});

// Inline content for inserting a wiki link live (e.g. the "/page" command), so
// the chip is atomic immediately instead of raw text until the next reload.
export function wikiLinkContent(raw: string): JSONContent {
  return { type: WikiLink.name, attrs: { raw } };
}

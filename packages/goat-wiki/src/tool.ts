// The `wiki` agent tool contract, shared by chat, MCP, and (later) the runner.
//
// One CLI-shaped tool instead of a tool per verb: the wiki is small enough that
// a single `command` enum plus a handful of flat parameters stays guessable,
// and retrieval is deliberately filesystem-first — agents browse the tree, read
// pages, and grep, rather than leaning on a search engine.

export const WIKI_TOOL_NAME = "wiki";

export const WIKI_TOOL_COMMANDS = [
  "tree",
  "read",
  "grep",
  "search",
  "recent",
  "timeline",
  "write",
  "move",
  "delete",
  "timeline-add",
] as const;

export type WikiToolCommand = (typeof WIKI_TOOL_COMMANDS)[number];

export const WIKI_READ_COMMANDS: readonly WikiToolCommand[] = [
  "tree",
  "read",
  "grep",
  "search",
  "recent",
  "timeline",
];

export type WikiToolInput = {
  command: WikiToolCommand;
  /** read: page slugs or paths (one or many). timeline/move/delete/timeline-add: one slug. */
  pages?: string | string[] | undefined;
  /** write: full tree path of the page ("projects/website-redesign"). */
  path?: string | undefined;
  /** write: markdown body (frontmatter is managed for you — do not include it). */
  body?: string | undefined;
  /** write: page kind. */
  kind?: string | undefined;
  /** search: query text. grep: regex pattern. */
  query?: string | undefined;
  /** recent/timeline: window like "2d", "6h", "1w", or an ISO timestamp. */
  since?: string | undefined;
  /** move: new parent path, or "/" for the root. */
  to?: string | undefined;
  /** delete: also delete all subpages. */
  recursive?: boolean | undefined;
  /** grep: case-insensitive matching (default true). */
  ignoreCase?: boolean | undefined;
  /** timeline-add: entry date (ISO, defaults to now). */
  at?: string | undefined;
  /** timeline-add: one-line markdown entry; may contain [[links]]. */
  text?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
};

export type WikiToolOutput = { ok: true; result: unknown } | { ok: false; error: string };

export const WIKI_TOOL_DESCRIPTION = [
  "Workspace wiki: markdown pages in a tree (Notion-like pages with subpages). Every page has a stable `slug` used by [[wiki-links]] and a tree `path` of slugs like projects/website-redesign. Retrieval is filesystem-first: start with `tree`, `read` the promising pages, `grep` when hunting for a phrase.",
  'Commands: tree (list the page tree) · read {pages: slug|path|[...]} (page bodies + subpages + backlinks) · grep {query: regex} (matching lines across pages) · search {query} (keyword search when grep/tree are not enough) · recent {since: "2d"} (pages changed, with +added/-removed lines) · timeline {pages: slug, since?} (a page\'s dated history) · write {path, body, kind?} (create or overwrite; missing parent pages are auto-created) · move {pages: slug, to: parent-path|"/"} · delete {pages: slug, recursive?} · timeline-add {pages: slug, text, at?}.',
  "Pages link to each other inline with [[slug]] or [[slug|Label]], and to artifacts in other tools with [[source:provider:id]] (e.g. [[source:linear:issue:ENG-123]]) — keep those links when rewriting. `kind` is one of project, person, company, research, meeting, other. Writes overwrite the whole page body: read before you rewrite.",
].join(" ");

// JSON schema for AI-SDK / MCP registration. Descriptions repeat the contract
// per-field because bare MCP clients only see the schema.
export const WIKI_TOOL_INPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    command: {
      type: "string",
      enum: [...WIKI_TOOL_COMMANDS],
      description: "What to do. Read commands: tree, read, grep, search, recent, timeline.",
    },
    pages: {
      anyOf: [{ type: "string" }, { type: "array", items: { type: "string" }, maxItems: 20 }],
      description:
        "Page slug(s) or path(s). Used by read (one or many), timeline, move, delete, timeline-add (one).",
    },
    path: {
      type: "string",
      description:
        'write: the page\'s full tree path, lowercase slugs joined by "/" (e.g. "projects/website-redesign").',
    },
    body: {
      type: "string",
      description: "write: full markdown body. No frontmatter — kind is a separate parameter.",
    },
    kind: {
      type: "string",
      enum: ["project", "person", "company", "research", "meeting", "other"],
      description: "write: what the page is about.",
    },
    query: {
      type: "string",
      description: "search: query text. grep: a regular expression matched line by line.",
    },
    since: {
      type: "string",
      description: 'recent/timeline: relative window ("2d", "6h", "1w") or ISO timestamp.',
    },
    to: {
      type: "string",
      description: 'move: destination parent path, or "/" to move the page to the root.',
    },
    recursive: {
      type: "boolean",
      description: "delete: also delete every subpage.",
    },
    ignoreCase: {
      type: "boolean",
      description: "grep: case-insensitive matching (default true).",
    },
    at: {
      type: "string",
      description: "timeline-add: entry date as an ISO timestamp; defaults to now.",
    },
    text: {
      type: "string",
      description: "timeline-add: one-line markdown entry; may contain [[links]].",
    },
    limit: { type: "integer", minimum: 1, maximum: 200 },
    offset: { type: "integer", minimum: 0 },
  },
  required: ["command"],
} as const;

export function firstWikiPageRef(input: WikiToolInput): string {
  const raw = Array.isArray(input.pages) ? input.pages[0] : input.pages;
  return typeof raw === "string" ? raw.trim() : "";
}

export function wikiPageRefs(input: WikiToolInput): string[] {
  const raw = Array.isArray(input.pages)
    ? input.pages
    : typeof input.pages === "string"
      ? // Slugs and paths never contain commas, so "a, b" is a packed list.
        input.pages.split(",")
      : [];
  return raw.map((ref) => ref.trim()).filter(Boolean);
}

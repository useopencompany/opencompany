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
  "mkdir",
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
  /** tree: maximum descendant depth to return; 0 returns root entries only. */
  depth?: number | undefined;
  /** read: page paths or basenames (one or many). timeline/move/delete/timeline-add: one path. */
  pages?: string | string[] | undefined;
  /** mkdir/write: full path of the folder or page ("projects/website-redesign"). */
  path?: string | undefined;
  /** write: markdown body (frontmatter is managed for you — do not include it). */
  body?: string | undefined;
  /** write: page kind. */
  kind?: string | undefined;
  /** write/mkdir: display name (write defaults to the body's first H1, mkdir to the folder slug). */
  title?: string | undefined;
  /** search: query text. grep: regex pattern. */
  query?: string | undefined;
  /** recent/timeline: window like "2d", "6h", "1w", or an ISO timestamp. */
  since?: string | undefined;
  /** move: new parent path, or "/" for the root. */
  to?: string | undefined;
  /** delete: required to delete a non-empty folder. */
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
  "Workspace wiki: folders and markdown pages in a tree, like a filesystem. Folders are containers and pages are leaf documents. A node's full `path` is its identity; start with `tree`, `read` promising pages, and use `grep` when hunting for a phrase.",
  'Commands: tree {depth?: 0-10} (folders end in `/`; depth 0 shows root entries; wikis over 40 entries default to depth 0) · read {pages: path|basename|[...]} (page bodies + backlinks; a folder returns its children) · grep {query: regex} · search {query} · recent {since: "2d"} · timeline {pages: path, since?} · mkdir {path, title?} (create a folder and missing ancestor folders) · write {path, body, kind?, title?} (create or overwrite a page; missing ancestor folders are auto-created) · move {pages: path, to: folder-path|"/"} (move a page or folder subtree and update links) · delete {pages: path, recursive?} (recursive is required for a non-empty folder) · timeline-add {pages: path, text, at?}.',
  "Pages link inline with [[path/to/page]] or [[path/to/page|Label]], and to artifacts in other tools with [[source:provider:id]] (e.g. [[source:linear:issue:ENG-123]]) — keep those links when rewriting. Bare basenames resolve only when unique. `kind` is one of project, person, company, research, meeting, other. Writes overwrite the whole page body: read before you rewrite.",
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
    depth: {
      type: "integer",
      minimum: 0,
      maximum: 10,
      description:
        "tree: maximum depth to return. 0 shows root entries only, 1 includes their children. If omitted, wikis with at most 40 entries return the full tree; larger wikis default to 0.",
    },
    pages: {
      anyOf: [{ type: "string" }, { type: "array", items: { type: "string" }, maxItems: 20 }],
      description:
        "Page path(s) or unique basename(s). Used by read (one or many), timeline, move, delete, timeline-add (one).",
    },
    path: {
      type: "string",
      description:
        'mkdir/write: the folder or page full path, lowercase slugs joined by "/" (e.g. "projects/website-redesign").',
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
    title: {
      type: "string",
      description:
        "write/mkdir: display name for the page or folder. Optional — a page defaults to the body's first H1, a folder to its slug; an existing name is kept when omitted.",
    },
    query: {
      type: "string",
      description:
        "search: query text. grep: a regular expression matched against page titles and each body line.",
    },
    since: {
      type: "string",
      description: 'recent/timeline: relative window ("2d", "6h", "1w") or ISO timestamp.',
    },
    to: {
      type: "string",
      description: 'move: destination folder path, or "/" to move the node to the root.',
    },
    recursive: {
      type: "boolean",
      description: "delete: required to delete a non-empty folder and all its contents.",
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

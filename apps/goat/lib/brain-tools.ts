import * as z from "zod/v4-mini";
import type { GoatBrainToolInput } from "@/lib/chat-ui";

// Single source of truth for the flat, intent-named Goat Brain tool surface.
//
// The read engine (brain-cli.ts + the @opencompany/db/goat-brain-read plane) speaks a
// CLI-shaped `{ command, flags }` contract. That shape is great for a guided in-app agent
// but unintuitive for a bare MCP client, which has no system prompt teaching the dispatch
// model and instead guesses flat, semantically-named parameters (`query`, `id`, `brain`).
//
// This module defines flat tools whose parameters match what an agent guesses on the first
// try, plus pure mappers that translate them into the existing `GoatBrainToolInput`. Flag
// names are emitted in the engine's expected vocabulary (camelCase is normalized to kebab and
// validated against the per-command allow list downstream), so nothing in the engine changes.

export const SEARCH_BRAIN_TOOL_NAME = "search_brain";
export const GET_DOCUMENT_TOOL_NAME = "get_document";
export const LIST_DOCUMENTS_TOOL_NAME = "list_documents";
export const GET_TIMELINE_TOOL_NAME = "get_timeline";
export const LIST_BRAINS_TOOL_NAME = "list_brains";
export const SAVE_TO_BRAIN_TOOL_NAME = "save_to_brain";
// Advanced escape hatch: the full CLI-shaped read surface (doctor, help, and any flag the
// dedicated tools do not expose). Kept for completeness and back-compat, de-emphasized so
// agents reach for the flat tools first.
export const GOAT_BRAIN_ADVANCED_TOOL_NAME = "goat_brain";

const nonEmptyString = z.string().check(z.minLength(1));
const idOrIds = z.union([
  nonEmptyString,
  z.array(nonEmptyString).check(z.minLength(1), z.maxLength(20)),
]);

// Every tool accepts an optional brain selector. `brain` is canonical; `brain_id` is a
// tolerated alias because agents habitually reach for it. Both must be in the schema — MCP
// strips unknown keys before the handler runs, so an alias only survives if declared.
export const brainSelectorSchema = {
  brain: z.optional(nonEmptyString),
  brain_id: z.optional(nonEmptyString),
};

export type BrainSelectorArgs = {
  brain?: string | undefined;
  brain_id?: string | undefined;
};

export function resolveBrainParam(args: BrainSelectorArgs): string | undefined {
  const raw = args.brain ?? args.brain_id;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed || undefined;
}

// --- search_brain -----------------------------------------------------------------------------

export const searchBrainInputSchema = {
  query: z.optional(nonEmptyString),
  folder: z.optional(nonEmptyString),
  type: z.optional(nonEmptyString),
  kind: z.optional(z.enum(["page", "evidence"])),
  since: z.optional(nonEmptyString),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(50))),
  hops: z.optional(z.number().check(z.int(), z.minimum(0), z.maximum(3))),
  lexicalOnly: z.optional(z.boolean()),
  includeMerged: z.optional(z.boolean()),
  includeArchived: z.optional(z.boolean()),
  ...brainSelectorSchema,
};

export type SearchBrainArgs = BrainSelectorArgs & {
  query?: string | undefined;
  folder?: string | undefined;
  type?: string | undefined;
  kind?: "page" | "evidence" | undefined;
  since?: string | undefined;
  limit?: number | undefined;
  hops?: number | undefined;
  lexicalOnly?: boolean | undefined;
  includeMerged?: boolean | undefined;
  includeArchived?: boolean | undefined;
};

export const SEARCH_BRAIN_TOOL_DESCRIPTION =
  'Search a knowledge brain for pages and evidence by meaning and keyword. This is the primary recall tool. Pass "query" with the topic to find (e.g. { "query": "WorkOS sponsorship deal terms" }). Omit "query" and pass "since" (a relative window like 6h, 2d, 1w or an ISO-8601 timestamp) to browse recent entries. Each hit returns an id — follow the important ones with get_document. Read-only.';

export function searchBrainToToolInput(args: SearchBrainArgs): GoatBrainToolInput {
  const query = args.query?.trim();
  return {
    command: "query",
    flags: {
      ...(query ? { text: query } : {}),
      ...(args.folder?.trim() ? { folder: args.folder.trim() } : {}),
      ...(args.type?.trim() ? { type: args.type.trim() } : {}),
      ...(args.kind ? { kind: args.kind } : {}),
      ...(args.since?.trim() ? { since: args.since.trim() } : {}),
      ...(args.hops !== undefined ? { hops: args.hops } : {}),
      limit: args.limit ?? 10,
      ...(args.lexicalOnly ? { lexicalOnly: true } : {}),
      ...(args.includeMerged ? { includeMerged: true } : {}),
      ...(args.includeArchived ? { includeArchived: true } : {}),
      json: true,
    },
  };
}

// --- get_document -----------------------------------------------------------------------------

export const getDocumentInputSchema = {
  // Canonical is `ids` (one id or a list); `id` is a tolerated singular alias.
  ids: z.optional(idOrIds),
  id: z.optional(idOrIds),
  section: z.optional(z.enum(["all", "frontmatter", "truth", "timeline"])),
  ...brainSelectorSchema,
};

export type GetDocumentArgs = BrainSelectorArgs & {
  ids?: string | string[] | undefined;
  id?: string | string[] | undefined;
  section?: "all" | "frontmatter" | "truth" | "timeline" | undefined;
};

export const GET_DOCUMENT_TOOL_DESCRIPTION =
  'Fetch full brain documents by id, including compiled truth, links, and timeline. Pass one id or a list (e.g. { "ids": "youtube-series-sponsorship-program" } or { "ids": ["ev-gmail-217917958f18da216c", "..."] }). Ids come from search_brain or list_documents hits; aliases resolve too. Use "section" to fetch only frontmatter/truth/timeline. Read-only.';

export function coerceDocumentIds(args: GetDocumentArgs): string[] {
  const raw = args.ids ?? args.id;
  if (Array.isArray(raw)) return raw.map((item) => item.trim()).filter(Boolean);
  if (typeof raw === "string" && raw.trim()) return [raw.trim()];
  return [];
}

export function getDocumentToToolInput(args: GetDocumentArgs): GoatBrainToolInput {
  const ids = coerceDocumentIds(args);
  return {
    command: "get",
    flags: {
      id: ids,
      ...(args.section ? { section: args.section } : {}),
      json: true,
    },
  };
}

// --- list_documents ---------------------------------------------------------------------------

export const listDocumentsInputSchema = {
  folder: z.optional(nonEmptyString),
  type: z.optional(nonEmptyString),
  kind: z.optional(z.enum(["page", "evidence"])),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(100))),
  includeMerged: z.optional(z.boolean()),
  ...brainSelectorSchema,
};

export type ListDocumentsArgs = BrainSelectorArgs & {
  folder?: string | undefined;
  type?: string | undefined;
  kind?: "page" | "evidence" | undefined;
  limit?: number | undefined;
  includeMerged?: boolean | undefined;
};

export const LIST_DOCUMENTS_TOOL_DESCRIPTION =
  'List documents in a brain for inventory or enumeration (not semantic search — use search_brain for that). Filter by "folder", "type", or "kind" (e.g. { "kind": "page", "folder": "people" }). Returns id, title, folder, and type per document. Read-only.';

export function listDocumentsToToolInput(args: ListDocumentsArgs): GoatBrainToolInput {
  return {
    command: "list",
    flags: {
      ...(args.folder?.trim() ? { folder: args.folder.trim() } : {}),
      ...(args.type?.trim() ? { type: args.type.trim() } : {}),
      ...(args.kind ? { kind: args.kind } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.includeMerged ? { includeMerged: true } : {}),
      json: true,
    },
  };
}

// --- get_timeline -----------------------------------------------------------------------------

export const getTimelineInputSchema = {
  id: nonEmptyString,
  since: z.optional(nonEmptyString),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(100))),
  ...brainSelectorSchema,
};

export type GetTimelineArgs = BrainSelectorArgs & {
  id: string;
  since?: string | undefined;
  limit?: number | undefined;
};

export const GET_TIMELINE_TOOL_DESCRIPTION =
  'Get the dated history of a single brain document (how a page or record changed over time). Pass its "id" (e.g. { "id": "workos-sponsorship" }). Optionally narrow with "since" (relative window like 6h, 2d, 1w or an ISO-8601 timestamp). Read-only.';

export function getTimelineToToolInput(args: GetTimelineArgs): GoatBrainToolInput {
  return {
    command: "timeline",
    flags: {
      id: args.id.trim(),
      ...(args.since?.trim() ? { since: args.since.trim() } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      json: true,
    },
  };
}

// --- save_to_brain ----------------------------------------------------------------------------

export const saveToBrainInputSchema = {
  content: nonEmptyString,
  title: z.optional(z.string().check(z.minLength(1), z.maxLength(200))),
  intent: z.optional(z.string().check(z.minLength(1), z.maxLength(1_000))),
  ...brainSelectorSchema,
};

export const SAVE_TO_BRAIN_TOOL_DESCRIPTION =
  "Capture content the user explicitly wants remembered. Immediately creates a draft in the selected brain's inbox, then queues background curation to title, link, merge, and file it. Preserve the user's content faithfully; do not use this as a scratchpad or save without clear user intent. Requires workspace-admin access.";

// --- goat_brain (advanced escape hatch) -------------------------------------------------------

const goatBrainFlagValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
]);

export const goatBrainAdvancedInputSchema = {
  command: z.enum(["help", "list", "get", "timeline", "query", "doctor"]),
  flags: z.optional(z.record(z.string(), goatBrainFlagValueSchema)),
  stdin: z.optional(z.string()),
  ...brainSelectorSchema,
};

export const GOAT_BRAIN_ADVANCED_TOOL_DESCRIPTION =
  "Advanced: the raw CLI-shaped read surface for a brain. Prefer search_brain, get_document, list_documents, and get_timeline for everyday use. This tool exposes commands they do not (doctor for validation, help for usage) and full flag control via { command, flags }. Read-only.";

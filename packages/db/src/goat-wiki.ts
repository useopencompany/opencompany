// Workspace wiki access (brain v2). One wiki per workspace; pages form a tree
// keyed by `path` (ancestor slug chain + own slug) with `slug` as the stable,
// workspace-unique identity that [[wiki-links]] target. Every mutation writes
// an append-only version row (with line deltas, so the recent-changes feed is
// a pure aggregation) and rebuilds the derived wiki_links index from the body.

import { createHash, randomUUID } from "node:crypto";
import {
  DEFAULT_WIKI_KIND,
  deriveWikiTitle,
  isValidWikiPath,
  isValidWikiSlug,
  isWikiDescendantPath,
  movedWikiPath,
  parentWikiPath,
  type WikiKind,
  wikiPageLinkTargets,
  wikiSlugFromPath,
  wikiSourceRefTargets,
} from "@opencompany/goat-wiki";
import { and, asc, desc, eq, getTableColumns, gte, inArray, like, sql } from "drizzle-orm";
import { getDb } from "./client";
import {
  type GoatWikiLinkKind,
  type GoatWikiPage,
  type GoatWikiTimelineEntry,
  goatUsers,
  goatWikiLinks,
  goatWikiPages,
  goatWikiPageVersions,
  goatWikiTimelineEntries,
} from "./goat-schema";
import { listGoatWorkspacesForUser } from "./goat-workspaces";

type DbClient = any;

// Postgres txid of a mutation statement, captured in the same statement so the
// Electric-synced UI can hold its optimistic state until the write streams
// back. 32-bit (::xid) to match the txids Electric reports.
const TXID_COLUMN = sql<string>`pg_current_xact_id()::xid::text`;

function txidFromRow(row: { txid?: string | null } | undefined, context: string): number {
  const txid = Number(row?.txid);
  if (!Number.isFinite(txid)) throw new WikiError(`Expected a txid from ${context}.`);
  return txid;
}

const MAX_WIKI_PAGE_BYTES = 1_000_000;
const FTS_CANDIDATE_LIMIT = 50;
const TITLE_CANDIDATE_LIMIT = 25;
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;
const SNIPPET_MAX_CHARS = 300;
const DEFAULT_GREP_LIMIT = 50;
const MAX_GREP_MATCHES_PER_PAGE = 10;
const RRF_K = 60;

export class WikiError extends Error {}

export function hashWikiContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function firstRow<T>(rows: T[], context: string): T {
  const row = rows[0];
  if (row === undefined) throw new WikiError(`Expected a row from ${context}.`);
  return row;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type WikiAccess = {
  enabled: boolean;
  workspaces: Array<{ id: string; name: string; slug: string | null }>;
};

/**
 * Whether the user opted into the wiki preview, and which workspaces' wikis
 * they can reach. Surfaces without a resolved workspace (MCP) use this to gate
 * and target the `wiki` tool.
 */
export async function getWikiAccessForUser(
  userWorkosId: string,
  db: DbClient = getDb(),
): Promise<WikiAccess> {
  const [user]: Array<{ wikiEnabled: boolean }> = await db
    .select({ wikiEnabled: goatUsers.wikiEnabled })
    .from(goatUsers)
    .where(eq(goatUsers.workosUserId, userWorkosId))
    .limit(1);
  if (!user?.wikiEnabled) return { enabled: false, workspaces: [] };
  const memberships = await listGoatWorkspacesForUser(userWorkosId, { db });
  return {
    enabled: true,
    workspaces: memberships.map(({ workspace }) => ({
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
    })),
  };
}

export type WikiTreeEntry = {
  slug: string;
  path: string;
  title: string;
  kind: WikiKind;
  sizeBytes: number;
  updatedAt: Date;
  childCount: number;
};

export async function getWikiTree(
  workspaceId: string,
  db: DbClient = getDb(),
): Promise<WikiTreeEntry[]> {
  const rows: GoatWikiPage[] = await db
    .select()
    .from(goatWikiPages)
    .where(eq(goatWikiPages.workspaceId, workspaceId))
    .orderBy(asc(goatWikiPages.path));
  const childCounts = new Map<string, number>();
  for (const row of rows) {
    const parent = parentWikiPath(row.path);
    if (parent) childCounts.set(parent, (childCounts.get(parent) ?? 0) + 1);
  }
  return rows.map((row) => ({
    slug: row.slug,
    path: row.path,
    title: row.title,
    kind: row.kind,
    sizeBytes: row.sizeBytes,
    updatedAt: row.updatedAt,
    childCount: childCounts.get(row.path) ?? 0,
  }));
}

/**
 * Every page in the workspace wiki, bodies included — the payload behind the
 * instant client-side navigation in the UI. Wikis are lightweight-Notion
 * scale, so shipping all bodies at once is deliberate.
 */
export async function listWikiPagesWithBodies(
  workspaceId: string,
  db: DbClient = getDb(),
): Promise<GoatWikiPage[]> {
  return db
    .select()
    .from(goatWikiPages)
    .where(eq(goatWikiPages.workspaceId, workspaceId))
    .orderBy(asc(goatWikiPages.path));
}

/**
 * Resolves page references that may be slugs or paths ("website-redesign" or
 * "projects/website-redesign"). Unknown refs are reported, not thrown, so a
 * multi-ref read can partially succeed.
 */
export async function resolveWikiPages(
  workspaceId: string,
  refs: string[],
  db: DbClient = getDb(),
): Promise<{ pages: GoatWikiPage[]; missing: string[] }> {
  const cleaned = [...new Set(refs.map((ref) => ref.trim()).filter(Boolean))];
  if (cleaned.length === 0) return { pages: [], missing: [] };
  const rows: GoatWikiPage[] = await db
    .select()
    .from(goatWikiPages)
    .where(
      and(
        eq(goatWikiPages.workspaceId, workspaceId),
        sql`(${inArray(goatWikiPages.slug, cleaned)} OR ${inArray(goatWikiPages.path, cleaned)})`,
      ),
    );
  const found = new Set(rows.flatMap((row) => [row.slug, row.path]));
  const bySlug = new Map(rows.map((row) => [row.slug, row]));
  // Preserve request order; a ref matching by path resolves to the same page.
  const ordered: GoatWikiPage[] = [];
  const seen = new Set<string>();
  for (const ref of cleaned) {
    const page = bySlug.get(ref) ?? rows.find((row) => row.path === ref);
    if (page && !seen.has(page.id)) {
      seen.add(page.id);
      ordered.push(page);
    }
  }
  return { pages: ordered, missing: cleaned.filter((ref) => !found.has(ref)) };
}

export type WikiBacklink = {
  slug: string;
  path: string;
  title: string;
  kind: WikiKind;
};

export async function getWikiBacklinks(
  workspaceId: string,
  slug: string,
  db: DbClient = getDb(),
): Promise<WikiBacklink[]> {
  const rows: Array<{ slug: string; path: string; title: string; kind: WikiKind }> = await db
    .select({
      slug: goatWikiPages.slug,
      path: goatWikiPages.path,
      title: goatWikiPages.title,
      kind: goatWikiPages.kind,
    })
    .from(goatWikiLinks)
    .innerJoin(goatWikiPages, eq(goatWikiLinks.fromPageId, goatWikiPages.id))
    .where(
      and(
        eq(goatWikiLinks.workspaceId, workspaceId),
        eq(goatWikiLinks.kind, "page"),
        eq(goatWikiLinks.target, slug),
      ),
    )
    .orderBy(asc(goatWikiPages.path));
  return rows;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export type WikiWriteInput = {
  workspaceId: string;
  path: string;
  body: string;
  /**
   * Explicit page id for creates, so a client that inserted the page
   * optimistically (Electric/TanStack DB) syncs back onto the same row.
   * Ignored on updates.
   */
  id?: string;
  kind?: WikiKind;
  /**
   * Explicit display name (the Notion-style "name" field). When absent the
   * title derives from the body's first H1, falling back to the existing
   * title on updates so agent rewrites without an H1 never clobber a
   * human-set name. An explicit empty string is honored — the UI renders it
   * as "Untitled", exactly like Notion.
   */
  title?: string;
  actorWorkosId?: string | null;
};

export type WikiWriteResult = {
  page: GoatWikiPage;
  action: "created" | "updated" | "unchanged";
  /** Stub ancestor pages auto-created so a deep write never dangles. */
  createdAncestors: string[];
  /** Txids of the wiki_pages statements, for Electric optimistic-state matching. */
  txids: number[];
};

export async function writeWikiPage(
  input: WikiWriteInput,
  db: DbClient = getDb(),
): Promise<WikiWriteResult> {
  const path = input.path.trim().replace(/^\/+|\/+$/g, "");
  if (!isValidWikiPath(path)) {
    throw new WikiError(
      `Invalid wiki path "${input.path}". Paths are lowercase slug segments joined by "/", e.g. projects/website-redesign.`,
    );
  }
  if (Buffer.byteLength(input.body, "utf8") > MAX_WIKI_PAGE_BYTES) {
    throw new WikiError(`Page exceeds the ${MAX_WIKI_PAGE_BYTES / 1_000_000}MB limit.`);
  }
  const slug = wikiSlugFromPath(path);

  const existing = await pageByPathOrSlug(db, input.workspaceId, path, slug);
  if (existing && existing.path !== path) {
    throw new WikiError(
      `Slug "${slug}" already exists at "${existing.path}". Slugs are unique per workspace; use \`move\` to relocate the page or pick a different name.`,
    );
  }

  const ancestors = await ensureAncestorPages(
    db,
    input.workspaceId,
    path,
    input.actorWorkosId ?? null,
  );
  const createdAncestors = ancestors.created;

  if (existing) {
    const kind = input.kind ?? existing.kind;
    const title =
      input.title !== undefined
        ? input.title.trim()
        : deriveWikiTitle(input.body, existing.title.trim() || slug);
    if (existing.content === input.body && existing.kind === kind && existing.title === title) {
      return { page: existing, action: "unchanged", createdAncestors, txids: ancestors.txids };
    }
    const delta = lineDelta(existing.content, input.body);
    const updated: Array<GoatWikiPage & { txid: string }> = await db
      .update(goatWikiPages)
      .set({
        content: input.body,
        kind,
        title,
        contentHash: hashWikiContent(input.body),
        sizeBytes: Buffer.byteLength(input.body, "utf8"),
        updatedByWorkosId: input.actorWorkosId ?? null,
        updatedAt: new Date(),
      })
      .where(eq(goatWikiPages.id, existing.id))
      .returning({ ...getTableColumns(goatWikiPages), txid: TXID_COLUMN });
    const { txid, ...page } = firstRow(updated, "wiki page update");
    await recordVersion(db, page, "write", delta, input.actorWorkosId ?? null);
    await rebuildLinks(db, page);
    return {
      page,
      action: "updated",
      createdAncestors,
      txids: [...ancestors.txids, txidFromRow({ txid }, "wiki page update")],
    };
  }

  const { page, txid } = await insertPage(db, {
    workspaceId: input.workspaceId,
    path,
    body: input.body,
    kind: input.kind ?? DEFAULT_WIKI_KIND,
    ...(input.id ? { id: input.id } : {}),
    ...(input.title !== undefined ? { title: input.title.trim() } : {}),
    actorWorkosId: input.actorWorkosId ?? null,
  });
  return { page, action: "created", createdAncestors, txids: [...ancestors.txids, txid] };
}

export type WikiMoveResult = {
  page: GoatWikiPage;
  fromPath: string;
  /** Descendant pages whose paths were rewritten along with the move. */
  movedDescendants: number;
  /** Txids of the wiki_pages statements, for Electric optimistic-state matching. */
  txids: number[];
};

export async function moveWikiPage(
  input: {
    workspaceId: string;
    slug: string;
    /** New parent path, or null to move to the root. */
    newParentPath: string | null;
    actorWorkosId?: string | null;
  },
  db: DbClient = getDb(),
): Promise<WikiMoveResult> {
  const page = await requirePageBySlug(db, input.workspaceId, input.slug);
  const parent = input.newParentPath?.trim().replace(/^\/+|\/+$/g, "") || null;
  if (parent !== null) {
    if (!isValidWikiPath(parent)) throw new WikiError(`Invalid parent path "${parent}".`);
    if (parent === page.path || isWikiDescendantPath(parent, page.path)) {
      throw new WikiError(`Cannot move "${page.slug}" inside its own subtree.`);
    }
    const parentPage = await pageByPath(db, input.workspaceId, parent);
    if (!parentPage) throw new WikiError(`Parent page "${parent}" does not exist.`);
  }
  const newPath = parent ? `${parent}/${page.slug}` : page.slug;
  if (!isValidWikiPath(newPath)) throw new WikiError(`Invalid destination path "${newPath}".`);
  if (newPath === page.path) return { page, fromPath: page.path, movedDescendants: 0, txids: [] };
  const collision = await pageByPath(db, input.workspaceId, newPath);
  if (collision) throw new WikiError(`A page already exists at "${newPath}".`);

  const fromPath = page.path;
  const descendants: GoatWikiPage[] = await db
    .select()
    .from(goatWikiPages)
    .where(
      and(
        eq(goatWikiPages.workspaceId, input.workspaceId),
        like(goatWikiPages.path, `${escapeLike(fromPath)}/%`),
      ),
    );
  // neon-http has no interactive transactions; order the writes so a crash
  // mid-move leaves descendants under the old prefix (repairable by re-running
  // the move), never two pages claiming one path.
  const movedRows: Array<GoatWikiPage & { txid: string }> = await db
    .update(goatWikiPages)
    .set({ path: newPath, updatedByWorkosId: input.actorWorkosId ?? null, updatedAt: new Date() })
    .where(eq(goatWikiPages.id, page.id))
    .returning({ ...getTableColumns(goatWikiPages), txid: TXID_COLUMN });
  const { txid, ...moved } = firstRow(movedRows, "wiki page move");
  const txids = [txidFromRow({ txid }, "wiki page move")];
  for (const descendant of descendants) {
    const descendantRows: Array<{ txid: string }> = await db
      .update(goatWikiPages)
      .set({ path: movedWikiPath(descendant.path, fromPath, newPath) })
      .where(eq(goatWikiPages.id, descendant.id))
      .returning({ txid: TXID_COLUMN });
    txids.push(txidFromRow(descendantRows[0], "wiki descendant move"));
  }
  await recordVersion(db, moved, "move", { added: 0, removed: 0 }, input.actorWorkosId ?? null);
  return { page: moved, fromPath, movedDescendants: descendants.length, txids };
}

export async function deleteWikiPage(
  input: {
    workspaceId: string;
    slug: string;
    recursive?: boolean;
    actorWorkosId?: string | null;
  },
  db: DbClient = getDb(),
): Promise<{ deletedPaths: string[]; txids: number[] }> {
  const page = await requirePageBySlug(db, input.workspaceId, input.slug);
  const descendants: GoatWikiPage[] = await db
    .select()
    .from(goatWikiPages)
    .where(
      and(
        eq(goatWikiPages.workspaceId, input.workspaceId),
        like(goatWikiPages.path, `${escapeLike(page.path)}/%`),
      ),
    );
  if (descendants.length > 0 && !input.recursive) {
    throw new WikiError(
      `"${page.slug}" has ${descendants.length} subpage(s). Pass recursive to delete the whole subtree.`,
    );
  }
  const doomed = [...descendants].sort((a, b) => b.path.length - a.path.length).concat(page);
  const txids: number[] = [];
  for (const target of doomed) {
    await recordVersion(
      db,
      target,
      "delete",
      { added: 0, removed: 0 },
      input.actorWorkosId ?? null,
    );
    const deletedRows: Array<{ txid: string }> = await db
      .delete(goatWikiPages)
      .where(eq(goatWikiPages.id, target.id))
      .returning({ txid: TXID_COLUMN });
    txids.push(txidFromRow(deletedRows[0], "wiki page delete"));
  }
  return { deletedPaths: doomed.map((target) => target.path), txids };
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

export async function listWikiTimeline(
  input: { workspaceId: string; slug: string; since?: Date },
  db: DbClient = getDb(),
): Promise<GoatWikiTimelineEntry[]> {
  const page = await requirePageBySlug(db, input.workspaceId, input.slug);
  const conditions = [eq(goatWikiTimelineEntries.pageId, page.id)];
  if (input.since) conditions.push(gte(goatWikiTimelineEntries.at, input.since));
  return db
    .select()
    .from(goatWikiTimelineEntries)
    .where(and(...conditions))
    .orderBy(desc(goatWikiTimelineEntries.at));
}

export async function addWikiTimelineEntry(
  input: {
    workspaceId: string;
    slug: string;
    at: Date;
    text: string;
    /** Explicit entry id for optimistic client inserts (Electric sync-back). */
    id?: string;
    actorWorkosId?: string | null;
  },
  db: DbClient = getDb(),
): Promise<GoatWikiTimelineEntry & { txid: number }> {
  const text = input.text.trim();
  if (!text) throw new WikiError("Timeline entry text is required.");
  const page = await requirePageBySlug(db, input.workspaceId, input.slug);
  const inserted: Array<GoatWikiTimelineEntry & { txid: string }> = await db
    .insert(goatWikiTimelineEntries)
    .values({
      id: input.id ?? randomUUID(),
      workspaceId: input.workspaceId,
      pageId: page.id,
      at: input.at,
      text,
      createdByWorkosId: input.actorWorkosId ?? null,
    })
    .returning({ ...getTableColumns(goatWikiTimelineEntries), txid: TXID_COLUMN });
  const { txid, ...entry } = firstRow(inserted, "wiki timeline insert");
  return { ...entry, txid: txidFromRow({ txid }, "wiki timeline insert") };
}

// ---------------------------------------------------------------------------
// Retrieval: search, grep, recent changes
// ---------------------------------------------------------------------------

export type WikiSearchHit = {
  slug: string;
  path: string;
  title: string;
  kind: WikiKind;
  snippet: string;
  updatedAt: Date;
};

/**
 * Lexical search: Postgres FTS over title+content fused (reciprocal rank) with
 * trigram title match for typo-tolerant lookups. Deliberately no embeddings —
 * tree browsing and grep are the default retrieval; semantic search can return
 * as an explicit opt-in later if it earns its keep.
 */
export async function searchWiki(
  workspaceId: string,
  options: { text: string; limit?: number; offset?: number },
  db: DbClient = getDb(),
): Promise<WikiSearchHit[]> {
  const text = options.text.trim();
  if (!text) return [];
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT);
  const offset = Math.max(0, Math.trunc(options.offset ?? 0));

  const ftsRank = sql`ts_rank_cd(${goatWikiPages.searchTsv}, websearch_to_tsquery('english', ${text}))`;
  const titleSimilarity = sql`word_similarity(${text}, ${goatWikiPages.title})`;
  const [ftsRows, titleRows]: [Array<{ id: string }>, Array<{ id: string }>] = await Promise.all([
    db
      .select({ id: goatWikiPages.id })
      .from(goatWikiPages)
      .where(
        and(
          eq(goatWikiPages.workspaceId, workspaceId),
          sql`websearch_to_tsquery('english', ${text}) @@ ${goatWikiPages.searchTsv}`,
        ),
      )
      .orderBy(desc(ftsRank))
      .limit(FTS_CANDIDATE_LIMIT),
    db
      .select({ id: goatWikiPages.id })
      .from(goatWikiPages)
      .where(
        and(eq(goatWikiPages.workspaceId, workspaceId), sql`${text} <% ${goatWikiPages.title}`),
      )
      .orderBy(desc(titleSimilarity))
      .limit(TITLE_CANDIDATE_LIMIT),
  ]);

  const scores = reciprocalRankFusion([
    ftsRows.map((row) => row.id),
    titleRows.map((row) => row.id),
  ]);
  if (scores.size === 0) return [];

  const pages: GoatWikiPage[] = await db
    .select()
    .from(goatWikiPages)
    .where(inArray(goatWikiPages.id, [...scores.keys()]));
  const byId = new Map(pages.map((page) => [page.id, page]));
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(offset, offset + limit)
    .flatMap(([id]) => {
      const page = byId.get(id);
      if (!page) return [];
      return [
        {
          slug: page.slug,
          path: page.path,
          title: page.title,
          kind: page.kind,
          snippet: snippetFor(page, text),
          updatedAt: page.updatedAt,
        },
      ];
    });
}

export type WikiGrepMatch = {
  slug: string;
  path: string;
  lineNumber: number;
  line: string;
};

/**
 * Regex grep over page bodies for surfaces without a real filesystem (chat,
 * MCP). Postgres pre-filters with the same pattern; matching lines are
 * extracted in JS. Sandboxed agents should just ripgrep the materialized tree.
 */
export async function grepWiki(
  workspaceId: string,
  options: { pattern: string; ignoreCase?: boolean; limit?: number },
  db: DbClient = getDb(),
): Promise<WikiGrepMatch[]> {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_GREP_LIMIT, 1), 200);
  let regex: RegExp;
  try {
    regex = new RegExp(options.pattern, options.ignoreCase ? "i" : "");
  } catch (error) {
    throw new WikiError(`Invalid grep pattern: ${(error as Error).message}`);
  }
  const operator = options.ignoreCase ? sql.raw("~*") : sql.raw("~");
  let pages: GoatWikiPage[];
  try {
    pages = await db
      .select()
      .from(goatWikiPages)
      .where(
        and(
          eq(goatWikiPages.workspaceId, workspaceId),
          sql`(${goatWikiPages.title} ${operator} ${options.pattern} OR ${goatWikiPages.content} ${operator} ${options.pattern})`,
        ),
      )
      .orderBy(asc(goatWikiPages.path));
  } catch {
    // Postgres and JS regex dialects differ at the edges; fall back to scanning
    // every page in JS rather than failing the grep.
    pages = await db
      .select()
      .from(goatWikiPages)
      .where(eq(goatWikiPages.workspaceId, workspaceId))
      .orderBy(asc(goatWikiPages.path));
  }
  const matches: WikiGrepMatch[] = [];
  for (const page of pages) {
    let perPage = 0;
    const lines = page.content.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      if (!regex.test(lines[i] ?? "")) continue;
      matches.push({ slug: page.slug, path: page.path, lineNumber: i + 1, line: lines[i] ?? "" });
      perPage += 1;
      if (matches.length >= limit || perPage >= MAX_GREP_MATCHES_PER_PAGE) break;
    }
    if (matches.length >= limit) break;
  }
  return matches;
}

export type WikiRecentChange = {
  slug: string;
  path: string;
  title: string;
  deleted: boolean;
  writes: number;
  addedLines: number;
  removedLines: number;
  lastChangedAt: Date;
};

/** Pages changed since a moment, with how much changed — newest first. */
export async function recentWikiChanges(
  workspaceId: string,
  options: { since: Date; limit?: number },
  db: DbClient = getDb(),
): Promise<WikiRecentChange[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const versions: Array<typeof goatWikiPageVersions.$inferSelect> = await db
    .select()
    .from(goatWikiPageVersions)
    .where(
      and(
        eq(goatWikiPageVersions.workspaceId, workspaceId),
        gte(goatWikiPageVersions.createdAt, options.since),
      ),
    )
    .orderBy(desc(goatWikiPageVersions.createdAt));
  const byPage = new Map<string, WikiRecentChange>();
  for (const version of versions) {
    const key = version.pageId ?? `deleted:${version.slug}`;
    const existing = byPage.get(key);
    if (existing) {
      existing.writes += 1;
      existing.addedLines += version.addedLines;
      existing.removedLines += version.removedLines;
      continue;
    }
    byPage.set(key, {
      slug: version.slug,
      path: version.path,
      title: version.title,
      deleted: version.operation === "delete" && version.pageId === null,
      writes: 1,
      addedLines: version.addedLines,
      removedLines: version.removedLines,
      lastChangedAt: version.createdAt,
    });
  }
  return [...byPage.values()].slice(0, limit);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function insertPage(
  db: DbClient,
  input: {
    workspaceId: string;
    path: string;
    body: string;
    kind: WikiKind;
    id?: string;
    title?: string;
    actorWorkosId: string | null;
  },
): Promise<{ page: GoatWikiPage; txid: number }> {
  const slug = wikiSlugFromPath(input.path);
  const insertedPages: Array<GoatWikiPage & { txid: string }> = await db
    .insert(goatWikiPages)
    .values({
      id: input.id ?? randomUUID(),
      workspaceId: input.workspaceId,
      slug,
      path: input.path,
      title: input.title ?? deriveWikiTitle(input.body, slug),
      kind: input.kind,
      content: input.body,
      contentHash: hashWikiContent(input.body),
      sizeBytes: Buffer.byteLength(input.body, "utf8"),
      createdByWorkosId: input.actorWorkosId,
      updatedByWorkosId: input.actorWorkosId,
    })
    .returning({ ...getTableColumns(goatWikiPages), txid: TXID_COLUMN });
  const { txid, ...page } = firstRow(insertedPages, "wiki page insert");
  await recordVersion(
    db,
    page,
    "write",
    { added: countLines(input.body), removed: 0 },
    input.actorWorkosId,
  );
  await rebuildLinks(db, page);
  return { page, txid: txidFromRow({ txid }, "wiki page insert") };
}

/** Creates empty stub pages for any missing ancestors of `path`, top-down. */
async function ensureAncestorPages(
  db: DbClient,
  workspaceId: string,
  path: string,
  actorWorkosId: string | null,
): Promise<{ created: string[]; txids: number[] }> {
  const created: string[] = [];
  const txids: number[] = [];
  const segments = path.split("/");
  for (let depth = 1; depth < segments.length; depth += 1) {
    const ancestorPath = segments.slice(0, depth).join("/");
    const slug = segments[depth - 1] ?? "";
    const existing = await pageByPathOrSlug(db, workspaceId, ancestorPath, slug);
    if (existing) {
      if (existing.path !== ancestorPath) {
        throw new WikiError(
          `Slug "${slug}" already exists at "${existing.path}", so "${path}" cannot be created. Every path segment is a page slug and slugs are unique per workspace.`,
        );
      }
      continue;
    }
    const inserted = await insertPage(db, {
      workspaceId,
      path: ancestorPath,
      body: "",
      kind: "other",
      actorWorkosId,
    });
    created.push(ancestorPath);
    txids.push(inserted.txid);
  }
  return { created, txids };
}

async function pageByPath(
  db: DbClient,
  workspaceId: string,
  path: string,
): Promise<GoatWikiPage | null> {
  const [row]: GoatWikiPage[] = await db
    .select()
    .from(goatWikiPages)
    .where(and(eq(goatWikiPages.workspaceId, workspaceId), eq(goatWikiPages.path, path)))
    .limit(1);
  return row ?? null;
}

async function pageByPathOrSlug(
  db: DbClient,
  workspaceId: string,
  path: string,
  slug: string,
): Promise<GoatWikiPage | null> {
  const [row]: GoatWikiPage[] = await db
    .select()
    .from(goatWikiPages)
    .where(and(eq(goatWikiPages.workspaceId, workspaceId), eq(goatWikiPages.slug, slug)))
    .limit(1);
  if (row) return row;
  return pageByPath(db, workspaceId, path);
}

async function requirePageBySlug(
  db: DbClient,
  workspaceId: string,
  ref: string,
): Promise<GoatWikiPage> {
  const cleaned = ref.trim();
  if (!isValidWikiSlug(wikiSlugFromPath(cleaned))) {
    throw new WikiError(`Invalid page reference "${ref}".`);
  }
  const { pages } = await resolveWikiPages(workspaceId, [cleaned], db);
  const page = pages[0];
  if (!page) throw new WikiError(`No wiki page "${ref}".`);
  return page;
}

async function recordVersion(
  db: DbClient,
  page: GoatWikiPage,
  operation: "write" | "move" | "delete",
  delta: { added: number; removed: number },
  actorWorkosId: string | null,
): Promise<void> {
  await db.insert(goatWikiPageVersions).values({
    id: randomUUID(),
    workspaceId: page.workspaceId,
    pageId: operation === "delete" ? null : page.id,
    slug: page.slug,
    path: page.path,
    title: page.title,
    kind: page.kind,
    content: page.content,
    contentHash: page.contentHash,
    operation,
    addedLines: delta.added,
    removedLines: operation === "delete" ? countLines(page.content) : delta.removed,
    actorWorkosId,
  });
}

async function rebuildLinks(db: DbClient, page: GoatWikiPage): Promise<void> {
  const entries: Array<{ kind: GoatWikiLinkKind; target: string }> = [
    ...wikiPageLinkTargets(page.content).map((target) => ({ kind: "page" as const, target })),
    ...wikiSourceRefTargets(page.content).map((target) => ({ kind: "source" as const, target })),
  ];
  await db.delete(goatWikiLinks).where(eq(goatWikiLinks.fromPageId, page.id));
  if (entries.length === 0) return;
  await db.insert(goatWikiLinks).values(
    entries.map((entry) => ({
      workspaceId: page.workspaceId,
      fromPageId: page.id,
      kind: entry.kind,
      target: entry.target,
    })),
  );
}

function reciprocalRankFusion(lists: string[][], k: number = RRF_K): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
    });
  }
  return scores;
}

function snippetFor(page: GoatWikiPage, query: string): string {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 2);
  const lines = page.content.split("\n");
  const hit = terms.length
    ? lines.find((line) => {
        const lower = line.toLowerCase();
        return terms.some((term) => lower.includes(term));
      })
    : undefined;
  const text = (hit ?? lines.find((line) => line.trim()) ?? "").trim();
  return text.length > SNIPPET_MAX_CHARS ? `${text.slice(0, SNIPPET_MAX_CHARS)}…` : text;
}

function countLines(content: string): number {
  return content === "" ? 0 : content.split("\n").length;
}

/**
 * Multiset line difference — added = lines now present that weren't, removed =
 * the inverse. Not a positional diff, but a faithful "how much changed" signal
 * for the recent feed at a fraction of a real diff's cost.
 */
export function lineDelta(
  oldContent: string,
  newContent: string,
): { added: number; removed: number } {
  const oldCounts = lineCounts(oldContent);
  const newCounts = lineCounts(newContent);
  let added = 0;
  let removed = 0;
  for (const [line, count] of newCounts) {
    added += Math.max(0, count - (oldCounts.get(line) ?? 0));
  }
  for (const [line, count] of oldCounts) {
    removed += Math.max(0, count - (newCounts.get(line) ?? 0));
  }
  return { added, removed };
}

function lineCounts(content: string): Map<string, number> {
  const counts = new Map<string, number>();
  if (content === "") return counts;
  for (const line of content.split("\n")) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

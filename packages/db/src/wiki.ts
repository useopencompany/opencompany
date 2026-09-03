// Workspace wiki access (brain v2). Folders and leaf pages form a filesystem-
// style tree keyed by workspace-unique paths. Page links target those paths.
// Every mutation writes append-only versions and page writes rebuild the
// derived wiki_links index from the body.

import { createHash, randomUUID } from "node:crypto";
import {
  DEFAULT_WIKI_KIND,
  deriveWikiTitle,
  isValidWikiPath,
  isValidWikiSlug,
  isWikiDescendantPath,
  movedWikiPath,
  parentWikiPath,
  rewriteWikiPageLinks,
  type WikiKind,
  type WikiNodeType,
  wikiPageLinkTargets,
  wikiSlugFromPath,
  wikiSourceRefTargets,
} from "@opencompany/wiki";
import { and, asc, desc, eq, getTableColumns, gte, inArray, like, or, sql } from "drizzle-orm";
import { getDb } from "./client";
import {
  type WikiLinkKind,
  type WikiPage,
  type WikiTimelineEntry,
  wikiLinks,
  wikiPages,
  wikiPageVersions,
  wikiTimelineEntries,
} from "./product-schema";
import { listWorkspacesForUser } from "./workspaces";

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

// Insert lost a unique-violation race on (workspace_id, path): another writer
// created the node between our existence check and the insert. Folder creation
// absorbs this and converges on the winner's row; page writes surface it.
class WikiNodeExistsError extends WikiError {}

export function hashWikiContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function normalizedWikiPathInput(value: string): string {
  const trimmed = value.trim();
  let start = 0;
  let end = trimmed.length;
  while (start < end && trimmed.charCodeAt(start) === 47) start += 1;
  while (end > start && trimmed.charCodeAt(end - 1) === 47) end -= 1;
  return trimmed.slice(start, end);
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
  workspaces: Array<{ id: string; name: string; slug: string | null }>;
};

/**
 * Which workspaces' wikis the user can reach. Surfaces without a resolved
 * workspace (MCP) use this to target the always-available `wiki` tool.
 */
export async function getWikiAccessForUser(
  userWorkosId: string,
  db: DbClient = getDb(),
): Promise<WikiAccess> {
  const memberships = await listWorkspacesForUser(userWorkosId, { db });
  return {
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
  nodeType: WikiNodeType;
  sizeBytes: number;
  updatedAt: Date;
  childCount: number;
};

export async function getWikiTree(
  workspaceId: string,
  db: DbClient = getDb(),
): Promise<WikiTreeEntry[]> {
  const rows: WikiPage[] = await db
    .select()
    .from(wikiPages)
    .where(eq(wikiPages.workspaceId, workspaceId))
    .orderBy(asc(wikiPages.path));
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
    nodeType: row.nodeType,
    sizeBytes: row.sizeBytes,
    updatedAt: row.updatedAt,
    childCount: childCounts.get(row.path) ?? 0,
  }));
}

/**
 * Every page in the workspace wiki, bodies included — the payload behind the
 * instant client-side navigation in the UI. Wikis are lightweight
 * scale, so shipping all bodies at once is deliberate.
 */
export async function listWikiPagesWithBodies(
  workspaceId: string,
  db: DbClient = getDb(),
): Promise<WikiPage[]> {
  return db
    .select()
    .from(wikiPages)
    .where(eq(wikiPages.workspaceId, workspaceId))
    .orderBy(asc(wikiPages.path));
}

/**
 * Resolves an exact page path first, then falls back to a basename only when it
 * identifies exactly one page in the workspace. Folders never resolve here.
 * Unknown and ambiguous refs are reported, not thrown.
 */
export async function resolveWikiPages(
  workspaceId: string,
  refs: string[],
  db: DbClient = getDb(),
): Promise<{ pages: WikiPage[]; missing: string[] }> {
  const cleaned = [...new Set(refs.map((ref) => ref.trim()).filter(Boolean))];
  if (cleaned.length === 0) return { pages: [], missing: [] };
  const rows: WikiPage[] = await db
    .select()
    .from(wikiPages)
    .where(
      and(
        eq(wikiPages.workspaceId, workspaceId),
        eq(wikiPages.nodeType, "page"),
        sql`(${inArray(wikiPages.slug, cleaned)} OR ${inArray(wikiPages.path, cleaned)})`,
      ),
    );
  const byPath = new Map(rows.map((row) => [row.path, row]));
  const bySlug = new Map<string, WikiPage[]>();
  for (const row of rows) {
    const matches = bySlug.get(row.slug);
    if (matches) matches.push(row);
    else bySlug.set(row.slug, [row]);
  }
  const ordered: WikiPage[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const ref of cleaned) {
    const basenameMatches = bySlug.get(ref) ?? [];
    const page = byPath.get(ref) ?? (basenameMatches.length === 1 ? basenameMatches[0] : undefined);
    if (page && !seen.has(page.id)) {
      seen.add(page.id);
      ordered.push(page);
    }
    if (!page) missing.push(ref);
  }
  return { pages: ordered, missing };
}

export type WikiBacklink = {
  slug: string;
  path: string;
  title: string;
  kind: WikiKind;
};

export async function getWikiBacklinks(
  workspaceId: string,
  path: string,
  db: DbClient = getDb(),
): Promise<WikiBacklink[]> {
  const rows: Array<{ slug: string; path: string; title: string; kind: WikiKind }> = await db
    .select({
      slug: wikiPages.slug,
      path: wikiPages.path,
      title: wikiPages.title,
      kind: wikiPages.kind,
    })
    .from(wikiLinks)
    .innerJoin(wikiPages, eq(wikiLinks.fromPageId, wikiPages.id))
    .where(
      and(
        eq(wikiLinks.workspaceId, workspaceId),
        eq(wikiLinks.kind, "page"),
        eq(wikiLinks.target, path),
        eq(wikiPages.nodeType, "page"),
      ),
    )
    .orderBy(asc(wikiPages.path));
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
  page: WikiPage;
  action: "created" | "updated" | "unchanged";
  /** Ancestor folders auto-created so a deep write never dangles. */
  createdAncestors: string[];
  /** Txids of the wiki_pages statements, for Electric optimistic-state matching. */
  txids: number[];
};

export async function writeWikiPage(
  input: WikiWriteInput,
  db: DbClient = getDb(),
): Promise<WikiWriteResult> {
  const path = normalizedWikiPathInput(input.path);
  if (!isValidWikiPath(path)) {
    throw new WikiError(
      `Invalid wiki path "${input.path}". Paths are lowercase slug segments joined by "/", e.g. projects/website-redesign.`,
    );
  }
  if (Buffer.byteLength(input.body, "utf8") > MAX_WIKI_PAGE_BYTES) {
    throw new WikiError(`Page exceeds the ${MAX_WIKI_PAGE_BYTES / 1_000_000}MB limit.`);
  }
  const slug = wikiSlugFromPath(path);

  const existing = await pageByPath(db, input.workspaceId, path);
  if (existing?.nodeType === "folder") throw new WikiError(`"${path}" is a folder.`);

  const ancestors = await ensureAncestorFolders(
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
    const updated: Array<WikiPage & { txid: string }> = await db
      .update(wikiPages)
      .set({
        content: input.body,
        kind,
        title,
        contentHash: hashWikiContent(input.body),
        sizeBytes: Buffer.byteLength(input.body, "utf8"),
        updatedByWorkosId: input.actorWorkosId ?? null,
        updatedAt: new Date(),
      })
      .where(eq(wikiPages.id, existing.id))
      .returning({ ...getTableColumns(wikiPages), txid: TXID_COLUMN });
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

export type WikiFolderCreateResult = {
  folder: WikiPage;
  action: "created" | "unchanged";
  createdAncestors: string[];
  txids: number[];
};

export async function createWikiFolder(
  input: {
    workspaceId: string;
    path: string;
    id?: string;
    title?: string;
    actorWorkosId?: string | null;
  },
  db: DbClient = getDb(),
): Promise<WikiFolderCreateResult> {
  const path = normalizedWikiPathInput(input.path);
  if (!isValidWikiPath(path)) throw new WikiError(`Invalid folder path "${input.path}".`);

  const existing = await pageByPath(db, input.workspaceId, path);
  if (existing) {
    if (existing.nodeType === "page") throw new WikiError(`"${path}" is a page.`);
    return { folder: existing, action: "unchanged", createdAncestors: [], txids: [] };
  }

  const ancestors = await ensureAncestorFolders(
    db,
    input.workspaceId,
    path,
    input.actorWorkosId ?? null,
  );
  let inserted: { page: WikiPage; txid: number };
  try {
    inserted = await insertNode(db, {
      workspaceId: input.workspaceId,
      path,
      nodeType: "folder",
      body: "",
      kind: DEFAULT_WIKI_KIND,
      ...(input.id ? { id: input.id } : {}),
      title: input.title?.trim() || wikiSlugFromPath(path),
      actorWorkosId: input.actorWorkosId ?? null,
    });
  } catch (error) {
    if (!(error instanceof WikiNodeExistsError)) throw error;
    // A concurrent writer created this path between the existence check and the
    // insert; converge on their node instead of failing an idempotent mkdir.
    const winner = await pageByPath(db, input.workspaceId, path);
    if (!winner) throw error;
    if (winner.nodeType === "page") throw new WikiError(`"${path}" is a page.`);
    return {
      folder: winner,
      action: "unchanged",
      createdAncestors: ancestors.created,
      txids: ancestors.txids,
    };
  }
  return {
    folder: inserted.page,
    action: "created",
    createdAncestors: ancestors.created,
    txids: [...ancestors.txids, inserted.txid],
  };
}

export async function updateWikiNodeTitle(
  input: {
    workspaceId: string;
    id: string;
    title: string;
    actorWorkosId?: string | null;
  },
  db: DbClient = getDb(),
): Promise<{ node: WikiPage; txid: number | null }> {
  const node = await nodeById(db, input.workspaceId, input.id);
  if (!node) throw new WikiError("Wiki node not found.");
  const title = input.title.trim();
  if (node.title === title) return { node, txid: null };
  const rows: Array<WikiPage & { txid: string }> = await db
    .update(wikiPages)
    .set({
      title,
      updatedByWorkosId: input.actorWorkosId ?? null,
      updatedAt: new Date(),
    })
    .where(eq(wikiPages.id, node.id))
    .returning({ ...getTableColumns(wikiPages), txid: TXID_COLUMN });
  const { txid, ...updated } = firstRow(rows, "wiki node title update");
  await recordVersion(db, updated, "write", { added: 0, removed: 0 }, input.actorWorkosId ?? null);
  return { node: updated, txid: txidFromRow({ txid }, "wiki node title update") };
}

export type WikiMoveResult = {
  node: WikiPage;
  fromPath: string;
  /** Descendant nodes whose paths were rewritten along with the move. */
  movedDescendants: number;
  /** Final paths of pages whose bodies had links rewritten. */
  rewrittenReferrers: string[];
  /** Txids of the wiki_pages statements, for Electric optimistic-state matching. */
  txids: number[];
};

export async function moveWikiNode(
  input: {
    workspaceId: string;
    path: string;
    /** New containing folder path, or null to move to the root. */
    newParentPath: string | null;
    /** New final path segment, or the existing slug when omitted. */
    newSlug?: string;
    actorWorkosId?: string | null;
  },
  db: DbClient = getDb(),
): Promise<WikiMoveResult> {
  if (!supportsInteractiveTransactions(db)) {
    throw new WikiError("Moving a wiki node requires a transactional database connection.");
  }
  return db.transaction((tx: DbClient) => moveWikiNodeInDb(input, tx));
}

/** Compatibility alias for older callers while the path-based contract rolls out. */
export const moveWikiPage = moveWikiNode;

async function moveWikiNodeInDb(
  input: {
    workspaceId: string;
    path: string;
    newParentPath: string | null;
    newSlug?: string;
    actorWorkosId?: string | null;
  },
  db: DbClient,
): Promise<WikiMoveResult> {
  const node = await requireWikiNode(db, input.workspaceId, input.path);
  const parent = input.newParentPath ? normalizedWikiPathInput(input.newParentPath) || null : null;
  const slug = input.newSlug?.trim() || node.slug;
  if (!isValidWikiSlug(slug)) throw new WikiError(`Invalid slug "${input.newSlug}".`);
  if (parent !== null) {
    if (!isValidWikiPath(parent)) throw new WikiError(`Invalid parent path "${parent}".`);
    if (parent === node.path || isWikiDescendantPath(parent, node.path)) {
      throw new WikiError(`Cannot move "${node.slug}" inside its own subtree.`);
    }
    const parentNode = await pageByPath(db, input.workspaceId, parent);
    if (!parentNode) throw new WikiError(`Folder "${parent}" does not exist.`);
    if (parentNode.nodeType !== "folder") throw new WikiError(`"${parent}" is not a folder.`);
  }
  const newPath = parent ? `${parent}/${slug}` : slug;
  if (!isValidWikiPath(newPath)) throw new WikiError(`Invalid destination path "${newPath}".`);
  if (newPath === node.path) {
    return {
      node,
      fromPath: node.path,
      movedDescendants: 0,
      rewrittenReferrers: [],
      txids: [],
    };
  }
  const collision = await pageByPath(db, input.workspaceId, newPath);
  if (collision) throw new WikiError(`A wiki node already exists at "${newPath}".`);

  const fromPath = node.path;
  const descendants: WikiPage[] = await db
    .select()
    .from(wikiPages)
    .where(
      and(
        eq(wikiPages.workspaceId, input.workspaceId),
        like(wikiPages.path, `${escapeLike(fromPath)}/%`),
      ),
    );

  const referrers: WikiPage[] = await db
    .select({ ...getTableColumns(wikiPages) })
    .from(wikiLinks)
    .innerJoin(wikiPages, eq(wikiLinks.fromPageId, wikiPages.id))
    .where(
      and(
        eq(wikiLinks.workspaceId, input.workspaceId),
        eq(wikiLinks.kind, "page"),
        eq(wikiPages.nodeType, "page"),
        or(eq(wikiLinks.target, fromPath), like(wikiLinks.target, `${escapeLike(fromPath)}/%`)),
      ),
    );
  const uniqueReferrers = [...new Map(referrers.map((page) => [page.id, page])).values()];
  const timelineEntries: WikiTimelineEntry[] = await db
    .select()
    .from(wikiTimelineEntries)
    .where(eq(wikiTimelineEntries.workspaceId, input.workspaceId));

  const movedRows: Array<WikiPage & { txid: string }> = await db
    .update(wikiPages)
    .set({
      slug,
      path: newPath,
      updatedByWorkosId: input.actorWorkosId ?? null,
      updatedAt: new Date(),
    })
    .where(eq(wikiPages.id, node.id))
    .returning({ ...getTableColumns(wikiPages), txid: TXID_COLUMN });
  const { txid, ...moved } = firstRow(movedRows, "wiki node move");
  let movedNode = moved;
  const txids = [txidFromRow({ txid }, "wiki node move")];
  await recordVersion(db, moved, "move", { added: 0, removed: 0 }, input.actorWorkosId ?? null);

  for (const descendant of descendants) {
    const descendantRows: Array<WikiPage & { txid: string }> = await db
      .update(wikiPages)
      .set({
        path: movedWikiPath(descendant.path, fromPath, newPath),
        updatedByWorkosId: input.actorWorkosId ?? null,
        updatedAt: new Date(),
      })
      .where(eq(wikiPages.id, descendant.id))
      .returning({ ...getTableColumns(wikiPages), txid: TXID_COLUMN });
    const { txid: descendantTxid, ...movedDescendant } = firstRow(
      descendantRows,
      "wiki descendant move",
    );
    txids.push(txidFromRow({ txid: descendantTxid }, "wiki descendant move"));
    await recordVersion(
      db,
      movedDescendant,
      "move",
      { added: 0, removed: 0 },
      input.actorWorkosId ?? null,
    );
  }

  const rewrittenReferrers: string[] = [];
  for (const referrer of uniqueReferrers) {
    const content = rewriteMovedTargets(referrer.content, fromPath, newPath);
    if (content === referrer.content) continue;
    const delta = lineDelta(referrer.content, content);
    const rows: Array<WikiPage & { txid: string }> = await db
      .update(wikiPages)
      .set({
        content,
        contentHash: hashWikiContent(content),
        sizeBytes: Buffer.byteLength(content, "utf8"),
        updatedByWorkosId: input.actorWorkosId ?? null,
        updatedAt: new Date(),
      })
      .where(eq(wikiPages.id, referrer.id))
      .returning({ ...getTableColumns(wikiPages), txid: TXID_COLUMN });
    const { txid: referrerTxid, ...updatedReferrer } = firstRow(rows, "wiki link rewrite");
    txids.push(txidFromRow({ txid: referrerTxid }, "wiki link rewrite"));
    await recordVersion(db, updatedReferrer, "write", delta, input.actorWorkosId ?? null);
    await rebuildLinks(db, updatedReferrer);
    if (updatedReferrer.id === movedNode.id) movedNode = updatedReferrer;
    rewrittenReferrers.push(updatedReferrer.path);
  }

  for (const entry of timelineEntries) {
    const text = rewriteMovedTargets(entry.text, fromPath, newPath);
    if (text === entry.text) continue;
    await db.update(wikiTimelineEntries).set({ text }).where(eq(wikiTimelineEntries.id, entry.id));
  }

  return {
    node: movedNode,
    fromPath,
    movedDescendants: descendants.length,
    rewrittenReferrers,
    txids,
  };
}

/** Renames a node's display title and final path segment in one transaction. */
export async function renameWikiNode(
  input: {
    workspaceId: string;
    id: string;
    title: string;
    slug: string;
    actorWorkosId?: string | null;
  },
  db: DbClient = getDb(),
): Promise<{ node: WikiPage; txids: number[] }> {
  if (!supportsInteractiveTransactions(db)) {
    throw new WikiError("Renaming a wiki node requires a transactional database connection.");
  }
  return db.transaction(async (tx: DbClient) => {
    const node = await nodeById(tx, input.workspaceId, input.id);
    if (!node) throw new WikiError("Wiki node not found.");
    const moved = await moveWikiNodeInDb(
      {
        workspaceId: input.workspaceId,
        path: node.path,
        newParentPath: parentWikiPath(node.path),
        newSlug: input.slug,
        actorWorkosId: input.actorWorkosId ?? null,
      },
      tx,
    );
    const titled = await updateWikiNodeTitle(
      {
        workspaceId: input.workspaceId,
        id: input.id,
        title: input.title,
        actorWorkosId: input.actorWorkosId ?? null,
      },
      tx,
    );
    return {
      node: titled.node,
      txids: titled.txid === null ? moved.txids : [...moved.txids, titled.txid],
    };
  });
}

export async function deleteWikiPage(
  input: {
    workspaceId: string;
    path: string;
    recursive?: boolean;
    actorWorkosId?: string | null;
  },
  db: DbClient = getDb(),
): Promise<{ deletedPaths: string[]; txids: number[] }> {
  const node = await requireWikiNode(db, input.workspaceId, input.path);
  const descendants: WikiPage[] = await db
    .select()
    .from(wikiPages)
    .where(
      and(
        eq(wikiPages.workspaceId, input.workspaceId),
        like(wikiPages.path, `${escapeLike(node.path)}/%`),
      ),
    );
  if (node.nodeType === "page" && descendants.length > 0) {
    throw new WikiError(`Page "${node.path}" cannot contain child nodes.`);
  }
  if (node.nodeType === "folder" && descendants.length > 0 && !input.recursive) {
    throw new WikiError(
      `Folder "${node.path}" contains ${descendants.length} node(s). Pass recursive to delete it and its contents.`,
    );
  }
  const doomed = [...descendants].sort((a, b) => b.path.length - a.path.length).concat(node);
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
      .delete(wikiPages)
      .where(eq(wikiPages.id, target.id))
      .returning({ txid: TXID_COLUMN });
    txids.push(txidFromRow(deletedRows[0], "wiki page delete"));
  }
  return { deletedPaths: doomed.map((target) => target.path), txids };
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

export async function listWikiTimeline(
  input: { workspaceId: string; path: string; since?: Date },
  db: DbClient = getDb(),
): Promise<WikiTimelineEntry[]> {
  const page = await requireWikiPage(db, input.workspaceId, input.path);
  const conditions = [eq(wikiTimelineEntries.pageId, page.id)];
  if (input.since) conditions.push(gte(wikiTimelineEntries.at, input.since));
  return db
    .select()
    .from(wikiTimelineEntries)
    .where(and(...conditions))
    .orderBy(desc(wikiTimelineEntries.at));
}

export async function addWikiTimelineEntry(
  input: {
    workspaceId: string;
    path: string;
    at: Date;
    text: string;
    /** Explicit entry id for optimistic client inserts (Electric sync-back). */
    id?: string;
    actorWorkosId?: string | null;
  },
  db: DbClient = getDb(),
): Promise<WikiTimelineEntry & { txid: number }> {
  const text = input.text.trim();
  if (!text) throw new WikiError("Timeline entry text is required.");
  const page = await requireWikiPage(db, input.workspaceId, input.path);
  const inserted: Array<WikiTimelineEntry & { txid: string }> = await db
    .insert(wikiTimelineEntries)
    .values({
      id: input.id ?? randomUUID(),
      workspaceId: input.workspaceId,
      pageId: page.id,
      at: input.at,
      text,
      createdByWorkosId: input.actorWorkosId ?? null,
    })
    .returning({ ...getTableColumns(wikiTimelineEntries), txid: TXID_COLUMN });
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

  const ftsRank = sql`ts_rank_cd(${wikiPages.searchTsv}, websearch_to_tsquery('english', ${text}))`;
  const titleSimilarity = sql`word_similarity(${text}, ${wikiPages.title})`;
  const [ftsRows, titleRows]: [Array<{ id: string }>, Array<{ id: string }>] = await Promise.all([
    db
      .select({ id: wikiPages.id })
      .from(wikiPages)
      .where(
        and(
          eq(wikiPages.workspaceId, workspaceId),
          eq(wikiPages.nodeType, "page"),
          sql`websearch_to_tsquery('english', ${text}) @@ ${wikiPages.searchTsv}`,
        ),
      )
      .orderBy(desc(ftsRank))
      .limit(FTS_CANDIDATE_LIMIT),
    db
      .select({ id: wikiPages.id })
      .from(wikiPages)
      .where(
        and(
          eq(wikiPages.workspaceId, workspaceId),
          eq(wikiPages.nodeType, "page"),
          sql`${text} <% ${wikiPages.title}`,
        ),
      )
      .orderBy(desc(titleSimilarity))
      .limit(TITLE_CANDIDATE_LIMIT),
  ]);

  const scores = reciprocalRankFusion([
    ftsRows.map((row) => row.id),
    titleRows.map((row) => row.id),
  ]);
  if (scores.size === 0) return [];

  const pages: WikiPage[] = await db
    .select()
    .from(wikiPages)
    .where(inArray(wikiPages.id, [...scores.keys()]));
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
 * Regex grep over page titles and bodies for surfaces without a real filesystem
 * (chat, MCP). Postgres pre-filters with the same pattern; matching lines are
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
  let pages: WikiPage[];
  try {
    pages = await db
      .select()
      .from(wikiPages)
      .where(
        and(
          eq(wikiPages.workspaceId, workspaceId),
          eq(wikiPages.nodeType, "page"),
          sql`(${wikiPages.title} ${operator} ${options.pattern} OR ${wikiPages.content} ${operator} ${options.pattern})`,
        ),
      )
      .orderBy(asc(wikiPages.path));
  } catch {
    // Postgres and JS regex dialects differ at the edges; fall back to scanning
    // every page in JS rather than failing the grep.
    pages = await db
      .select()
      .from(wikiPages)
      .where(and(eq(wikiPages.workspaceId, workspaceId), eq(wikiPages.nodeType, "page")))
      .orderBy(asc(wikiPages.path));
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
    // A display title can match without appearing in the body (the SQL
    // prefilter includes titles); emit it as pseudo-line 0 so title-only
    // matches are not silently dropped.
    if (perPage === 0 && matches.length < limit && regex.test(page.title)) {
      matches.push({ slug: page.slug, path: page.path, lineNumber: 0, line: page.title });
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
  const versions: Array<typeof wikiPageVersions.$inferSelect> = await db
    .select()
    .from(wikiPageVersions)
    .where(
      and(
        eq(wikiPageVersions.workspaceId, workspaceId),
        gte(wikiPageVersions.createdAt, options.since),
      ),
    )
    .orderBy(desc(wikiPageVersions.createdAt));
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
): Promise<{ page: WikiPage; txid: number }> {
  return insertNode(db, { ...input, nodeType: "page" });
}

async function insertNode(
  db: DbClient,
  input: {
    workspaceId: string;
    path: string;
    nodeType: WikiNodeType;
    body: string;
    kind: WikiKind;
    id?: string;
    title?: string;
    actorWorkosId: string | null;
  },
): Promise<{ page: WikiPage; txid: number }> {
  const slug = wikiSlugFromPath(input.path);
  let insertedPages: Array<WikiPage & { txid: string }>;
  try {
    insertedPages = await db
      .insert(wikiPages)
      .values({
        id: input.id ?? randomUUID(),
        workspaceId: input.workspaceId,
        slug,
        path: input.path,
        nodeType: input.nodeType,
        title: input.title ?? deriveWikiTitle(input.body, slug),
        kind: input.kind,
        content: input.body,
        contentHash: hashWikiContent(input.body),
        sizeBytes: Buffer.byteLength(input.body, "utf8"),
        createdByWorkosId: input.actorWorkosId,
        updatedByWorkosId: input.actorWorkosId,
      })
      .returning({ ...getTableColumns(wikiPages), txid: TXID_COLUMN });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new WikiNodeExistsError(`A wiki node already exists at "${input.path}".`);
    }
    throw error;
  }
  const { txid, ...page } = firstRow(insertedPages, "wiki page insert");
  await recordVersion(
    db,
    page,
    "write",
    { added: input.nodeType === "page" ? countLines(input.body) : 0, removed: 0 },
    input.actorWorkosId,
  );
  if (input.nodeType === "page") await rebuildLinks(db, page);
  return { page, txid: txidFromRow({ txid }, "wiki page insert") };
}

/** Creates folders for any missing ancestors of `path`, top-down. */
async function ensureAncestorFolders(
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
    const existing = await pageByPath(db, workspaceId, ancestorPath);
    if (existing) {
      if (existing.nodeType !== "folder") throw new WikiError(`"${ancestorPath}" is not a folder.`);
      continue;
    }
    let inserted: { page: WikiPage; txid: number };
    try {
      inserted = await insertNode(db, {
        workspaceId,
        path: ancestorPath,
        nodeType: "folder",
        body: "",
        kind: "other",
        title: wikiSlugFromPath(ancestorPath),
        actorWorkosId,
      });
    } catch (error) {
      if (!(error instanceof WikiNodeExistsError)) throw error;
      // A concurrent writer created this ancestor first; treat it as existing.
      const winner = await pageByPath(db, workspaceId, ancestorPath);
      if (winner?.nodeType === "folder") continue;
      throw winner ? new WikiError(`"${ancestorPath}" is not a folder.`) : error;
    }
    created.push(ancestorPath);
    txids.push(inserted.txid);
  }
  return { created, txids };
}

async function nodeById(db: DbClient, workspaceId: string, id: string): Promise<WikiPage | null> {
  const [row]: WikiPage[] = await db
    .select()
    .from(wikiPages)
    .where(and(eq(wikiPages.workspaceId, workspaceId), eq(wikiPages.id, id)))
    .limit(1);
  return row ?? null;
}

async function pageByPath(
  db: DbClient,
  workspaceId: string,
  path: string,
): Promise<WikiPage | null> {
  const [row]: WikiPage[] = await db
    .select()
    .from(wikiPages)
    .where(and(eq(wikiPages.workspaceId, workspaceId), eq(wikiPages.path, path)))
    .limit(1);
  return row ?? null;
}

async function requireWikiPage(db: DbClient, workspaceId: string, ref: string): Promise<WikiPage> {
  const cleaned = ref.trim();
  if (!isValidWikiPath(cleaned)) {
    throw new WikiError(`Invalid page reference "${ref}".`);
  }
  const { pages } = await resolveWikiPages(workspaceId, [cleaned], db);
  const page = pages[0];
  if (!page) throw new WikiError(`No wiki page "${ref}".`);
  return page;
}

async function requireWikiNode(db: DbClient, workspaceId: string, ref: string): Promise<WikiPage> {
  const cleaned = ref.trim();
  if (!isValidWikiPath(cleaned)) throw new WikiError(`Invalid wiki path "${ref}".`);
  const exact = await pageByPath(db, workspaceId, cleaned);
  if (exact) return exact;
  const matches: WikiPage[] = await db
    .select()
    .from(wikiPages)
    .where(and(eq(wikiPages.workspaceId, workspaceId), eq(wikiPages.slug, cleaned)));
  if (matches.length === 1) return matches[0] as WikiPage;
  if (matches.length > 1) throw new WikiError(`Wiki basename "${ref}" is ambiguous; use its path.`);
  throw new WikiError(`No wiki node "${ref}".`);
}

async function recordVersion(
  db: DbClient,
  page: WikiPage,
  operation: "write" | "move" | "delete",
  delta: { added: number; removed: number },
  actorWorkosId: string | null,
): Promise<void> {
  await db.insert(wikiPageVersions).values({
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

async function rebuildLinks(db: DbClient, page: WikiPage): Promise<void> {
  if (page.nodeType !== "page") {
    await db.delete(wikiLinks).where(eq(wikiLinks.fromPageId, page.id));
    return;
  }
  const entries: Array<{ kind: WikiLinkKind; target: string }> = [
    ...wikiPageLinkTargets(page.content).map((target) => ({ kind: "page" as const, target })),
    ...wikiSourceRefTargets(page.content).map((target) => ({ kind: "source" as const, target })),
  ];
  await db.delete(wikiLinks).where(eq(wikiLinks.fromPageId, page.id));
  if (entries.length === 0) return;
  await db.insert(wikiLinks).values(
    entries.map((entry) => ({
      workspaceId: page.workspaceId,
      fromPageId: page.id,
      kind: entry.kind,
      target: entry.target,
    })),
  );
}

/** Rebuilds the derived link index for migrations and repair scripts. */
export async function rebuildWikiLinksForPage(
  page: WikiPage,
  db: DbClient = getDb(),
): Promise<void> {
  await rebuildLinks(db, page);
}

function rewriteMovedTargets(text: string, fromPath: string, toPath: string): string {
  return rewriteWikiPageLinks(text, (target) => {
    const moved = movedWikiPath(target, fromPath, toPath);
    return moved === target ? null : moved;
  });
}

function supportsInteractiveTransactions(db: DbClient): boolean {
  // neon-http exposes only fixed query batches, not the interactive transaction
  // required to discover and rewrite referrers atomically.
  return typeof db.transaction === "function" && !("batch" in db);
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; cause?: unknown };
  return value.code === "23505" || isUniqueViolation(value.cause);
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

function snippetFor(page: WikiPage, query: string): string {
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

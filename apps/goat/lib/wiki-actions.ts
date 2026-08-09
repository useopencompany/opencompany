"use server";

// Server actions for the wiki UI. Every mutation funnels through the same
// storage layer as the `wiki` agent tool, so versioning, link rebuilds, and
// validation are identical no matter who edits.
//
// The wiki UI is local-first: it applies mutations optimistically to its
// Electric-synced TanStack DB collections and calls these actions to persist.
// Each action returns the Postgres txids of its wiki-table statements so the
// client can hold optimistic state exactly until the write streams back.

import {
  addWikiTimelineEntry,
  deleteWikiPage,
  resolveWikiPages,
  WikiError,
  writeWikiPage,
} from "@opencompany/db/goat-wiki";
import { isValidWikiKind, isValidWikiSlug, wikiSlugFromTitle } from "@opencompany/goat-wiki";
import { currentGoatUser } from "@/lib/auth";

async function requireWikiContext() {
  const { user, workspace } = await currentGoatUser();
  if (!user.wikiEnabled) throw new WikiError("The wiki preview is not enabled for this user.");
  return { user, workspace };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireOptionalUuid(id: string | undefined): string | undefined {
  if (id === undefined) return undefined;
  if (!UUID_PATTERN.test(id)) throw new WikiError("Invalid id.");
  return id;
}

type WikiActionResult<T = Record<string, never>> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

async function runWikiAction<T>(action: () => Promise<T>): Promise<WikiActionResult<T>> {
  try {
    const result = await action();
    return { ok: true, ...result };
  } catch (error) {
    if (error instanceof WikiError) return { ok: false, error: error.message };
    throw error;
  }
}

export async function saveWikiPageAction(input: {
  path: string;
  body: string;
  kind?: string;
  title?: string;
}): Promise<WikiActionResult<{ path: string; title: string; txids: number[] }>> {
  return runWikiAction(async () => {
    const { user, workspace } = await requireWikiContext();
    const result = await writeWikiPage({
      workspaceId: workspace.id,
      path: input.path,
      body: input.body,
      ...(isValidWikiKind(input.kind) ? { kind: input.kind } : {}),
      ...(input.title?.trim() ? { title: input.title.trim() } : {}),
      actorWorkosId: user.workosUserId,
    });
    return { path: result.page.path, title: result.page.title, txids: result.txids };
  });
}

export async function createWikiPageAction(input: {
  parentPath: string | null;
  title: string;
  /** Client-generated row id, so an optimistic insert syncs onto the same row. */
  id?: string;
  /** Client-chosen slug (validated); derived from the title when absent. */
  slug?: string;
}): Promise<WikiActionResult<{ path: string; slug: string; title: string; txids: number[] }>> {
  return runWikiAction(async () => {
    const { user, workspace } = await requireWikiContext();
    const id = requireOptionalUuid(input.id);
    const title = input.title.trim() || "Untitled";
    let slug = input.slug?.trim();
    if (slug !== undefined && !isValidWikiSlug(slug)) {
      throw new WikiError(`Invalid slug "${slug}".`);
    }
    if (!slug) {
      const baseSlug = wikiSlugFromTitle(title) ?? "untitled";
      // Names may repeat (Notion-style); slugs may not. Suffix until free.
      slug = baseSlug;
      for (let suffix = 2; ; suffix += 1) {
        const taken = await resolveWikiPages(workspace.id, [slug]);
        if (taken.pages.length === 0) break;
        slug = `${baseSlug.slice(0, 76)}-${suffix}`;
        if (!isValidWikiSlug(slug)) throw new WikiError(`Cannot derive a slug from "${title}".`);
      }
    }
    const path = input.parentPath ? `${input.parentPath}/${slug}` : slug;
    const result = await writeWikiPage({
      workspaceId: workspace.id,
      path,
      body: "",
      title,
      ...(id ? { id } : {}),
      actorWorkosId: user.workosUserId,
    });
    return {
      path: result.page.path,
      slug: result.page.slug,
      title: result.page.title,
      txids: result.txids,
    };
  });
}

export async function deleteWikiPageAction(input: {
  slug: string;
  recursive?: boolean;
}): Promise<WikiActionResult<{ deletedPaths: string[]; txids: number[] }>> {
  return runWikiAction(async () => {
    const { user, workspace } = await requireWikiContext();
    const result = await deleteWikiPage({
      workspaceId: workspace.id,
      slug: input.slug,
      ...(input.recursive !== undefined ? { recursive: input.recursive } : {}),
      actorWorkosId: user.workosUserId,
    });
    return { deletedPaths: result.deletedPaths, txids: result.txids };
  });
}

export async function addWikiTimelineEntryAction(input: {
  slug: string;
  text: string;
  at?: string;
  /** Client-generated entry id, so an optimistic insert syncs onto the same row. */
  id?: string;
}): Promise<WikiActionResult<{ at: string; txid: number }>> {
  return runWikiAction(async () => {
    const { user, workspace } = await requireWikiContext();
    const id = requireOptionalUuid(input.id);
    const at = input.at?.trim() ? new Date(input.at.trim()) : new Date();
    if (Number.isNaN(at.getTime())) throw new WikiError("Invalid date.");
    const entry = await addWikiTimelineEntry({
      workspaceId: workspace.id,
      slug: input.slug,
      at,
      text: input.text,
      ...(id ? { id } : {}),
      actorWorkosId: user.workosUserId,
    });
    return { at: entry.at.toISOString(), txid: entry.txid };
  });
}

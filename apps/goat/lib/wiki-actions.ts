"use server";

// Server actions for the wiki UI. Every mutation funnels through the same
// storage layer as the `wiki` agent tool, so versioning, link rebuilds, and
// validation are identical no matter who edits.

import {
  addWikiTimelineEntry,
  deleteWikiPage,
  listWikiTimeline,
  moveWikiPage,
  resolveWikiPages,
  WikiError,
  writeWikiPage,
} from "@opencompany/db/goat-wiki";
import { isValidWikiKind, isValidWikiSlug, wikiSlugFromTitle } from "@opencompany/goat-wiki";
import { revalidatePath } from "next/cache";
import { currentGoatUser } from "@/lib/auth";

async function requireWikiContext() {
  const { user, workspace } = await currentGoatUser();
  if (!user.wikiEnabled) throw new WikiError("The wiki preview is not enabled for this user.");
  return { user, workspace };
}

type WikiActionResult<T = Record<string, never>> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

async function runWikiAction<T>(action: () => Promise<T>): Promise<WikiActionResult<T>> {
  try {
    const result = await action();
    revalidatePath("/wiki", "layout");
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
}): Promise<WikiActionResult<{ path: string; title: string }>> {
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
    return { path: result.page.path, title: result.page.title };
  });
}

export async function createWikiPageAction(input: {
  parentPath: string | null;
  title: string;
}): Promise<WikiActionResult<{ path: string; slug: string; title: string }>> {
  return runWikiAction(async () => {
    const { user, workspace } = await requireWikiContext();
    const title = input.title.trim() || "Untitled";
    const baseSlug = wikiSlugFromTitle(title) ?? "untitled";
    // Names may repeat (Notion-style); slugs may not. Suffix until free.
    let slug = baseSlug;
    for (let suffix = 2; ; suffix += 1) {
      const taken = await resolveWikiPages(workspace.id, [slug]);
      if (taken.pages.length === 0) break;
      slug = `${baseSlug.slice(0, 76)}-${suffix}`;
      if (!isValidWikiSlug(slug)) throw new WikiError(`Cannot derive a slug from "${title}".`);
    }
    const path = input.parentPath ? `${input.parentPath}/${slug}` : slug;
    const result = await writeWikiPage({
      workspaceId: workspace.id,
      path,
      body: "",
      title,
      actorWorkosId: user.workosUserId,
    });
    return { path: result.page.path, slug: result.page.slug, title: result.page.title };
  });
}

export async function setWikiPageKindAction(input: {
  slug: string;
  kind: string;
}): Promise<WikiActionResult<Record<string, never>>> {
  return runWikiAction(async () => {
    const { user, workspace } = await requireWikiContext();
    if (!isValidWikiKind(input.kind)) throw new WikiError(`Invalid kind "${input.kind}".`);
    const { pages } = await resolveWikiPages(workspace.id, [input.slug]);
    const page = pages[0];
    if (!page) throw new WikiError(`No wiki page "${input.slug}".`);
    await writeWikiPage({
      workspaceId: workspace.id,
      path: page.path,
      body: page.content,
      kind: input.kind,
      actorWorkosId: user.workosUserId,
    });
    return {} as Record<string, never>;
  });
}

export async function moveWikiPageAction(input: {
  slug: string;
  newParentPath: string | null;
}): Promise<WikiActionResult<{ path: string }>> {
  return runWikiAction(async () => {
    const { user, workspace } = await requireWikiContext();
    const result = await moveWikiPage({
      workspaceId: workspace.id,
      slug: input.slug,
      newParentPath: input.newParentPath,
      actorWorkosId: user.workosUserId,
    });
    return { path: result.page.path };
  });
}

export async function deleteWikiPageAction(input: {
  slug: string;
  recursive?: boolean;
}): Promise<WikiActionResult<{ deletedPaths: string[] }>> {
  return runWikiAction(async () => {
    const { user, workspace } = await requireWikiContext();
    const result = await deleteWikiPage({
      workspaceId: workspace.id,
      slug: input.slug,
      ...(input.recursive !== undefined ? { recursive: input.recursive } : {}),
      actorWorkosId: user.workosUserId,
    });
    return { deletedPaths: result.deletedPaths };
  });
}

export async function getWikiTimelineAction(input: {
  slug: string;
}): Promise<WikiActionResult<{ entries: Array<{ id: string; at: string; text: string }> }>> {
  try {
    const { workspace } = await requireWikiContext();
    const entries = await listWikiTimeline({ workspaceId: workspace.id, slug: input.slug });
    return {
      ok: true,
      entries: entries.map((entry) => ({
        id: entry.id,
        at: entry.at.toISOString(),
        text: entry.text,
      })),
    };
  } catch (error) {
    if (error instanceof WikiError) return { ok: false, error: error.message };
    throw error;
  }
}

export async function addWikiTimelineEntryAction(input: {
  slug: string;
  text: string;
  at?: string;
}): Promise<WikiActionResult<{ at: string }>> {
  return runWikiAction(async () => {
    const { user, workspace } = await requireWikiContext();
    const at = input.at?.trim() ? new Date(input.at.trim()) : new Date();
    if (Number.isNaN(at.getTime())) throw new WikiError("Invalid date.");
    const entry = await addWikiTimelineEntry({
      workspaceId: workspace.id,
      slug: input.slug,
      at,
      text: input.text,
      actorWorkosId: user.workosUserId,
    });
    return { at: entry.at.toISOString() };
  });
}

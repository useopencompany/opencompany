// Executes `wiki` tool calls against the workspace wiki. Unlike the brain's
// CLI bundle there is no subprocess: commands dispatch straight to the storage
// layer, and errors come back as { ok: false } so the model can self-correct.

import {
  addWikiTimelineEntry,
  deleteWikiPage,
  getWikiBacklinks,
  getWikiTree,
  grepWiki,
  listWikiTimeline,
  moveWikiPage,
  recentWikiChanges,
  resolveWikiPages,
  searchWiki,
  WikiError,
  type WikiTreeEntry,
  writeWikiPage,
} from "@opencompany/db/goat-wiki";
import {
  firstWikiPageRef,
  isValidWikiKind,
  isWikiDescendantPath,
  resolveWikiSince,
  type WikiToolInput,
  type WikiToolOutput,
  wikiPageRefs,
} from "@opencompany/goat-wiki";

export type RunWikiToolInput = {
  workspaceId: string;
  userWorkosId: string;
  toolInput: WikiToolInput;
  /** Test seam; production callers use the default client. */
  db?: unknown;
};

export async function runWikiToolForUser(input: RunWikiToolInput): Promise<WikiToolOutput> {
  try {
    const result = await dispatch(input);
    return { ok: true, result };
  } catch (error) {
    if (error instanceof WikiError) return { ok: false, error: error.message };
    throw error;
  }
}

async function dispatch(input: RunWikiToolInput): Promise<unknown> {
  const { workspaceId, userWorkosId, toolInput, db } = input;
  switch (toolInput.command) {
    case "tree": {
      const tree = await getWikiTree(workspaceId, db);
      return {
        pages: tree.map((entry) => ({
          path: entry.path,
          title: entry.title,
          kind: entry.kind,
          ...(entry.childCount > 0 ? { subpages: entry.childCount } : {}),
          updatedAt: entry.updatedAt.toISOString(),
        })),
        total: tree.length,
        ...(tree.length === 0
          ? { hint: 'The wiki is empty. Create the first page with { command: "write" }.' }
          : {}),
      };
    }
    case "read": {
      const refs = wikiPageRefs(toolInput);
      if (refs.length === 0) throw new WikiError('read requires "pages" (slug(s) or path(s)).');
      const [{ pages, missing }, tree] = await Promise.all([
        resolveWikiPages(workspaceId, refs, db),
        getWikiTree(workspaceId, db),
      ]);
      const resolved = await Promise.all(
        pages.map(async (page) => ({
          slug: page.slug,
          path: page.path,
          title: page.title,
          kind: page.kind,
          updatedAt: page.updatedAt.toISOString(),
          body: page.content,
          subpages: directChildren(tree, page.path),
          backlinks: (await getWikiBacklinks(workspaceId, page.slug, db)).map((link) => link.path),
        })),
      );
      return { pages: resolved, ...(missing.length > 0 ? { missing } : {}) };
    }
    case "grep": {
      const pattern = toolInput.query?.trim();
      if (!pattern) throw new WikiError('grep requires "query" (a regex pattern).');
      const matches = await grepWiki(
        workspaceId,
        {
          pattern,
          ignoreCase: toolInput.ignoreCase ?? true,
          ...(toolInput.limit !== undefined ? { limit: toolInput.limit } : {}),
        },
        db,
      );
      return { matches, ...(matches.length === 0 ? { hint: "No lines matched." } : {}) };
    }
    case "search": {
      const text = toolInput.query?.trim();
      if (!text) throw new WikiError('search requires "query".');
      const hits = await searchWiki(
        workspaceId,
        {
          text,
          ...(toolInput.limit !== undefined ? { limit: toolInput.limit } : {}),
          ...(toolInput.offset !== undefined ? { offset: toolInput.offset } : {}),
        },
        db,
      );
      return {
        hits: hits.map((hit) => ({
          path: hit.path,
          title: hit.title,
          kind: hit.kind,
          snippet: hit.snippet,
          updatedAt: hit.updatedAt.toISOString(),
        })),
      };
    }
    case "recent": {
      const since = resolveWikiSince(toolInput.since?.trim() || "2d");
      const changes = await recentWikiChanges(
        workspaceId,
        {
          since,
          ...(toolInput.limit !== undefined ? { limit: toolInput.limit } : {}),
        },
        db,
      );
      return {
        since: since.toISOString(),
        changes: changes.map((change) => ({
          path: change.path,
          title: change.title,
          writes: change.writes,
          addedLines: change.addedLines,
          removedLines: change.removedLines,
          lastChangedAt: change.lastChangedAt.toISOString(),
          ...(change.deleted ? { deleted: true } : {}),
        })),
      };
    }
    case "timeline": {
      const ref = requireSingleRef(toolInput, "timeline");
      const entries = await listWikiTimeline(
        {
          workspaceId,
          slug: ref,
          ...(toolInput.since?.trim() ? { since: resolveWikiSince(toolInput.since.trim()) } : {}),
        },
        db,
      );
      return {
        page: ref,
        entries: entries.map((entry) => ({ at: entry.at.toISOString(), text: entry.text })),
      };
    }
    case "write": {
      const path = toolInput.path?.trim();
      if (!path) throw new WikiError('write requires "path".');
      if (toolInput.body === undefined) throw new WikiError('write requires "body".');
      if (toolInput.kind !== undefined && !isValidWikiKind(toolInput.kind)) {
        throw new WikiError(
          `Invalid kind "${toolInput.kind}". Use project, person, company, research, meeting, or other.`,
        );
      }
      const result = await writeWikiPage(
        {
          workspaceId,
          path,
          body: toolInput.body,
          ...(isValidWikiKind(toolInput.kind) ? { kind: toolInput.kind } : {}),
          ...(toolInput.title?.trim() ? { title: toolInput.title.trim() } : {}),
          actorWorkosId: userWorkosId,
        },
        db,
      );
      return {
        action: result.action,
        path: result.page.path,
        slug: result.page.slug,
        title: result.page.title,
        ...(result.createdAncestors.length > 0
          ? { createdAncestors: result.createdAncestors }
          : {}),
      };
    }
    case "move": {
      const ref = requireSingleRef(toolInput, "move");
      const to = toolInput.to?.trim();
      if (!to) throw new WikiError('move requires "to" (a parent path, or "/" for the root).');
      const result = await moveWikiPage(
        {
          workspaceId,
          slug: ref,
          newParentPath: to === "/" ? null : to,
          actorWorkosId: userWorkosId,
        },
        db,
      );
      return {
        path: result.page.path,
        fromPath: result.fromPath,
        movedDescendants: result.movedDescendants,
      };
    }
    case "delete": {
      const ref = requireSingleRef(toolInput, "delete");
      const result = await deleteWikiPage(
        {
          workspaceId,
          slug: ref,
          ...(toolInput.recursive !== undefined ? { recursive: toolInput.recursive } : {}),
          actorWorkosId: userWorkosId,
        },
        db,
      );
      return { deletedPaths: result.deletedPaths };
    }
    case "timeline-add": {
      const ref = requireSingleRef(toolInput, "timeline-add");
      const text = toolInput.text?.trim();
      if (!text) throw new WikiError('timeline-add requires "text".');
      const at = toolInput.at?.trim() ? new Date(toolInput.at.trim()) : new Date();
      if (Number.isNaN(at.getTime())) {
        throw new WikiError(`Invalid "at" timestamp "${toolInput.at}".`);
      }
      const entry = await addWikiTimelineEntry(
        {
          workspaceId,
          slug: ref,
          at,
          text,
          actorWorkosId: userWorkosId,
        },
        db,
      );
      return { page: ref, at: entry.at.toISOString(), text: entry.text };
    }
    default:
      throw new WikiError(`Unsupported wiki command "${(toolInput as WikiToolInput).command}".`);
  }
}

function requireSingleRef(toolInput: WikiToolInput, command: string): string {
  const ref = firstWikiPageRef(toolInput);
  if (!ref) throw new WikiError(`${command} requires "pages" (one page slug or path).`);
  return ref;
}

function directChildren(tree: WikiTreeEntry[], parentPath: string): string[] {
  const depth = parentPath.split("/").length + 1;
  return tree
    .filter(
      (entry) =>
        isWikiDescendantPath(entry.path, parentPath) && entry.path.split("/").length === depth,
    )
    .map((entry) => entry.path);
}

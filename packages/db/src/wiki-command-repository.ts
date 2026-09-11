// Postgres implementation of the core WikiCommandRepository port. It is a thin
// adapter over the wiki domain functions in ./wiki — all tree/read/search/write/
// move/delete/timeline logic and transactions stay there. This layer only maps
// between the port DTOs and the domain shapes, translates WikiError into the
// core WikiCommandError, and adds transport-retry idempotency for the create and
// timeline-add commands (the two that would otherwise duplicate rows on replay).

import { createHash } from "node:crypto";
import {
  type WikiCommandDeleteResult,
  WikiCommandError,
  type WikiCommandFolderResult,
  type WikiCommandGrepMatch,
  type WikiCommandMoveResult,
  type WikiCommandPage,
  type WikiCommandRecentChange,
  type WikiCommandRepository,
  type WikiCommandScope,
  type WikiCommandSearchHit,
  type WikiCommandTarget,
  type WikiCommandTimelineAddResult,
  type WikiCommandTimelineItem,
  type WikiCommandTreeNode,
  type WikiCommandWriteResult,
} from "@opencompany/core";
import type { WikiKind } from "@opencompany/wiki";
import { and, eq } from "drizzle-orm";
import { wikiTimelineEntries } from "./product-schema";
import {
  addWikiTimelineEntry,
  createWikiFolder,
  deleteWikiPage,
  getWikiBacklinks,
  getWikiTree,
  grepWiki,
  listWikiTimeline,
  moveWikiNode,
  recentWikiChanges,
  resolveWikiPages,
  searchWiki,
  WikiError,
  writeWikiPage,
} from "./wiki";
import { resolveWikiForUser } from "./wikis";

type DbClient = any;

export class PostgresWikiCommandRepository implements WikiCommandRepository {
  constructor(private readonly db: DbClient) {}

  async resolveWiki(input: {
    workspaceId: string;
    userWorkosId: string;
    wikiId?: string | undefined;
  }): Promise<WikiCommandTarget | null> {
    const wiki = await resolveWikiForUser(input, { db: this.db });
    if (!wiki) return null;
    return {
      wikiId: wiki.id,
      name: wiki.name,
      slug: wiki.slug,
      instructions: wiki.instructions,
    };
  }

  getTree(input: WikiCommandScope): Promise<WikiCommandTreeNode[]> {
    return this.run(async () => getWikiTree(input, this.db));
  }

  resolvePages(
    input: WikiCommandScope & { refs: string[] },
  ): Promise<{ pages: WikiCommandPage[]; missing: string[] }> {
    return this.run(async () => {
      const { pages, missing } = await resolveWikiPages(input, input.refs, this.db);
      return {
        pages: pages.map((page) => ({
          slug: page.slug,
          path: page.path,
          title: page.title,
          kind: page.kind,
          updatedAt: page.updatedAt,
          content: page.content,
        })),
        missing,
      };
    });
  }

  getBacklinks(input: WikiCommandScope & { path: string }): Promise<string[]> {
    return this.run(async () => {
      const links = await getWikiBacklinks(input, input.path, this.db);
      return links.map((link) => link.path);
    });
  }

  grep(
    input: WikiCommandScope & { pattern: string; ignoreCase: boolean; limit?: number },
  ): Promise<WikiCommandGrepMatch[]> {
    return this.run(async () =>
      grepWiki(
        input,
        {
          pattern: input.pattern,
          ignoreCase: input.ignoreCase,
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        },
        this.db,
      ),
    );
  }

  search(
    input: WikiCommandScope & { text: string; limit?: number; offset?: number },
  ): Promise<WikiCommandSearchHit[]> {
    return this.run(async () =>
      searchWiki(
        input,
        {
          text: input.text,
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
          ...(input.offset !== undefined ? { offset: input.offset } : {}),
        },
        this.db,
      ),
    );
  }

  recentChanges(
    input: WikiCommandScope & { since: Date; limit?: number },
  ): Promise<WikiCommandRecentChange[]> {
    return this.run(async () =>
      recentWikiChanges(
        input,
        { since: input.since, ...(input.limit !== undefined ? { limit: input.limit } : {}) },
        this.db,
      ),
    );
  }

  listTimeline(
    input: WikiCommandScope & { path: string; since?: Date },
  ): Promise<WikiCommandTimelineItem[]> {
    return this.run(async () => {
      const entries = await listWikiTimeline(
        {
          scope: input,
          path: input.path,
          ...(input.since ? { since: input.since } : {}),
        },
        this.db,
      );
      return entries.map((entry) => ({ at: entry.at, text: entry.text }));
    });
  }

  createFolder(
    input: WikiCommandScope & {
      actorWorkosId: string;
      idempotencyKey: string;
      path: string;
      title?: string;
    },
  ): Promise<WikiCommandFolderResult> {
    return this.run(async () => {
      const result = await createWikiFolder(
        {
          scope: input,
          path: input.path,
          id: deterministicWikiId("wiki-command-folder", input),
          ...(input.title ? { title: input.title } : {}),
          actorWorkosId: input.actorWorkosId,
        },
        this.db,
      );
      return {
        action: result.action,
        path: result.folder.path,
        title: result.folder.title,
        createdAncestors: result.createdAncestors,
      };
    });
  }

  writePage(
    input: WikiCommandScope & {
      actorWorkosId: string;
      idempotencyKey: string;
      path: string;
      body: string;
      kind?: WikiKind;
      title?: string;
    },
  ): Promise<WikiCommandWriteResult> {
    return this.run(async () => {
      const result = await writeWikiPage(
        {
          scope: input,
          path: input.path,
          body: input.body,
          id: deterministicWikiId("wiki-command-page", input),
          ...(input.kind ? { kind: input.kind } : {}),
          ...(input.title !== undefined ? { title: input.title } : {}),
          actorWorkosId: input.actorWorkosId,
        },
        this.db,
      );
      return {
        action: result.action,
        path: result.page.path,
        slug: result.page.slug,
        title: result.page.title,
        createdAncestors: result.createdAncestors,
      };
    });
  }

  moveNode(
    input: WikiCommandScope & {
      actorWorkosId: string;
      path: string;
      newParentPath: string | null;
    },
  ): Promise<WikiCommandMoveResult> {
    return this.run(async () => {
      const result = await moveWikiNode(
        {
          scope: input,
          path: input.path,
          newParentPath: input.newParentPath,
          actorWorkosId: input.actorWorkosId,
        },
        this.db,
      );
      return {
        path: result.node.path,
        fromPath: result.fromPath,
        movedDescendants: result.movedDescendants,
        rewrittenReferrers: result.rewrittenReferrers,
      };
    });
  }

  deletePage(
    input: WikiCommandScope & {
      actorWorkosId: string;
      path: string;
      recursive?: boolean;
    },
  ): Promise<WikiCommandDeleteResult> {
    return this.run(async () => {
      const result = await deleteWikiPage(
        {
          scope: input,
          path: input.path,
          ...(input.recursive !== undefined ? { recursive: input.recursive } : {}),
          actorWorkosId: input.actorWorkosId,
        },
        this.db,
      );
      return { deletedPaths: result.deletedPaths };
    });
  }

  addTimelineEntry(
    input: WikiCommandScope & {
      actorWorkosId: string;
      idempotencyKey: string;
      path: string;
      at: Date;
      text: string;
    },
  ): Promise<WikiCommandTimelineAddResult> {
    return this.run(async () => {
      // Timeline entries are append-only, so a naive retry would insert a second
      // row. Derive a stable id from the idempotency key and replay it instead.
      const id = deterministicWikiId("wiki-command-timeline", input);
      const existing = await this.timelineEntryById(input.wikiId, id);
      if (existing) return existing;
      try {
        const entry = await addWikiTimelineEntry(
          {
            id,
            scope: input,
            path: input.path,
            at: input.at,
            text: input.text,
            actorWorkosId: input.actorWorkosId,
          },
          this.db,
        );
        return { at: entry.at, text: entry.text };
      } catch (error) {
        if (isUniqueViolation(error)) {
          const replay = await this.timelineEntryById(input.wikiId, id);
          if (replay) return replay;
        }
        throw error;
      }
    });
  }

  private async timelineEntryById(
    wikiId: string,
    id: string,
  ): Promise<WikiCommandTimelineAddResult | null> {
    const [row]: Array<{ at: Date; text: string }> = await this.db
      .select({ at: wikiTimelineEntries.at, text: wikiTimelineEntries.text })
      .from(wikiTimelineEntries)
      .where(and(eq(wikiTimelineEntries.wikiId, wikiId), eq(wikiTimelineEntries.id, id)))
      .limit(1);
    return row ? { at: row.at, text: row.text } : null;
  }

  private async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof WikiError) throw new WikiCommandError(error.message);
      throw error;
    }
  }
}

// A v5-shaped UUID derived from the wiki, actor, idempotency key, and target
// path so a transport retry lands on the same row identity. The wiki and path are
// folded in so two distinct writes never collide on a row id even if a caller
// reuses a key across wikis.
function deterministicWikiId(
  namespace: string,
  input: {
    workspaceId: string;
    wikiId: string;
    actorWorkosId: string;
    idempotencyKey: string;
    path: string;
  },
): string {
  const digest = createHash("sha256")
    .update(
      [
        namespace,
        input.workspaceId,
        input.wikiId,
        input.actorWorkosId,
        input.idempotencyKey,
        input.path,
      ].join("\n"),
    )
    .digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; cause?: unknown };
  return value.code === "23505" || isUniqueViolation(value.cause);
}

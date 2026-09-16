import { createHash } from "node:crypto";
import {
  type Actor,
  CoreError,
  type KnowledgeRepository,
  type WikiPage,
  type WikiSummary,
  type WikiTimelineEntry,
} from "@opencompany/core";
import { isValidWikiKind, isValidWikiSlug, wikiSlugFromTitle } from "@opencompany/wiki";
import { and, eq } from "drizzle-orm";
import type {
  KnowledgeCommandOperation,
  WikiPage as WikiPageRow,
  WikiTimelineEntry as WikiTimelineEntryRow,
} from "./product-schema";
import { knowledgeCommandIdempotency, wikiPages, wikiTimelineEntries } from "./product-schema";
import {
  addWikiTimelineEntry,
  createWikiFolder,
  deleteWikiPage,
  listWikiPagesWithBodies,
  renameWikiNode,
  updateWikiNodeTitle,
  WikiError,
  writeWikiPage,
} from "./wiki";
import { listWikisForUser, resolveWikiForUser, type WikiScope } from "./wikis";

type DbClient = any;
export class PostgresKnowledgeRepository implements KnowledgeRepository {
  constructor(private readonly db: DbClient) {}

  async resolveWiki(input: { actor: Actor; wikiId?: string | undefined }) {
    const wiki = await resolveWikiForUser(
      {
        userWorkosId: input.actor.userId,
        workspaceId: input.actor.workspaceId,
        ...(input.wikiId ? { wikiId: input.wikiId } : {}),
      },
      { db: this.db },
    );
    if (!wiki) return null;
    return {
      wikiId: wiki.id,
      name: wiki.name,
      slug: wiki.slug,
      instructions: wiki.instructions,
    };
  }

  async listWikis(input: { actor: Actor }): Promise<WikiSummary[]> {
    const rows = await listWikisForUser(
      { userWorkosId: input.actor.userId, workspaceId: input.actor.workspaceId },
      { db: this.db },
    );
    return rows.map((wiki) => ({
      id: wiki.id,
      name: wiki.name,
      slug: wiki.slug,
      instructions: wiki.instructions,
      access: wiki.access,
      isDefault: wiki.isDefault,
      createdAt: wiki.createdAt,
      updatedAt: wiki.updatedAt,
    }));
  }

  async listWikiPages(input: { actor: Actor; wikiId: string }) {
    const pages = await listWikiPagesWithBodies(this.wikiScope(input), this.db);
    return pages.map(wikiPage);
  }

  async createWikiPage(input: {
    actor: Actor;
    wikiId: string;
    idempotencyKey: string;
    clientPageId?: string;
    nodeType: WikiPage["nodeType"];
    parentPath: string | null;
    title: string;
    slug?: string;
  }) {
    try {
      const id = await this.reserveCreate(
        input,
        "wiki_page.create",
        {
          wikiId: input.wikiId,
          clientPageId: input.clientPageId ?? null,
          nodeType: input.nodeType,
          parentPath: input.parentPath,
          title: input.title,
          slug: input.slug ?? null,
        },
        input.clientPageId ?? deterministicWikiUuid("wiki-page", input, input.idempotencyKey),
      );
      const [replay] = await this.db
        .select()
        .from(wikiPages)
        .where(and(eq(wikiPages.wikiId, input.wikiId), eq(wikiPages.id, id)))
        .limit(1);
      if (replay) return { page: wikiPage(replay), transactionIds: [] };
      let slug = input.slug?.trim();
      if (slug !== undefined && !isValidWikiSlug(slug)) {
        throw new WikiError(`Invalid slug "${slug}".`);
      }
      if (!slug) {
        const baseSlug = wikiSlugFromTitle(input.title.trim()) ?? "untitled";
        slug = baseSlug;
        for (let suffix = 2; ; suffix += 1) {
          const candidatePath = input.parentPath ? `${input.parentPath}/${slug}` : slug;
          const [taken] = await this.db
            .select({ id: wikiPages.id })
            .from(wikiPages)
            .where(and(eq(wikiPages.wikiId, input.wikiId), eq(wikiPages.path, candidatePath)))
            .limit(1);
          if (!taken) break;
          slug = `${baseSlug.slice(0, 76)}-${suffix}`;
          if (!isValidWikiSlug(slug)) {
            throw new WikiError(`Cannot derive a slug from "${input.title}".`);
          }
        }
      }
      const path = input.parentPath ? `${input.parentPath}/${slug}` : slug;
      const [existingPath] = await this.db
        .select({ id: wikiPages.id })
        .from(wikiPages)
        .where(and(eq(wikiPages.wikiId, input.wikiId), eq(wikiPages.path, path)))
        .limit(1);
      if (existingPath) {
        throw new WikiError(`A Wiki node already exists at "${path}".`);
      }
      if (input.nodeType === "folder") {
        const result = await createWikiFolder(
          {
            id,
            scope: this.wikiScope(input),
            path,
            title: input.title.trim() || slug,
            actorWorkosId: input.actor.userId,
          },
          this.db,
        );
        return { page: wikiPage(result.folder), transactionIds: result.txids };
      }
      const result = await writeWikiPage(
        {
          id,
          scope: this.wikiScope(input),
          path,
          body: "",
          title: input.title.trim(),
          actorWorkosId: input.actor.userId,
        },
        this.db,
      );
      return { page: wikiPage(result.page), transactionIds: result.txids };
    } catch (error) {
      if (isUniqueViolation(error)) {
        const id =
          input.clientPageId ?? deterministicWikiUuid("wiki-page", input, input.idempotencyKey);
        const [replay] = await this.db
          .select()
          .from(wikiPages)
          .where(and(eq(wikiPages.wikiId, input.wikiId), eq(wikiPages.id, id)))
          .limit(1);
        if (replay) return { page: wikiPage(replay), transactionIds: [] };
        throw new CoreError("conflict", "A Wiki page with that identity already exists.");
      }
      throw knowledgeError(error);
    }
  }

  async updateWikiPage(input: {
    actor: Actor;
    wikiId: string;
    id: string;
    body?: string;
    kind?: WikiPage["kind"];
    slug?: string;
    title?: string;
  }) {
    try {
      const [page] = await this.db
        .select()
        .from(wikiPages)
        .where(and(eq(wikiPages.wikiId, input.wikiId), eq(wikiPages.id, input.id)))
        .limit(1);
      if (!page) {
        throw new CoreError("not_found", "Wiki page not found.");
      }
      if (input.slug !== undefined && !isValidWikiSlug(input.slug)) {
        throw new CoreError("invalid_argument", `Invalid Wiki slug "${input.slug}".`);
      }
      if (page.nodeType === "folder") {
        if (input.body !== undefined || input.kind !== undefined) {
          throw new CoreError("invalid_argument", "Folders only support title and slug updates.");
        }
        if (input.title === undefined && input.slug === undefined) {
          throw new CoreError("invalid_argument", "A folder title or slug is required.");
        }
      }
      const renamed =
        input.slug !== undefined
          ? await renameWikiNode(
              {
                scope: this.wikiScope(input),
                id: page.id,
                title: input.title ?? page.title,
                slug: input.slug,
                actorWorkosId: input.actor.userId,
              },
              this.db,
            )
          : null;
      const currentPage = renamed?.node ?? page;
      if (page.nodeType === "folder") {
        if (input.title === undefined) {
          if (renamed) {
            return { page: wikiPage(renamed.node), transactionIds: renamed.txids };
          }
          throw new CoreError("invalid_argument", "A folder title is required.");
        }
        if (renamed) return { page: wikiPage(renamed.node), transactionIds: renamed.txids };
        const result = await updateWikiNodeTitle(
          {
            scope: this.wikiScope(input),
            id: page.id,
            title: input.title,
            actorWorkosId: input.actor.userId,
          },
          this.db,
        );
        return {
          page: wikiPage(result.node),
          transactionIds: result.txid === null ? [] : [result.txid],
        };
      }
      if (renamed && input.body === undefined && input.kind === undefined) {
        return { page: wikiPage(renamed.node), transactionIds: renamed.txids };
      }
      const result = await writeWikiPage(
        {
          scope: this.wikiScope(input),
          path: currentPage.path,
          body: input.body ?? currentPage.content,
          ...(isValidWikiKind(input.kind) ? { kind: input.kind } : {}),
          ...(input.title !== undefined ? { title: input.title } : {}),
          actorWorkosId: input.actor.userId,
        },
        this.db,
      );
      return {
        page: wikiPage(result.page),
        transactionIds: [...(renamed?.txids ?? []), ...result.txids],
      };
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new CoreError("conflict", "A Wiki node with that path already exists.");
      }
      throw knowledgeError(error);
    }
  }

  async deleteWikiPage(input: { actor: Actor; wikiId: string; id: string; recursive: boolean }) {
    try {
      const [node] = await this.db
        .select({ path: wikiPages.path })
        .from(wikiPages)
        .where(and(eq(wikiPages.wikiId, input.wikiId), eq(wikiPages.id, input.id)))
        .limit(1);
      if (!node) throw new CoreError("not_found", "Wiki page not found.");
      const result = await deleteWikiPage(
        {
          scope: this.wikiScope(input),
          path: node.path,
          recursive: input.recursive,
          actorWorkosId: input.actor.userId,
        },
        this.db,
      );
      return { deletedPaths: result.deletedPaths, transactionIds: result.txids };
    } catch (error) {
      throw knowledgeError(error);
    }
  }

  async addWikiTimelineEntry(input: {
    actor: Actor;
    wikiId: string;
    idempotencyKey: string;
    clientEntryId?: string;
    id: string;
    text: string;
    at?: Date;
  }) {
    try {
      const id = await this.reserveCreate(
        input,
        "wiki_timeline.create",
        {
          wikiId: input.wikiId,
          clientEntryId: input.clientEntryId ?? null,
          id: input.id,
          text: input.text,
          at: input.at?.toISOString() ?? null,
        },
        input.clientEntryId ?? deterministicWikiUuid("wiki-timeline", input, input.idempotencyKey),
      );
      const [replay] = await this.db
        .select()
        .from(wikiTimelineEntries)
        .where(and(eq(wikiTimelineEntries.wikiId, input.wikiId), eq(wikiTimelineEntries.id, id)))
        .limit(1);
      if (replay) return { entry: wikiTimelineEntry(replay), transactionId: 0 };
      const [page] = await this.db
        .select({ path: wikiPages.path, nodeType: wikiPages.nodeType })
        .from(wikiPages)
        .where(and(eq(wikiPages.wikiId, input.wikiId), eq(wikiPages.id, input.id)))
        .limit(1);
      if (!page || page.nodeType !== "page") {
        throw new CoreError("not_found", "Wiki page not found.");
      }
      const result = await addWikiTimelineEntry(
        {
          id,
          scope: this.wikiScope(input),
          path: page.path,
          text: input.text,
          at: input.at ?? new Date(),
          actorWorkosId: input.actor.userId,
        },
        this.db,
      );
      return { entry: wikiTimelineEntry(result), transactionId: result.txid };
    } catch (error) {
      if (isUniqueViolation(error)) {
        const id =
          input.clientEntryId ??
          deterministicWikiUuid("wiki-timeline", input, input.idempotencyKey);
        const [replay] = await this.db
          .select()
          .from(wikiTimelineEntries)
          .where(and(eq(wikiTimelineEntries.wikiId, input.wikiId), eq(wikiTimelineEntries.id, id)))
          .limit(1);
        if (replay) return { entry: wikiTimelineEntry(replay), transactionId: 0 };
        throw new CoreError("conflict", "A Wiki timeline entry with that identity already exists.");
      }
      throw knowledgeError(error);
    }
  }

  private wikiScope(input: { actor: Actor; wikiId: string }): WikiScope {
    return { workspaceId: input.actor.workspaceId, wikiId: input.wikiId };
  }

  private async reserveCreate(
    input: { actor: Actor; idempotencyKey: string },
    operation: KnowledgeCommandOperation,
    command: unknown,
    proposedResourceId: string,
  ) {
    const requestHash = commandHash(operation, command);
    const [reservation] = await this.db
      .insert(knowledgeCommandIdempotency)
      .values({
        commandId: deterministicResourceId("goat_knowledge_command", input, input.idempotencyKey),
        userWorkosId: input.actor.userId,
        workspaceId: input.actor.workspaceId,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        operation,
        resourceId: proposedResourceId,
      })
      .onConflictDoUpdate({
        target: [
          knowledgeCommandIdempotency.userWorkosId,
          knowledgeCommandIdempotency.workspaceId,
          knowledgeCommandIdempotency.idempotencyKey,
        ],
        set: { touchedAt: new Date() },
      })
      .returning({
        requestHash: knowledgeCommandIdempotency.requestHash,
        operation: knowledgeCommandIdempotency.operation,
        resourceId: knowledgeCommandIdempotency.resourceId,
      });
    if (!reservation) throw new CoreError("conflict", "Could not reserve the command.");
    if (reservation.operation !== operation || reservation.requestHash !== requestHash) {
      throw new CoreError(
        "idempotency_conflict",
        "The Idempotency-Key was already used for another command.",
      );
    }
    return reservation.resourceId;
  }
}

function wikiPage(row: WikiPageRow): WikiPage {
  return {
    id: row.id,
    slug: row.slug,
    path: row.path,
    title: row.title,
    nodeType: row.nodeType,
    kind: row.kind,
    body: row.content,
    contentHash: row.contentHash,
    sizeBytes: row.sizeBytes,
    format: row.format,
    mimeType: row.mimeType,
    originalFileName: row.originalFileName,
    assetSizeBytes: row.assetSizeBytes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function wikiTimelineEntry(row: WikiTimelineEntryRow): WikiTimelineEntry {
  return {
    id: row.id,
    pageId: row.pageId,
    at: row.at,
    text: row.text,
    createdAt: row.createdAt,
  };
}

function deterministicResourceId(prefix: string, input: { actor: Actor }, key: string) {
  const digest = createHash("sha256")
    .update([prefix, input.actor.userId, input.actor.workspaceId, key].join("\n"))
    .digest("hex")
    .slice(0, 32);
  return `${prefix}_${digest}`;
}

/**
 * Wiki resources fold the target wiki into their derived id. Without it, the
 * same actor reusing one Idempotency-Key across two wikis would derive the same
 * row id in both and collide on the primary key.
 */
function deterministicWikiUuid(
  prefix: string,
  input: { actor: Actor; wikiId: string },
  key: string,
) {
  return uuidFromParts([prefix, input.actor.userId, input.actor.workspaceId, input.wikiId, key]);
}

function uuidFromParts(parts: string[]) {
  const digest = createHash("sha256").update(parts.join("\n")).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function commandHash(operation: string, input: unknown) {
  return createHash("sha256").update(stableJson({ operation, input })).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function knowledgeError(error: unknown) {
  if (error instanceof CoreError) return error;
  const message = error instanceof Error ? error.message : "Knowledge mutation failed.";
  if (/changed since it was loaded/iu.test(message)) return new CoreError("conflict", message);
  if (/^No wiki page /u.test(message)) return new CoreError("not_found", message);
  if (/already exists|is not empty/iu.test(message)) return new CoreError("conflict", message);
  if (error instanceof WikiError) {
    // WikiError also guards storage invariants. Those failures must remain internal instead of
    // being mislabeled as caller errors or leaking persistence diagnostics through the API.
    return /^Expected (?:a row|a txid) /u.test(message)
      ? error
      : new CoreError("invalid_argument", message);
  }
  return error;
}

function isUniqueViolation(error: unknown) {
  return Boolean(
    error && typeof error === "object" && (error as { code?: string }).code === "23505",
  );
}

import { createHash } from "node:crypto";
import {
  BRAIN_RETRIEVAL_COMMANDS,
  isValidBrainFolder,
  normalizeBrainCompiledTruth,
  normalizeBrainFolderForV1,
  normalizeBrainId,
  nowIso,
  parseBrainDocument,
  serializeBrainDocument,
} from "@opencompany/brain";
import {
  type Actor,
  type BrainDocument,
  type BrainFolder,
  type BrainOverview,
  type BrainSnapshot,
  type BrainSourceItem,
  CoreError,
  type KnowledgeRepository,
  type WikiPage,
  type WikiTimelineEntry,
} from "@opencompany/core";
import { isValidWikiKind, isValidWikiSlug, wikiSlugFromTitle } from "@opencompany/wiki";
import { and, count, eq, gte, inArray, ne } from "drizzle-orm";
import {
  brainFilePathFor,
  createBrainFolderRow,
  createBrainMarkdownContent,
  createBrainMarkdownDocument,
  deleteBrainFile,
  deleteBrainFolderRow,
  getBrainFile,
  listBrainFiles,
  listBrainFolderRows,
  renameBrainFolderRow,
  replaceBrainFileCompiledTruth,
  updateBrainFileContent,
} from "./brain-files";
import type {
  BrainDocument as BrainDocumentRow,
  KnowledgeCommandOperation,
  WikiPage as WikiPageRow,
  WikiTimelineEntry as WikiTimelineEntryRow,
} from "./product-schema";
import {
  brainDocuments,
  brainIngestJobs,
  brainSourceItems,
  brainSources,
  brainToolRuns,
  knowledgeCommandIdempotency,
  wikiPages,
  wikiTimelineEntries,
} from "./product-schema";
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
import { getBrainAccess } from "./workspaces";

type DbClient = any;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000;

export class PostgresKnowledgeRepository implements KnowledgeRepository {
  constructor(private readonly db: DbClient) {}

  async assertBrainAccess(input: { actor: Actor; brainId: string }) {
    const access = await getBrainAccess(
      { userWorkosId: input.actor.userId, brainRef: input.brainId },
      { db: this.db },
    );
    if (!access || access.brain.workspaceId !== input.actor.workspaceId) {
      throw new CoreError("not_found", "Brain not found.");
    }
  }

  async getBrainSnapshot(input: { actor: Actor; brainId: string }): Promise<BrainSnapshot> {
    const [documents, folders] = await Promise.all([
      listBrainFiles({ brainRef: input.brainId }, { db: this.db, includeInvalid: true }),
      listBrainFolderRows({ brainRef: input.brainId }, { db: this.db }),
    ]);
    return {
      folders: folders.map(brainFolder),
      documents: documents.map(brainDocument).sort(compareBrainDocuments),
    };
  }

  async getBrainOverview(input: {
    actor: Actor;
    brainId: string;
    now: Date;
  }): Promise<BrainOverview> {
    const cutoff = new Date(input.now.getTime() - SEVEN_DAYS_MS);
    const [[itemsAdded], [retrievals], [sources]] = await Promise.all([
      this.db
        .select({ value: count() })
        .from(brainDocuments)
        .where(
          and(eq(brainDocuments.brainRef, input.brainId), gte(brainDocuments.createdAt, cutoff)),
        ),
      this.db
        .select({ value: count() })
        .from(brainToolRuns)
        .where(
          and(
            eq(brainToolRuns.brainRef, input.brainId),
            eq(brainToolRuns.ok, true),
            gte(brainToolRuns.createdAt, cutoff),
            inArray(brainToolRuns.action, BRAIN_RETRIEVAL_COMMANDS),
          ),
        ),
      this.db
        .select({ value: count() })
        .from(brainSources)
        .where(
          and(
            eq(brainSources.brainId, input.brainId),
            eq(brainSources.enabled, true),
            ne(brainSources.provider, "slack_bot"),
          ),
        ),
    ]);
    return {
      windowStartedAt: cutoff,
      itemsAddedLast7Days: numberValue(itemsAdded?.value),
      retrievalsLast7Days: numberValue(retrievals?.value),
      activeSources: numberValue(sources?.value),
    };
  }

  async listBrainSourceItems(input: {
    actor: Actor;
    brainId: string;
    ids: string[];
  }): Promise<BrainSourceItem[]> {
    const rows = await this.db
      .select({
        id: brainSourceItems.id,
        sourceProvider: brainSourceItems.sourceProvider,
        sourceType: brainSourceItems.sourceType,
        externalId: brainSourceItems.externalId,
        title: brainSourceItems.title,
        lastIngestError: brainSourceItems.lastIngestError,
        createdAt: brainSourceItems.createdAt,
      })
      .from(brainSourceItems)
      .innerJoin(brainIngestJobs, eq(brainIngestJobs.sourceItemId, brainSourceItems.id))
      .where(
        and(eq(brainIngestJobs.brainRef, input.brainId), inArray(brainSourceItems.id, input.ids)),
      );
    const sourceItems = rows as BrainSourceItem[];
    return Array.from(new Map(sourceItems.map((row) => [row.id, row])).values());
  }

  async createBrainDocument(input: {
    actor: Actor;
    brainId: string;
    idempotencyKey: string;
    folderPath: string;
    fileName: string;
  }) {
    try {
      const folderPath = normalizeBrainFolderForV1(input.folderPath);
      const fileName = input.fileName.trim();
      const id = await this.reserveCreate(
        input,
        "brain_document.create",
        { folderPath, fileName },
        deterministicResourceId("goat_brain_doc", input, input.idempotencyKey),
      );
      const replay = await getBrainFile({ brainRef: input.brainId, fileId: id }, { db: this.db });
      if (replay) return brainDocument(replay);
      if (!isValidBrainFolder(folderPath)) {
        throw new CoreError(
          "invalid_argument",
          "Folder paths must be lowercase slugs separated by /.",
        );
      }
      if (!fileName || fileName.includes("/") || fileName.includes("\\")) {
        throw new CoreError("invalid_argument", "Give the Markdown file a valid name.");
      }
      const title = fileName.replace(/\.md$/iu, "").trim();
      const baseId = normalizeBrainId(title).slice(0, 80).replace(/-+$/gu, "");
      if (!baseId) {
        throw new CoreError(
          "invalid_argument",
          "File names must contain at least one letter or number.",
        );
      }
      const rows = await listBrainFiles({ brainRef: input.brainId }, { db: this.db });
      const used = new Set(rows.map((row) => row.brainId));
      for (let suffix = 1; suffix < 1_000; suffix += 1) {
        const brainId = suffixedId(baseId, suffix, 80);
        if (used.has(brainId)) continue;
        const path = brainFilePathFor(folderPath, brainId);
        const row = await createBrainMarkdownDocument(
          {
            id,
            brainRef: input.brainId,
            userWorkosId: input.actor.userId,
            path,
            content: createBrainMarkdownContent({
              id: brainId,
              folderPath,
              title,
              type: "note",
              status: "draft",
            }),
          },
          { db: this.db },
        );
        if (row) return brainDocument(row);
        const claimed = await getBrainFile(
          { brainRef: input.brainId, fileId: id },
          { db: this.db },
        );
        if (claimed) return brainDocument(claimed);
        used.add(brainId);
      }
      throw new CoreError("conflict", "Could not allocate a unique Brain document id.");
    } catch (error) {
      throw knowledgeError(error);
    }
  }

  async updateBrainDocument(input: {
    actor: Actor;
    brainId: string;
    documentId: string;
    body: string;
    expectedContentHash?: string;
  }) {
    try {
      const existing = await this.requireBrainDocument(input.brainId, input.documentId);
      const content = replaceBrainFileCompiledTruth({
        content: existing.content,
        compiledTruth: input.body,
        updatedAt: nowIso(),
      });
      const row = await updateBrainFileContent(
        {
          brainRef: input.brainId,
          userWorkosId: input.actor.userId,
          fileId: input.documentId,
          content,
          ...(input.expectedContentHash ? { expectedContentHash: input.expectedContentHash } : {}),
        },
        { db: this.db },
      );
      return brainDocument(row);
    } catch (error) {
      throw knowledgeError(error);
    }
  }

  async renameBrainDocument(input: {
    actor: Actor;
    brainId: string;
    documentId: string;
    title: string;
  }) {
    try {
      const title = input.title.trim();
      if (!title) throw new CoreError("invalid_argument", "Title cannot be empty.");
      const existing = await this.requireBrainDocument(input.brainId, input.documentId);
      const parsed = parseBrainDocument(existing.content);
      const content = serializeBrainDocument({
        title,
        compiledTruth: parsed.compiledTruth,
        timeline: parsed.timeline,
        frontmatter: {
          id: existing.brainId,
          folder: existing.folderPath,
          kind: existing.kind,
          type: existing.entityType,
          status: parsed.frontmatter.status ?? existing.status,
          title,
          createdAt: parsed.frontmatter.createdAt ?? existing.createdAt.toISOString(),
          updatedAt: nowIso(),
          relations: parsed.frontmatter.relations ?? [],
          ...(parsed.frontmatter.aliases ? { aliases: parsed.frontmatter.aliases } : {}),
          ...(parsed.frontmatter.description
            ? { description: parsed.frontmatter.description }
            : {}),
          ...(parsed.frontmatter.sources ? { sources: parsed.frontmatter.sources } : {}),
          ...(parsed.frontmatter.mergedInto ? { mergedInto: parsed.frontmatter.mergedInto } : {}),
        },
      });
      return brainDocument(
        await updateBrainFileContent(
          {
            brainRef: input.brainId,
            userWorkosId: input.actor.userId,
            fileId: input.documentId,
            content,
          },
          { db: this.db },
        ),
      );
    } catch (error) {
      throw knowledgeError(error);
    }
  }

  async deleteBrainDocument(input: { actor: Actor; brainId: string; documentId: string }) {
    try {
      await this.requireBrainDocument(input.brainId, input.documentId);
      await deleteBrainFile(
        {
          brainRef: input.brainId,
          userWorkosId: input.actor.userId,
          fileId: input.documentId,
        },
        { db: this.db },
      );
    } catch (error) {
      throw knowledgeError(error);
    }
  }

  async createBrainFolder(input: { actor: Actor; brainId: string; path: string }) {
    try {
      return brainFolder(
        await createBrainFolderRow(
          {
            brainRef: input.brainId,
            userWorkosId: input.actor.userId,
            path: input.path,
          },
          { db: this.db },
        ),
      );
    } catch (error) {
      throw knowledgeError(error);
    }
  }

  async renameBrainFolder(input: {
    actor: Actor;
    brainId: string;
    fromPath: string;
    toPath: string;
  }) {
    try {
      await renameBrainFolderRow(
        {
          brainRef: input.brainId,
          userWorkosId: input.actor.userId,
          fromPath: input.fromPath,
          toPath: input.toPath,
        },
        { db: this.db },
      );
      return { path: normalizeBrainFolderForV1(input.toPath) };
    } catch (error) {
      throw knowledgeError(error);
    }
  }

  async deleteBrainFolder(input: { actor: Actor; brainId: string; path: string }) {
    try {
      await deleteBrainFolderRow(
        {
          brainRef: input.brainId,
          userWorkosId: input.actor.userId,
          path: input.path,
        },
        { db: this.db },
      );
    } catch (error) {
      throw knowledgeError(error);
    }
  }

  async listWikiPages(input: { actor: Actor }) {
    const pages = await listWikiPagesWithBodies(input.actor.workspaceId, this.db);
    return pages.map(wikiPage);
  }

  async createWikiPage(input: {
    actor: Actor;
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
          clientPageId: input.clientPageId ?? null,
          nodeType: input.nodeType,
          parentPath: input.parentPath,
          title: input.title,
          slug: input.slug ?? null,
        },
        input.clientPageId ?? deterministicUuid("wiki-page", input, input.idempotencyKey),
      );
      const [replay] = await this.db
        .select()
        .from(wikiPages)
        .where(and(eq(wikiPages.workspaceId, input.actor.workspaceId), eq(wikiPages.id, id)))
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
            .where(
              and(
                eq(wikiPages.workspaceId, input.actor.workspaceId),
                eq(wikiPages.path, candidatePath),
              ),
            )
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
        .where(and(eq(wikiPages.workspaceId, input.actor.workspaceId), eq(wikiPages.path, path)))
        .limit(1);
      if (existingPath) {
        throw new WikiError(`A Wiki node already exists at "${path}".`);
      }
      if (input.nodeType === "folder") {
        const result = await createWikiFolder(
          {
            id,
            workspaceId: input.actor.workspaceId,
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
          workspaceId: input.actor.workspaceId,
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
          input.clientPageId ?? deterministicUuid("wiki-page", input, input.idempotencyKey);
        const [replay] = await this.db
          .select()
          .from(wikiPages)
          .where(and(eq(wikiPages.workspaceId, input.actor.workspaceId), eq(wikiPages.id, id)))
          .limit(1);
        if (replay) return { page: wikiPage(replay), transactionIds: [] };
        throw new CoreError("conflict", "A Wiki page with that identity already exists.");
      }
      throw knowledgeError(error);
    }
  }

  async updateWikiPage(input: {
    actor: Actor;
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
        .where(and(eq(wikiPages.workspaceId, input.actor.workspaceId), eq(wikiPages.id, input.id)))
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
                workspaceId: input.actor.workspaceId,
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
            workspaceId: input.actor.workspaceId,
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
          workspaceId: input.actor.workspaceId,
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

  async deleteWikiPage(input: { actor: Actor; id: string; recursive: boolean }) {
    try {
      const [node] = await this.db
        .select({ path: wikiPages.path })
        .from(wikiPages)
        .where(and(eq(wikiPages.workspaceId, input.actor.workspaceId), eq(wikiPages.id, input.id)))
        .limit(1);
      if (!node) throw new CoreError("not_found", "Wiki page not found.");
      const result = await deleteWikiPage(
        {
          workspaceId: input.actor.workspaceId,
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
          clientEntryId: input.clientEntryId ?? null,
          id: input.id,
          text: input.text,
          at: input.at?.toISOString() ?? null,
        },
        input.clientEntryId ?? deterministicUuid("wiki-timeline", input, input.idempotencyKey),
      );
      const [replay] = await this.db
        .select()
        .from(wikiTimelineEntries)
        .where(
          and(
            eq(wikiTimelineEntries.workspaceId, input.actor.workspaceId),
            eq(wikiTimelineEntries.id, id),
          ),
        )
        .limit(1);
      if (replay) return { entry: wikiTimelineEntry(replay), transactionId: 0 };
      const [page] = await this.db
        .select({ path: wikiPages.path, nodeType: wikiPages.nodeType })
        .from(wikiPages)
        .where(and(eq(wikiPages.workspaceId, input.actor.workspaceId), eq(wikiPages.id, input.id)))
        .limit(1);
      if (!page || page.nodeType !== "page") {
        throw new CoreError("not_found", "Wiki page not found.");
      }
      const result = await addWikiTimelineEntry(
        {
          id,
          workspaceId: input.actor.workspaceId,
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
          input.clientEntryId ?? deterministicUuid("wiki-timeline", input, input.idempotencyKey);
        const [replay] = await this.db
          .select()
          .from(wikiTimelineEntries)
          .where(
            and(
              eq(wikiTimelineEntries.workspaceId, input.actor.workspaceId),
              eq(wikiTimelineEntries.id, id),
            ),
          )
          .limit(1);
        if (replay) return { entry: wikiTimelineEntry(replay), transactionId: 0 };
        throw new CoreError("conflict", "A Wiki timeline entry with that identity already exists.");
      }
      throw knowledgeError(error);
    }
  }

  private async requireBrainDocument(brainId: string, documentId: string) {
    const row = await getBrainFile({ brainRef: brainId, fileId: documentId }, { db: this.db });
    if (!row) throw new CoreError("not_found", "Brain document not found.");
    return row;
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

function brainDocument(row: BrainDocumentRow): BrainDocument {
  const parsed = parseBrainDocument(row.content);
  const title = row.title || parsed.title || row.brainId;
  return {
    id: row.id,
    brainId: row.brainId,
    folderPath: row.folderPath,
    path: brainFilePathFor(row.folderPath, row.brainId),
    title,
    ...(parsed.frontmatter.description ? { description: parsed.frontmatter.description } : {}),
    content: row.content,
    body: normalizeBrainCompiledTruth(row.body, title),
    timeline: parsed.timeline,
    format: row.format,
    mimeType: row.mimeType ?? "text/markdown",
    originalFileName: row.originalFileName,
    assetSizeBytes: row.assetSizeBytes,
    relations: parsed.frontmatter.relations ?? [],
    sources: parsed.frontmatter.sources ?? [],
    kind: row.kind,
    type: row.entityType,
    status: row.status,
    aliases: parsed.frontmatter.aliases ?? [],
    contentHash: row.contentHash,
    sizeBytes: row.sizeBytes,
    createdByActorId: row.createdByWorkosId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function brainFolder(row: {
  id: string;
  path: string;
  source: "system" | "custom";
  createdAt: Date;
  updatedAt: Date;
}): BrainFolder {
  return {
    id: row.id,
    path: row.path,
    source: row.source,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
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

function deterministicUuid(prefix: string, input: { actor: Actor }, key: string) {
  const digest = createHash("sha256")
    .update([prefix, input.actor.userId, input.actor.workspaceId, key].join("\n"))
    .digest("hex");
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

function suffixedId(base: string, suffix: number, maxLength: number) {
  if (suffix === 1) return base;
  const ending = `-${suffix}`;
  const prefix = base.slice(0, maxLength - ending.length).replace(/-+$/gu, "");
  return `${prefix || "untitled"}${ending}`;
}

function compareBrainDocuments(a: BrainDocument, b: BrainDocument) {
  const folder = a.folderPath.localeCompare(b.folderPath);
  return folder || b.updatedAt.getTime() - a.updatedAt.getTime();
}

function numberValue(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function knowledgeError(error: unknown) {
  if (error instanceof CoreError) return error;
  const message = error instanceof Error ? error.message : "Knowledge mutation failed.";
  if (/changed since it was loaded/iu.test(message)) return new CoreError("conflict", message);
  if (message === "Brain document not found." || /^No wiki page /u.test(message)) {
    return new CoreError("not_found", message);
  }
  if (/already exists|is not empty/iu.test(message)) return new CoreError("conflict", message);
  if (error instanceof WikiError) {
    // WikiError also guards storage invariants. Those failures must remain internal instead of
    // being mislabeled as caller errors or leaking persistence diagnostics through the API.
    return /^Expected (?:a row|a txid) /u.test(message)
      ? error
      : new CoreError("invalid_argument", message);
  }
  if (
    /^(?:Brain file path|Folder path|Folder paths|Required folders|Cannot rename|Only binary-backed)/u.test(
      message,
    ) ||
    /^Folder ".*" (?:is required|does not exist)/u.test(message)
  ) {
    return new CoreError("invalid_argument", message);
  }
  return error;
}

function isUniqueViolation(error: unknown) {
  return Boolean(
    error && typeof error === "object" && (error as { code?: string }).code === "23505",
  );
}

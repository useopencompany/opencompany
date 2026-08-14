import { createHash } from "node:crypto";
import {
  BRAIN_RETRIEVAL_COMMANDS,
  BRAIN_SKILL_DESCRIPTION_MAX_LENGTH,
  BRAIN_SKILL_NAME_MAX_LENGTH,
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
  type Skill,
  type SkillCatalogItem,
  type SkillImportSource,
  type SkillListItem,
  type WikiPage,
  type WikiTimelineEntry,
} from "@opencompany/core";
import { isValidWikiKind, isValidWikiSlug, wikiSlugFromTitle } from "@opencompany/wiki";
import { and, asc, count, desc, eq, gte, inArray, isNull, ne } from "drizzle-orm";
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
  Skill as SkillRow,
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
  skills,
  wikiPages,
  wikiTimelineEntries,
} from "./product-schema";
import {
  addWikiTimelineEntry,
  deleteWikiPage,
  listWikiPagesWithBodies,
  resolveWikiPages,
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
          const taken = await resolveWikiPages(input.actor.workspaceId, [slug], this.db);
          if (taken.pages.length === 0) break;
          slug = `${baseSlug.slice(0, 76)}-${suffix}`;
          if (!isValidWikiSlug(slug)) {
            throw new WikiError(`Cannot derive a slug from "${input.title}".`);
          }
        }
      }
      const path = input.parentPath ? `${input.parentPath}/${slug}` : slug;
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
    slug: string;
    body: string;
    kind?: WikiPage["kind"];
    title?: string;
  }) {
    try {
      const resolved = await resolveWikiPages(input.actor.workspaceId, [input.slug], this.db);
      const page = resolved.pages[0];
      if (!page || page.slug !== input.slug) {
        throw new CoreError("not_found", "Wiki page not found.");
      }
      const result = await writeWikiPage(
        {
          workspaceId: input.actor.workspaceId,
          path: page.path,
          body: input.body,
          ...(isValidWikiKind(input.kind) ? { kind: input.kind } : {}),
          ...(input.title !== undefined ? { title: input.title } : {}),
          actorWorkosId: input.actor.userId,
        },
        this.db,
      );
      return { page: wikiPage(result.page), transactionIds: result.txids };
    } catch (error) {
      throw knowledgeError(error);
    }
  }

  async deleteWikiPage(input: { actor: Actor; slug: string; recursive: boolean }) {
    try {
      const result = await deleteWikiPage(
        {
          workspaceId: input.actor.workspaceId,
          slug: input.slug,
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
    slug: string;
    text: string;
    at?: Date;
  }) {
    try {
      const id = await this.reserveCreate(
        input,
        "wiki_timeline.create",
        {
          clientEntryId: input.clientEntryId ?? null,
          slug: input.slug,
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
      const result = await addWikiTimelineEntry(
        {
          id,
          workspaceId: input.actor.workspaceId,
          slug: input.slug,
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

  async listSkills(input: { actor: Actor }): Promise<SkillListItem[]> {
    const rows: SkillListRow[] = await this.db
      .select({
        id: skills.id,
        slug: skills.slug,
        name: skills.name,
        description: skills.description,
        status: skills.status,
        sourceType: skills.sourceType,
        sourceUrl: skills.sourceUrl,
        sourceRef: skills.sourceRef,
        sourcePath: skills.sourcePath,
        resolvedCommit: skills.resolvedCommit,
        updatedAt: skills.updatedAt,
      })
      .from(skills)
      .where(and(eq(skills.workspaceId, input.actor.workspaceId), isNull(skills.archivedAt)))
      .orderBy(desc(skills.updatedAt));
    return rows.map(skillListRow);
  }

  async listSkillCatalog(input: { actor: Actor }): Promise<SkillCatalogItem[]> {
    const rows = await this.db
      .select({ slug: skills.slug, name: skills.name, description: skills.description })
      .from(skills)
      .where(
        and(
          eq(skills.workspaceId, input.actor.workspaceId),
          eq(skills.status, "active"),
          isNull(skills.archivedAt),
        ),
      )
      .orderBy(asc(skills.name));
    return rows.map((row: { slug: string; name: string; description: string }) => ({
      id: row.slug,
      name: row.name,
      description: row.description,
    }));
  }

  async getSkill(input: { actor: Actor; slug: string }) {
    const [row] = await this.skillRows(input.actor.workspaceId, input.slug);
    return row ? skillRow(row) : null;
  }

  async createSkill(input: {
    actor: Actor;
    idempotencyKey: string;
    name: string;
    description: string;
  }) {
    validateSkill(input);
    const id = await this.reserveCreate(
      input,
      "skill.create",
      { name: input.name.trim(), description: input.description.trim() },
      deterministicResourceId("goat_skill", input, input.idempotencyKey),
    );
    const [replay] = await this.db
      .select()
      .from(skills)
      .where(and(eq(skills.workspaceId, input.actor.workspaceId), eq(skills.id, id)))
      .limit(1);
    if (replay) return skillRow(replay);
    const slug = await this.uniqueSkillSlug(input.actor.workspaceId, input.name);
    let rows: SkillRow[];
    try {
      rows = await this.db
        .insert(skills)
        .values({
          id,
          workspaceId: input.actor.workspaceId,
          slug,
          name: input.name.trim(),
          description: input.description.trim(),
          instructions: "",
          status: "draft",
          createdByWorkosId: input.actor.userId,
        })
        .returning();
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const [replay] = await this.db
        .select()
        .from(skills)
        .where(and(eq(skills.workspaceId, input.actor.workspaceId), eq(skills.id, id)))
        .limit(1);
      if (replay) return skillRow(replay);
      throw new CoreError("conflict", "A Skill with that identity already exists.");
    }
    const [row] = rows;
    if (!row) throw new CoreError("conflict", "Could not create the skill.");
    return skillRow(row);
  }

  async importSkill(input: {
    actor: Actor;
    idempotencyKey: string;
    name: string;
    description: string;
    instructions: string;
    source: SkillImportSource;
    resolvedCommit: string;
    integrity: string;
  }) {
    validateSkill({ ...input, status: "active" });
    const operation = "skill.import" as const;
    const command = {
      source: input.source,
      resolvedCommit: input.resolvedCommit,
      integrity: input.integrity,
    };
    const requestHash = commandHash(operation, command);
    const proposedResourceId = deterministicResourceId("goat_skill", input, input.idempotencyKey);
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
    if (!reservation) throw new CoreError("conflict", "Could not reserve the Skill import.");
    if (reservation.operation !== operation || reservation.requestHash !== requestHash) {
      throw new CoreError(
        "idempotency_conflict",
        "The Idempotency-Key was already used for another command.",
      );
    }

    const replay = await this.findSkillById(input.actor.workspaceId, reservation.resourceId);
    if (replay) {
      await this.completeImportCommand(input, replay.id);
      return { skill: skillRow(replay), idempotentReplay: true };
    }
    const existing = await this.findImportedSkill(input.actor.workspaceId, input.source);
    if (existing) {
      await this.completeImportCommand(input, existing.id);
      return { skill: skillRow(existing), idempotentReplay: true };
    }

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const slug = await this.uniqueSkillSlug(input.actor.workspaceId, input.name);
      try {
        const [created] = await this.db
          .insert(skills)
          .values({
            id: proposedResourceId,
            workspaceId: input.actor.workspaceId,
            slug,
            name: input.name.trim(),
            description: input.description.trim(),
            instructions: input.instructions,
            status: "active",
            createdByWorkosId: input.actor.userId,
            sourceType: input.source.type,
            sourceUrl: input.source.url,
            sourceRef: input.source.ref,
            sourcePath: input.source.path,
            resolvedCommit: input.resolvedCommit,
            integrity: input.integrity,
          })
          .returning();
        if (!created) throw new CoreError("conflict", "Could not import the Skill.");
        await this.completeImportCommand(input, created.id);
        return { skill: skillRow(created), idempotentReplay: false };
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        const winner =
          (await this.findSkillById(input.actor.workspaceId, proposedResourceId)) ??
          (await this.findImportedSkill(input.actor.workspaceId, input.source));
        if (winner) {
          await this.completeImportCommand(input, winner.id);
          return { skill: skillRow(winner), idempotentReplay: true };
        }
      }
    }
    throw new CoreError("conflict", "Could not allocate a unique Skill slug.");
  }

  async updateSkill(input: {
    actor: Actor;
    slug: string;
    name: string;
    description: string;
    instructions: string;
    status: Skill["status"];
  }) {
    validateSkill(input);
    const [target] = await this.db
      .select({ sourceType: skills.sourceType, sourceUrl: skills.sourceUrl })
      .from(skills)
      .where(
        and(
          eq(skills.workspaceId, input.actor.workspaceId),
          eq(skills.slug, input.slug),
          isNull(skills.archivedAt),
        ),
      )
      .limit(1);
    if (!target) throw new CoreError("not_found", "Skill not found.");
    if (target.sourceType) {
      throw new CoreError(
        "conflict",
        `This skill was imported from ${target.sourceUrl} and can't be edited here. Remove and re-import if the source changed.`,
      );
    }
    const [row] = await this.db
      .update(skills)
      .set({
        name: input.name.trim(),
        description: input.description.trim(),
        instructions: input.instructions,
        status: input.status,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(skills.workspaceId, input.actor.workspaceId),
          eq(skills.slug, input.slug),
          isNull(skills.archivedAt),
        ),
      )
      .returning();
    if (!row) throw new CoreError("not_found", "Skill not found.");
    return skillRow(row);
  }

  async archiveSkill(input: { actor: Actor; slug: string }) {
    const rows = await this.db
      .update(skills)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(skills.workspaceId, input.actor.workspaceId),
          eq(skills.slug, input.slug),
          isNull(skills.archivedAt),
        ),
      )
      .returning({ slug: skills.slug });
    if (rows.length === 0) throw new CoreError("not_found", "Skill not found.");
  }

  private async requireBrainDocument(brainId: string, documentId: string) {
    const row = await getBrainFile({ brainRef: brainId, fileId: documentId }, { db: this.db });
    if (!row) throw new CoreError("not_found", "Brain document not found.");
    return row;
  }

  private skillRows(workspaceId: string, slug?: string) {
    return this.db
      .select({
        id: skills.id,
        slug: skills.slug,
        name: skills.name,
        description: skills.description,
        instructions: skills.instructions,
        status: skills.status,
        sourceType: skills.sourceType,
        sourceUrl: skills.sourceUrl,
        sourceRef: skills.sourceRef,
        sourcePath: skills.sourcePath,
        resolvedCommit: skills.resolvedCommit,
        createdAt: skills.createdAt,
        updatedAt: skills.updatedAt,
      })
      .from(skills)
      .where(
        and(
          eq(skills.workspaceId, workspaceId),
          ...(slug ? [eq(skills.slug, slug)] : []),
          isNull(skills.archivedAt),
        ),
      )
      .orderBy(desc(skills.updatedAt));
  }

  private async findSkillById(workspaceId: string, id: string): Promise<SkillRow | null> {
    const [row] = await this.db
      .select()
      .from(skills)
      .where(and(eq(skills.workspaceId, workspaceId), eq(skills.id, id)))
      .limit(1);
    return row ?? null;
  }

  private async findImportedSkill(
    workspaceId: string,
    source: SkillImportSource,
  ): Promise<SkillRow | null> {
    const [row] = await this.db
      .select()
      .from(skills)
      .where(
        and(
          eq(skills.workspaceId, workspaceId),
          eq(skills.sourceUrl, source.url),
          eq(skills.sourceRef, source.ref),
          eq(skills.sourcePath, source.path),
          isNull(skills.archivedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  private async completeImportCommand(
    input: { actor: Actor; idempotencyKey: string },
    resourceId: string,
  ) {
    await this.db
      .update(knowledgeCommandIdempotency)
      .set({ resourceId, completedAt: new Date(), touchedAt: new Date() })
      .where(
        and(
          eq(knowledgeCommandIdempotency.userWorkosId, input.actor.userId),
          eq(knowledgeCommandIdempotency.workspaceId, input.actor.workspaceId),
          eq(knowledgeCommandIdempotency.idempotencyKey, input.idempotencyKey),
          eq(knowledgeCommandIdempotency.operation, "skill.import"),
        ),
      );
  }

  private async uniqueSkillSlug(workspaceId: string, name: string) {
    const base = normalizeBrainId(name).slice(0, 64).replace(/-+$/gu, "") || "skill";
    const rows = await this.db
      .select({ slug: skills.slug })
      .from(skills)
      .where(and(eq(skills.workspaceId, workspaceId), isNull(skills.archivedAt)));
    const taken = new Set(rows.map((row: { slug: string }) => row.slug));
    if (!taken.has(base)) return base;
    for (let suffix = 2; suffix < 1_000; suffix += 1) {
      const candidate = `${base.slice(0, 60)}-${suffix}`;
      if (!taken.has(candidate)) return candidate;
    }
    throw new CoreError("conflict", "Could not allocate a unique skill slug.");
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

function skillRow(row: SkillRow): Skill {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    status: row.status,
    source: skillSource(row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

type SkillListRow = Pick<
  SkillRow,
  | "id"
  | "slug"
  | "name"
  | "description"
  | "status"
  | "sourceType"
  | "sourceUrl"
  | "sourceRef"
  | "sourcePath"
  | "resolvedCommit"
  | "updatedAt"
>;

function skillListRow(row: SkillListRow): SkillListItem {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    status: row.status,
    source: skillSource(row),
    updatedAt: row.updatedAt,
  };
}

function skillSource(
  row: Pick<SkillRow, "sourceType" | "sourceUrl" | "sourceRef" | "sourcePath" | "resolvedCommit">,
) {
  return row.sourceType && row.sourceUrl
    ? {
        type: row.sourceType,
        url: row.sourceUrl,
        ref: row.sourceRef ?? "",
        path: row.sourcePath ?? "",
        resolvedCommit: row.resolvedCommit ?? "",
      }
    : null;
}

function validateSkill(input: {
  name: string;
  description: string;
  instructions?: string;
  status?: Skill["status"];
}) {
  const name = input.name.trim();
  const description = input.description.trim();
  if (!name) throw new CoreError("invalid_argument", "Skill name cannot be empty.");
  if (name.length > BRAIN_SKILL_NAME_MAX_LENGTH) {
    throw new CoreError(
      "invalid_argument",
      `Skill names must be ${BRAIN_SKILL_NAME_MAX_LENGTH} characters or fewer.`,
    );
  }
  if (description.length > BRAIN_SKILL_DESCRIPTION_MAX_LENGTH) {
    throw new CoreError(
      "invalid_argument",
      `Skill descriptions must be ${BRAIN_SKILL_DESCRIPTION_MAX_LENGTH} characters or fewer.`,
    );
  }
  if (description.includes("<") || description.includes(">")) {
    throw new CoreError("invalid_argument", 'Skill descriptions cannot contain "<" or ">".');
  }
  if (input.status === "active" && !input.instructions?.trim()) {
    throw new CoreError("invalid_argument", "Add skill instructions before making it active.");
  }
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

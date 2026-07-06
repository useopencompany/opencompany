import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, notInArray } from "drizzle-orm";
import {
  deriveGoatBrainEdges,
  type GoatBrainEntityType,
  type GoatBrainEvidenceKind,
  type GoatBrainRelation,
  type GoatBrainSource,
  type GoatBrainStatus,
  type GoatBrainTimelineEntry,
  goatBrainEntryFromLegacyMarkdown,
  goatBrainFolderFromRelativePath,
  goatBrainIdFromRelativePath,
  goatBrainRelativePath,
  goatBrainSidecarRelativePath,
  isBuiltInGoatBrainEntityType,
  isSafeGoatBrainRelativePath,
  isValidGoatBrainFolder,
  isValidGoatBrainId,
  isValidGoatBrainStatus,
  normalizeGoatBrainFolderForV1,
  type GoatBrainDocument as ParsedGoatBrainDocument,
  parseGoatBrainDocument,
  parseGoatBrainSidecar,
  recoverLegacyGoatBrainEntryFromSidecar,
  replaceGoatBrainCompiledTruth,
  serializeGoatBrainDocument,
  serializeLegacyGoatBrainEntry,
  validateGoatBrainDocument,
  validateGoatBrainSidecar,
} from "../../goat-brain/src/index";
import { getDb } from "./client";
import {
  type GoatBrainDocument,
  goatBrainDocuments,
  goatBrainDocumentVersions,
  goatBrainEdges,
  goatBrainFolders,
  goatBrainTimelineEntries,
} from "./goat-schema";

export const GOAT_BRAIN_FILE_MIME_TYPE = "text/markdown";
export const GOAT_BRAIN_FILE_KIND = "markdown";
export const MAX_GOAT_BRAIN_FILE_BYTES = 1_000_000;

export type GoatBrainFileProjection = {
  path: string;
  brainId: string;
  folderPath: string;
  kind: typeof GOAT_BRAIN_FILE_KIND;
  mimeType: typeof GOAT_BRAIN_FILE_MIME_TYPE;
  content: string;
  body: string;
  timeline: GoatBrainTimelineEntry[];
  contentHash: string;
  sizeBytes: number;
  title: string;
  entityType: GoatBrainEntityType;
  evidenceKind?: GoatBrainEvidenceKind;
  status: GoatBrainStatus;
  relations: GoatBrainRelation[];
  sources: GoatBrainSource[];
  aliases: string[];
  tags: string[];
};

export type GoatBrainStoredFrontmatter = {
  id?: string;
  type?: string;
  evidenceKind?: string;
  status?: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  aliases?: string[];
  related?: GoatBrainRelation[];
  sources?: GoatBrainSource[];
  mergedInto?: string;
  folder?: string;
  tags?: string[];
};

export type MaterializedGoatBrainFile = {
  id: string;
  brainId: string;
  path: string;
  folderPath: string;
  contentHash: string;
};

export type GoatBrainSyncFile = {
  path: string;
  content: string;
  skip?: boolean;
};

export type GoatBrainSyncConflict = {
  path: string;
  reason: "changed_since_materialize" | "created_since_materialize";
};

type DbClient = any;
type DbLike = any;

export function hashGoatBrainContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function createGoatBrainMarkdownContent(input: {
  id: string;
  folderPath: string;
  title: string;
  type: GoatBrainEntityType;
  evidenceKind?: GoatBrainEvidenceKind;
  status?: GoatBrainStatus;
  compiledTruth?: string;
  related?: GoatBrainRelation[];
  sources?: GoatBrainSource[];
  aliases?: string[];
  timeline?: GoatBrainTimelineEntry[];
  createdAt?: string;
  updatedAt?: string;
}): string {
  const now = new Date().toISOString();
  const folder = input.folderPath;
  const doc: ParsedGoatBrainDocument = {
    frontmatter: {
      id: input.id,
      folder,
      type: input.type,
      ...(input.evidenceKind ? { evidenceKind: input.evidenceKind } : {}),
      status: input.status ?? "draft",
      title: input.title,
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
      relations: input.related ?? [],
      ...(input.aliases?.length ? { aliases: input.aliases } : {}),
      ...(input.sources?.length ? { sources: input.sources } : {}),
    },
    title: input.title,
    compiledTruth: input.compiledTruth ?? "",
    timeline: input.timeline ?? [],
  };
  return serializeGoatBrainDocument(doc);
}

export function replaceGoatBrainFileCompiledTruth(input: {
  content: string;
  compiledTruth: string;
  updatedAt?: string;
}): string {
  return replaceGoatBrainCompiledTruth(input.content, input.compiledTruth, {
    ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
  });
}

export function deriveGoatBrainFileProjection(input: {
  path: string;
  content: string;
}): GoatBrainFileProjection {
  const normalizedPath = normalizeBrainFilePath(input.path);
  const source = sourceFromSidecarOrPayloadSync(normalizedPath, input.content);

  const pathBrainId = goatBrainIdFromRelativePath(normalizedPath);
  const pathFolder = goatBrainFolderFromRelativePath(normalizedPath);
  if (!pathBrainId || !pathFolder) {
    throw new Error(`Brain file path "${normalizedPath}" must be a safe markdown path.`);
  }

  const parsed = parseGoatBrainDocument(source);
  const brainId =
    parsed.frontmatter.id && isValidGoatBrainId(parsed.frontmatter.id)
      ? parsed.frontmatter.id
      : pathBrainId;
  const rawFolderPath =
    parsed.frontmatter.folder && isValidGoatBrainFolder(parsed.frontmatter.folder)
      ? parsed.frontmatter.folder
      : pathFolder;
  const folderPath = normalizeGoatBrainFolderForV1(rawFolderPath);
  if (brainId !== pathBrainId) {
    throw new Error(`frontmatter.id "${brainId}" does not match path id "${pathBrainId}".`);
  }
  if (folderPath !== pathFolder) {
    throw new Error(
      `frontmatter.folder "${rawFolderPath}" does not match path folder "${pathFolder}".`,
    );
  }
  const entityType =
    parsed.frontmatter.type && isBuiltInGoatBrainEntityType(parsed.frontmatter.type)
      ? parsed.frontmatter.type
      : null;
  const status = isValidGoatBrainStatus(parsed.frontmatter.status)
    ? parsed.frontmatter.status
    : "draft";
  const evidenceKind = parsed.frontmatter.evidenceKind;
  const title = parsed.title || parsed.frontmatter.title || titleFromId(brainId);
  const validation = validateGoatBrainDocument(parsed, brainId, source);
  if (!validation.ok) throw new Error(validation.errors.join("\n"));
  if (!entityType) throw new Error("frontmatter.type must be a built-in brain entity type.");
  const content = canonicalGoatBrainContent({
    parsed,
    brainId,
    folderPath,
    title,
    entityType,
    ...(evidenceKind ? { evidenceKind } : {}),
    status,
    source,
  });
  const sizeBytes = Buffer.byteLength(content, "utf8");
  if (sizeBytes > MAX_GOAT_BRAIN_FILE_BYTES) {
    throw new Error(`Brain file "${normalizedPath}" exceeds ${MAX_GOAT_BRAIN_FILE_BYTES} bytes.`);
  }

  return {
    path: normalizedPath,
    brainId,
    folderPath,
    kind: GOAT_BRAIN_FILE_KIND,
    mimeType: GOAT_BRAIN_FILE_MIME_TYPE,
    content,
    body: parsed.compiledTruth,
    timeline: parsed.timeline,
    contentHash: hashGoatBrainContent(content),
    sizeBytes,
    title,
    entityType,
    ...(evidenceKind ? { evidenceKind } : {}),
    status,
    relations: parsed.frontmatter.relations ?? [],
    sources: parsed.frontmatter.sources ?? [],
    aliases: parsed.frontmatter.aliases ?? [],
    tags: parsed.frontmatter.tags ?? [],
  };
}

function canonicalGoatBrainContent(input: {
  parsed: ReturnType<typeof parseGoatBrainDocument>;
  brainId: string;
  folderPath: string;
  title: string;
  entityType: GoatBrainEntityType;
  evidenceKind?: GoatBrainEvidenceKind;
  status: GoatBrainStatus;
  source: string;
}): string {
  const fm = input.parsed.frontmatter;
  if (
    fm.id === input.brainId &&
    fm.folder === input.folderPath &&
    fm.type === input.entityType &&
    fm.status === input.status &&
    fm.evidenceKind === input.evidenceKind &&
    fm.title === input.title
  ) {
    return input.source;
  }
  return serializeGoatBrainDocument({
    title: input.title,
    compiledTruth: input.parsed.compiledTruth,
    timeline: input.parsed.timeline,
    frontmatter: {
      id: input.brainId,
      folder: input.folderPath,
      type: input.entityType,
      ...(input.evidenceKind ? { evidenceKind: input.evidenceKind } : {}),
      status: input.status,
      title: input.title,
      createdAt: fm.createdAt ?? new Date().toISOString(),
      updatedAt: fm.updatedAt ?? new Date().toISOString(),
      relations: fm.relations ?? [],
      ...(fm.aliases ? { aliases: fm.aliases } : {}),
      ...(fm.tags ? { tags: fm.tags } : {}),
      ...(fm.sources ? { sources: fm.sources } : {}),
      ...(fm.mergedInto ? { mergedInto: fm.mergedInto } : {}),
    },
  });
}

export async function listGoatBrainFilesForUser(
  userWorkosId: string,
  options: { db?: DbClient; includeInvalid?: boolean } = {},
): Promise<GoatBrainDocument[]> {
  const db = options.db ?? getDb();
  return db
    .select()
    .from(goatBrainDocuments)
    .where(eq(goatBrainDocuments.userWorkosId, userWorkosId))
    .orderBy(desc(goatBrainDocuments.updatedAt));
}

export async function getGoatBrainFileForUser(
  input: { userWorkosId: string; fileId: string },
  options: { db?: DbClient } = {},
): Promise<GoatBrainDocument | null> {
  const db = options.db ?? getDb();
  const rows = await db
    .select()
    .from(goatBrainDocuments)
    .where(
      and(
        eq(goatBrainDocuments.userWorkosId, input.userWorkosId),
        eq(goatBrainDocuments.id, input.fileId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function upsertGoatBrainFileForUser(
  input: {
    userWorkosId: string;
    path: string;
    content: string;
    id?: string;
    taskId?: string | null;
  },
  options: { db?: DbClient } = {},
): Promise<GoatBrainDocument> {
  const db = options.db ?? getDb();
  return db.transaction(async (tx: DbLike) => {
    const projection = deriveGoatBrainFileProjection({ path: input.path, content: input.content });
    const now = new Date();
    const existing = await findDocumentForUpsert(tx, input.userWorkosId, projection.path);
    const documentId = existing?.id ?? input.id ?? `goat_brain_doc_${randomUUID()}`;
    if (existing && existing.contentHash !== projection.contentHash) {
      await insertVersion(tx, input.userWorkosId, existing, "overwrite", input.taskId ?? null);
    }

    const rows = await tx
      .insert(goatBrainDocuments)
      .values({
        id: documentId,
        userWorkosId: input.userWorkosId,
        ...documentValues(projection),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [goatBrainDocuments.userWorkosId, goatBrainDocuments.brainId],
        set: { ...documentValues(projection), updatedAt: now },
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to upsert Goat brain document.");
    await replaceDerivedRows(tx, input.userWorkosId, row, projection);
    return row;
  });
}

export async function updateGoatBrainFileContentForUser(
  input: { userWorkosId: string; fileId: string; content: string; expectedContentHash?: string },
  options: { db?: DbClient } = {},
): Promise<GoatBrainDocument> {
  const db = options.db ?? getDb();
  return db.transaction(async (tx: DbLike) => {
    const existing = await getDocumentById(tx, input.userWorkosId, input.fileId);
    if (!existing) throw new Error("Brain document not found.");
    if (input.expectedContentHash && existing.contentHash !== input.expectedContentHash) {
      throw new Error("Brain document changed since it was loaded. Retry with the latest content.");
    }
    const projection = deriveGoatBrainFileProjection({
      path: goatBrainFilePathFor(existing.folderPath, existing.brainId),
      content: input.content,
    });
    if (existing.contentHash !== projection.contentHash) {
      await insertVersion(tx, input.userWorkosId, existing, "overwrite", null);
    }
    const rows = await tx
      .update(goatBrainDocuments)
      .set({ ...documentValues(projection), updatedAt: new Date() })
      .where(
        and(
          eq(goatBrainDocuments.userWorkosId, input.userWorkosId),
          eq(goatBrainDocuments.id, input.fileId),
        ),
      )
      .returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to update Goat brain document.");
    await replaceDerivedRows(tx, input.userWorkosId, row, projection);
    return row;
  });
}

export async function moveGoatBrainFileForUser(
  input: { userWorkosId: string; fileId: string; path: string; content: string },
  options: { db?: DbClient } = {},
): Promise<GoatBrainDocument> {
  const db = options.db ?? getDb();
  return db.transaction(async (tx: DbLike) => {
    const existing = await getDocumentById(tx, input.userWorkosId, input.fileId);
    if (!existing) throw new Error("Brain document not found.");
    const projection = deriveGoatBrainFileProjection({ path: input.path, content: input.content });
    if (
      existing.contentHash !== projection.contentHash ||
      existing.folderPath !== projection.folderPath
    ) {
      await insertVersion(tx, input.userWorkosId, existing, "overwrite", null);
    }
    const rows = await tx
      .update(goatBrainDocuments)
      .set({ ...documentValues(projection), updatedAt: new Date() })
      .where(
        and(
          eq(goatBrainDocuments.userWorkosId, input.userWorkosId),
          eq(goatBrainDocuments.id, input.fileId),
        ),
      )
      .returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to move Goat brain document.");
    await replaceDerivedRows(tx, input.userWorkosId, row, projection);
    return row;
  });
}

export async function deleteGoatBrainFileForUser(
  input: { userWorkosId: string; fileId: string; taskId?: string | null },
  options: { db?: DbClient } = {},
): Promise<void> {
  const db = options.db ?? getDb();
  await db.transaction(async (tx: DbLike) => {
    const existing = await getDocumentById(tx, input.userWorkosId, input.fileId);
    if (existing)
      await insertVersion(tx, input.userWorkosId, existing, "delete", input.taskId ?? null);
    await tx
      .delete(goatBrainDocuments)
      .where(
        and(
          eq(goatBrainDocuments.userWorkosId, input.userWorkosId),
          eq(goatBrainDocuments.id, input.fileId),
        ),
      );
  });
}

export async function materializeGoatBrainFilesToRoot(input: {
  userWorkosId: string;
  root: string;
  db?: DbClient;
  cliSource?: string;
}): Promise<MaterializedGoatBrainFile[]> {
  await rm(input.root, { recursive: true, force: true });
  await mkdir(input.root, { recursive: true });
  const rows = await listGoatBrainFilesForUser(input.userWorkosId, {
    ...(input.db ? { db: input.db } : {}),
    includeInvalid: true,
  });
  for (const row of rows) {
    const payloadPath = goatBrainFilePathFor(row.folderPath, row.brainId);
    let entry: ReturnType<typeof goatBrainEntryFromLegacyMarkdown> | null = null;
    try {
      entry = goatBrainEntryFromLegacyMarkdown(row.content);
    } catch {}
    if (!entry) {
      await writeRootFile(input.root, payloadPath, row.content);
      continue;
    }

    const payload = entry.body;
    const sidecarPath = goatBrainSidecarRelativePath(row.folderPath, row.brainId);
    await writeRootFile(input.root, payloadPath, payload);
    await writeRootFile(
      input.root,
      sidecarPath,
      JSON.stringify(
        {
          schemaVersion: "goat.brain.entry.v1",
          id: entry.id,
          folder: entry.folder,
          title: entry.title,
          kind: entry.kind,
          mimeType: entry.mimeType,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
          relations: entry.relations,
          sources: entry.sources,
          type: entry.type,
          ...(entry.evidenceKind ? { evidenceKind: entry.evidenceKind } : {}),
          status: entry.status,
          ...(entry.aliases.length > 0 ? { aliases: entry.aliases } : {}),
          tags: entry.tags,
          timeline: entry.timeline,
          payload: {
            path: payloadPath,
            sha256: hashGoatBrainContent(payload),
            sizeBytes: Buffer.byteLength(payload, "utf8"),
          },
        },
        null,
        2,
      ),
    );
  }
  if (input.cliSource)
    await writeFile(path.join(input.root, "goat-brain.mjs"), input.cliSource, "utf8");
  return rows.map((row) => ({
    id: row.id,
    brainId: row.brainId,
    path: goatBrainFilePathFor(row.folderPath, row.brainId),
    folderPath: row.folderPath,
    contentHash: row.contentHash,
  }));
}

export async function readGoatBrainFilesFromRoot(root: string): Promise<GoatBrainSyncFile[]> {
  const relativePaths = await walkMarkdown(root, "");
  const files: GoatBrainSyncFile[] = [];
  for (const relativePath of relativePaths) {
    const content = await sourceFromRootFile(root, relativePath);
    if (content === null) {
      files.push({ path: relativePath, content: "", skip: true });
      continue;
    }
    files.push({ path: relativePath, content });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function syncGoatBrainFilesForUser(input: {
  userWorkosId: string;
  files: GoatBrainSyncFile[];
  baseSnapshot: MaterializedGoatBrainFile[];
  db?: DbClient;
  taskId?: string | null;
}): Promise<{ upserted: number; deleted: number; conflicts: GoatBrainSyncConflict[] }> {
  const db = input.db ?? getDb();
  const currentRows: GoatBrainDocument[] = await db
    .select()
    .from(goatBrainDocuments)
    .where(eq(goatBrainDocuments.userWorkosId, input.userWorkosId));
  const currentByPath = new Map(
    currentRows.map((row: GoatBrainDocument) => [
      goatBrainFilePathFor(row.folderPath, row.brainId),
      row,
    ]),
  );
  const currentByBrainId = new Map(currentRows.map((row: GoatBrainDocument) => [row.brainId, row]));
  const baseByPath = new Map(input.baseSnapshot.map((file) => [file.path, file]));
  const nextByPath = new Map<string, GoatBrainSyncFile>();
  const skippedPaths = new Set<string>();
  for (const file of input.files) {
    const normalizedPath = normalizeBrainFilePath(file.path);
    if (nextByPath.has(normalizedPath))
      throw new Error(`Duplicate brain file path "${normalizedPath}".`);
    const base = baseByPath.get(normalizedPath);
    const unchangedFromBase =
      base !== undefined && hashGoatBrainContent(file.content) === base.contentHash;
    const skip = Boolean(file.skip || unchangedFromBase);
    if (skip) {
      skippedPaths.add(normalizedPath);
    } else {
      deriveGoatBrainFileProjection({ path: normalizedPath, content: file.content });
    }
    nextByPath.set(normalizedPath, {
      path: normalizedPath,
      content: file.content,
      ...(skip ? { skip: true } : {}),
    });
  }

  const conflicts: GoatBrainSyncConflict[] = [];
  const handledConflictPaths = new Set<string>();
  for (const [pathName] of nextByPath) {
    const next = nextByPath.get(pathName);
    const current = currentByPath.get(pathName);
    const base = baseByPath.get(pathName);
    if (current && base && current.contentHash !== base.contentHash) {
      conflicts.push({ path: pathName, reason: "changed_since_materialize" });
      if (!next?.skip) handledConflictPaths.add(pathName);
    }
    if (current && !base) {
      conflicts.push({ path: pathName, reason: "created_since_materialize" });
      if (!next?.skip) handledConflictPaths.add(pathName);
    }
  }
  for (const [pathName] of baseByPath) {
    if (nextByPath.has(pathName)) continue;
    const current = currentByPath.get(pathName);
    const base = baseByPath.get(pathName);
    if (current && base && current.contentHash !== base.contentHash) {
      conflicts.push({ path: pathName, reason: "changed_since_materialize" });
    }
  }
  const unhandledConflicts = conflicts.filter(
    (conflict) => !handledConflictPaths.has(conflict.path),
  );
  if (unhandledConflicts.length > 0)
    return { upserted: 0, deleted: 0, conflicts: unhandledConflicts };

  let upserted = 0;
  for (const pathName of handledConflictPaths) {
    const file = nextByPath.get(pathName);
    const current = currentByPath.get(pathName);
    if (!file || file.skip || !current) continue;
    await upsertConflictDocument({
      userWorkosId: input.userWorkosId,
      path: pathName,
      content: file.content,
      current,
      taskId: input.taskId ?? null,
      db,
    });
    upserted += 1;
  }

  for (const [pathName, file] of nextByPath) {
    if (file.skip || handledConflictPaths.has(pathName)) continue;
    const brainId = goatBrainIdFromRelativePath(pathName);
    const existing =
      currentByPath.get(pathName) ?? (brainId ? currentByBrainId.get(brainId) : undefined);
    await upsertGoatBrainFileForUser(
      {
        userWorkosId: input.userWorkosId,
        path: pathName,
        content: file.content,
        ...(existing?.id ? { id: existing.id } : {}),
        taskId: input.taskId ?? null,
      },
      { db },
    );
    upserted += 1;
  }

  const nextBrainIds = new Set(
    [...nextByPath.keys()]
      .map((pathName) => goatBrainIdFromRelativePath(pathName))
      .filter((brainId): brainId is string => Boolean(brainId)),
  );
  const deleteIds = [...baseByPath.keys()].flatMap((pathName) => {
    if (nextByPath.has(pathName)) return [];
    if (skippedPaths.has(pathName)) return [];
    const current = currentByPath.get(pathName);
    if (current && nextBrainIds.has(current.brainId)) return [];
    return current ? [current.id] : [];
  });
  for (const id of deleteIds) {
    await deleteGoatBrainFileForUser(
      { userWorkosId: input.userWorkosId, fileId: id, taskId: input.taskId ?? null },
      { db },
    );
  }
  return { upserted, deleted: deleteIds.length, conflicts: [] };
}

export async function syncGoatBrainFilesFromRoot(input: {
  userWorkosId: string;
  root: string;
  baseSnapshot: MaterializedGoatBrainFile[];
  db?: DbClient;
  taskId?: string | null;
}): Promise<{ upserted: number; deleted: number; conflicts: GoatBrainSyncConflict[] }> {
  const files = await readGoatBrainFilesFromRoot(input.root);
  return syncGoatBrainFilesForUser({
    userWorkosId: input.userWorkosId,
    files,
    baseSnapshot: input.baseSnapshot,
    ...(input.db ? { db: input.db } : {}),
    taskId: input.taskId ?? null,
  });
}

async function upsertConflictDocument(input: {
  userWorkosId: string;
  path: string;
  content: string;
  current: GoatBrainDocument;
  taskId: string | null;
  db: DbClient;
}) {
  const parsed = parseGoatBrainDocument(input.content);
  const originalId = goatBrainIdFromRelativePath(input.path) ?? input.current.brainId;
  const folderPath = goatBrainFolderFromRelativePath(input.path) ?? input.current.folderPath;
  const conflictId = `${originalId}-conflict-${randomUUID().slice(0, 8)}`;
  const title = `${parsed.title || parsed.frontmatter.title || input.current.title || originalId} conflict`;
  const now = new Date().toISOString();
  const conflictContent = serializeGoatBrainDocument({
    ...parsed,
    title,
    frontmatter: {
      ...parsed.frontmatter,
      id: conflictId,
      folder: folderPath,
      type: parsed.frontmatter.type ?? input.current.entityType,
      title,
      status:
        parsed.frontmatter.status === "active" ? "draft" : (parsed.frontmatter.status ?? "draft"),
      createdAt: parsed.frontmatter.createdAt ?? now,
      relations: [
        ...(parsed.frontmatter.relations ?? []),
        { type: "conflicts_with", to: input.current.brainId },
      ],
      updatedAt: now,
    },
  });
  await upsertGoatBrainFileForUser(
    {
      userWorkosId: input.userWorkosId,
      path: goatBrainFilePathFor(folderPath, conflictId),
      content: conflictContent,
      taskId: input.taskId,
    },
    { db: input.db },
  );
}

export function goatBrainFilePathFor(folderPath: string, brainId: string): string {
  return goatBrainRelativePath(folderPath, brainId);
}

function documentValues(projection: GoatBrainFileProjection) {
  return {
    brainId: projection.brainId,
    folderPath: projection.folderPath,
    title: projection.title,
    content: projection.content,
    body: projection.body,
    timeline: projection.timeline,
    kind: projection.kind,
    mimeType: projection.mimeType,
    originalFileName: null,
    assetStorageKey: null,
    relations: projection.relations,
    sources: projection.sources,
    entityType: projection.entityType,
    evidenceKind: projection.evidenceKind ?? null,
    status: projection.status,
    aliases: projection.aliases,
    contentHash: projection.contentHash,
    sizeBytes: projection.sizeBytes,
  };
}

async function replaceDerivedRows(
  db: DbLike,
  userWorkosId: string,
  row: GoatBrainDocument,
  projection: GoatBrainFileProjection,
) {
  await ensureFolderPath(db, userWorkosId, projection.folderPath);
  const evidenceIds = projection.timeline.map((entry) => entry.evidenceId);
  if (evidenceIds.length > 0) {
    await db
      .delete(goatBrainTimelineEntries)
      .where(
        and(
          eq(goatBrainTimelineEntries.documentId, row.id),
          notInArray(goatBrainTimelineEntries.evidenceId, evidenceIds),
        ),
      );
  } else {
    await db
      .delete(goatBrainTimelineEntries)
      .where(eq(goatBrainTimelineEntries.documentId, row.id));
  }
  await db.delete(goatBrainEdges).where(eq(goatBrainEdges.documentId, row.id));

  for (const entry of projection.timeline) {
    const parts = timelineParts(entry);
    const values = {
      documentId: row.id,
      userWorkosId,
      brainId: row.brainId,
      evidenceId: entry.evidenceId,
      at: new Date(entry.at),
      sourceRef: parts.sourceRef,
      sourceTitle: parts.sourceTitle || null,
      summary: parts.summary,
      detail: parts.detail,
    };
    await db
      .insert(goatBrainTimelineEntries)
      .values(values)
      .onConflictDoUpdate({
        target: [goatBrainTimelineEntries.documentId, goatBrainTimelineEntries.evidenceId],
        set: {
          userWorkosId,
          brainId: row.brainId,
          at: values.at,
          sourceRef: values.sourceRef,
          sourceTitle: values.sourceTitle,
          summary: values.summary,
          detail: values.detail,
        },
      });
  }

  for (const edge of deriveGoatBrainEdges({
    id: row.brainId,
    relations: projection.relations,
    body: projection.body,
  })) {
    await db.insert(goatBrainEdges).values({
      id: `goat_brain_edge_${hashGoatBrainContent(
        `${row.id}:${edge.sourceKind}:${edge.type}:${edge.from}:${edge.to}`,
      ).slice(0, 32)}`,
      userWorkosId,
      documentId: row.id,
      fromBrainId: edge.from,
      toBrainId: edge.to,
      relationType: edge.type,
      sourceKind: edge.sourceKind,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
}

async function ensureFolderPath(db: DbLike, userWorkosId: string, folderPath: string) {
  const parts = folderPath.split("/").filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    const pathName = parts.slice(0, index + 1).join("/");
    await db
      .insert(goatBrainFolders)
      .values({
        id: `goat_brain_folder_${hashGoatBrainContent(`${userWorkosId}:${pathName}`).slice(0, 24)}`,
        userWorkosId,
        path: pathName,
        source: "system",
      })
      .onConflictDoNothing();
  }
}

async function insertVersion(
  db: DbLike,
  userWorkosId: string,
  row: GoatBrainDocument,
  operation: "overwrite" | "delete",
  taskId: string | null,
) {
  await db.insert(goatBrainDocumentVersions).values({
    userWorkosId,
    documentId: row.id,
    taskId,
    brainId: row.brainId,
    folderPath: row.folderPath,
    content: row.content,
    contentHash: row.contentHash,
    sizeBytes: row.sizeBytes,
    operation,
  });
}

async function findDocumentForUpsert(db: DbLike, userWorkosId: string, pathName: string) {
  const brainId = goatBrainIdFromRelativePath(pathName);
  if (!brainId) return null;
  const rows = await db
    .select()
    .from(goatBrainDocuments)
    .where(
      and(
        eq(goatBrainDocuments.userWorkosId, userWorkosId),
        eq(goatBrainDocuments.brainId, brainId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function getDocumentById(db: DbLike, userWorkosId: string, id: string) {
  const rows = await db
    .select()
    .from(goatBrainDocuments)
    .where(and(eq(goatBrainDocuments.userWorkosId, userWorkosId), eq(goatBrainDocuments.id, id)))
    .limit(1);
  return rows[0] ?? null;
}

function normalizeBrainFilePath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized.endsWith(".md") || !isSafeGoatBrainRelativePath(normalized)) {
    throw new Error(`Invalid brain file path "${value}".`);
  }
  const brainId = goatBrainIdFromRelativePath(normalized);
  const folder = goatBrainFolderFromRelativePath(normalized);
  if (!brainId || !folder) throw new Error(`Invalid brain file path "${value}".`);
  return goatBrainFilePathFor(normalizeGoatBrainFolderForV1(folder), brainId);
}

async function walkMarkdown(root: string, relDir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(path.join(root, relDir), { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.name === "goat-brain.mjs") continue;
    const childRel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") && entry.name !== ".brain") continue;
      if (entry.name === ".brain") continue;
      found.push(...(await walkMarkdown(root, childRel)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      found.push(childRel.split(path.sep).join("/"));
    }
  }
  return found;
}

async function sourceFromRootFile(root: string, relativePath: string): Promise<string | null> {
  const payload = await readFile(path.join(root, relativePath), "utf8");
  const id = goatBrainIdFromRelativePath(relativePath);
  const folder = goatBrainFolderFromRelativePath(relativePath);
  if (!id || !folder) return payload;
  let sidecarSource: string;
  try {
    sidecarSource = await readFile(
      path.join(root, goatBrainSidecarRelativePath(folder, id)),
      "utf8",
    );
  } catch (error) {
    if (isNotFound(error)) return payload;
    throw error;
  }
  try {
    const sidecar = parseGoatBrainSidecar(sidecarSource);
    const validation = validateGoatBrainSidecar({
      sidecar,
      payloadContent: payload,
      payloadRelativePath: relativePath,
    });
    if (validation.ok) return serializeLegacyGoatBrainEntry(validation.entry);
    if (isLegacyGoatBrainMarkdown(payload)) return payload;
    return recoverLegacyGoatBrainEntryFromSidecar({
      sidecar,
      payloadContent: payload,
      payloadRelativePath: relativePath,
    });
  } catch {
    if (isLegacyGoatBrainMarkdown(payload)) return payload;
    return null;
  }
}

function sourceFromSidecarOrPayloadSync(_relativePath: string, content: string) {
  return content;
}

function isLegacyGoatBrainMarkdown(value: string) {
  return (
    value.startsWith("---\n") &&
    value.includes("\n---") &&
    value.includes("## Compiled truth") &&
    value.includes("## Timeline")
  );
}

async function writeRootFile(root: string, relativePath: string, content: string) {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

function timelineParts(entry: GoatBrainTimelineEntry) {
  const chunks = entry.body
    .split(/\n\s*\n/g)
    .map((chunk: string) => chunk.trim())
    .filter(Boolean);
  let sourceRef = "";
  let sourceTitle = "";
  const last = chunks.at(-1) ?? "";
  if (last.startsWith("Source:")) {
    chunks.pop();
    const value = last.slice("Source:".length).trim();
    const titled = /^(.*?)\s+\((.*)\)$/.exec(value);
    if (titled?.[1] && titled[2]) {
      sourceTitle = titled[1].trim();
      sourceRef = titled[2].trim();
    } else {
      sourceRef = value;
    }
  }
  return {
    summary: chunks.shift() ?? "",
    detail: chunks.join("\n\n"),
    sourceRef,
    sourceTitle,
  };
}

function isNotFound(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && (error as { code?: string }).code === "ENOENT",
  );
}

function titleFromId(id: string): string {
  return id
    .split("-")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

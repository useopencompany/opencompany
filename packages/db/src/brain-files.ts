import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, isNull, like, notInArray, or } from "drizzle-orm";
import { NeonHttpDatabase } from "drizzle-orm/neon-http";
import {
  appendBrainAssetTextBlock,
  BRAIN_FOLDER_MANIFEST_PATH,
  type BrainDocumentFormat,
  type BrainEntityType,
  type BrainFolderManifestEntry,
  type BrainKind,
  type BrainRelation,
  type BrainSource,
  type BrainStatus,
  type BrainTimelineEntry,
  brainEntryFromLegacyMarkdown,
  brainFolderFromRelativePath,
  brainFolderSourceForPath,
  brainIdFromRelativePath,
  brainKindForFolder,
  brainRelativePath,
  brainSidecarRelativePath,
  defaultBrainFolderManifestEntries,
  deriveBrainEdges,
  isBuiltInBrainEntityType,
  isHardDefaultBrainFolder,
  isSafeBrainRelativePath,
  isValidBrainFolder,
  isValidBrainId,
  isValidBrainKind,
  isValidBrainStatus,
  normalizeBrainCompiledTruth,
  normalizeBrainFolder,
  normalizeBrainFolderEntries,
  normalizeBrainFolderForV1,
  type BrainDocument as ParsedBrainDocument,
  parseBrainDocument,
  parseBrainFolderManifest,
  parseBrainSidecar,
  recoverLegacyBrainEntryFromSidecar,
  replaceBrainCompiledTruth,
  serializeBrainDocument,
  serializeBrainFolderManifest,
  serializeBrainPayload,
  serializeBrainSidecar,
  serializeLegacyBrainEntry,
  stripBrainAssetTextBlock,
  validateBrainDocument,
  validateBrainSidecar,
} from "../../brain/src/index";
import { getDb } from "./client";
import {
  type BrainDocument,
  type BrainFolder,
  brainDocuments,
  brainDocumentVersions,
  brainEdges,
  brainFolders,
  brainTimelineEntries,
} from "./product-schema";

export const BRAIN_FILE_MIME_TYPE = "text/markdown";
export const BRAIN_FILE_FORMAT = "markdown";
export const MAX_BRAIN_FILE_BYTES = 1_000_000;
// Cap on stored machine-extracted asset text for file-backed rows.
export const MAX_BRAIN_ASSET_TEXT_BYTES = 200_000;

export type BrainFileProjection = {
  path: string;
  brainId: string;
  folderPath: string;
  format: typeof BRAIN_FILE_FORMAT;
  mimeType: typeof BRAIN_FILE_MIME_TYPE;
  content: string;
  body: string;
  timeline: BrainTimelineEntry[];
  contentHash: string;
  sizeBytes: number;
  title: string;
  description?: string;
  kind: BrainKind;
  entityType: BrainEntityType;
  status: BrainStatus;
  relations: BrainRelation[];
  sources: BrainSource[];
  aliases: string[];
};

export type BrainStoredFrontmatter = {
  id?: string;
  kind?: string;
  type?: string;
  status?: string;
  title?: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
  aliases?: string[];
  related?: BrainRelation[];
  sources?: BrainSource[];
  mergedInto?: string;
  folder?: string;
};

export type MaterializedBrainFile = {
  id: string;
  brainId: string;
  path: string;
  folderPath: string;
  contentHash: string;
  // Present on snapshots produced by current materialization. Binary bytes are
  // part of the concurrency token even though they are not in the projection.
  assetContentHash?: string | null;
  // Hash of the bytes actually written to disk when they differ from the
  // row's contentHash (binary-backed rows materialize content plus a
  // generated extracted-text block). Sync uses it to detect unchanged files;
  // conflict detection keeps comparing DB rows via contentHash.
  materializedHash?: string;
};

export type BrainSyncFile = {
  path: string;
  content: string;
  skip?: boolean;
};

export type BrainSyncConflict = {
  path: string;
  reason: "changed_since_materialize" | "created_since_materialize";
};

export type BrainSyncPageAction = "created" | "updated" | "conflict_created";

export type BrainSyncPage = {
  brainId: string;
  folderPath: string;
  title: string;
  action: BrainSyncPageAction;
};

export type BrainSyncResult = {
  upserted: number;
  deleted: number;
  conflicts: BrainSyncConflict[];
  pages: BrainSyncPage[];
};

type DbClient = any;
type DbLike = any;

// The default web-app client (`./client`) is neon-http, which has no interactive
// transactions (one HTTPS request per query). Run the mutation steps sequentially
// there; pooled callers (`./pool`, the runner) keep a real transaction.
function runAtomically<T>(db: DbClient, fn: (tx: DbLike) => Promise<T>): Promise<T> {
  if (db instanceof NeonHttpDatabase) return fn(db);
  if (typeof db.transaction !== "function") return fn(db);
  return db.transaction(fn);
}

export function hashBrainContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function createBrainMarkdownContent(input: {
  id: string;
  folderPath: string;
  title: string;
  description?: string;
  type: BrainEntityType;
  status?: BrainStatus;
  compiledTruth?: string;
  related?: BrainRelation[];
  sources?: BrainSource[];
  aliases?: string[];
  timeline?: BrainTimelineEntry[];
  createdAt?: string;
  updatedAt?: string;
}): string {
  const now = new Date().toISOString();
  const folder = input.folderPath;
  const doc: ParsedBrainDocument = {
    frontmatter: {
      id: input.id,
      folder,
      // Kind is derived from the folder: the evidence/ zone marks evidence docs.
      kind: brainKindForFolder(folder),
      type: input.type,
      status: input.status ?? "draft",
      title: input.title,
      ...(input.description ? { description: input.description } : {}),
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
  return serializeBrainDocument(doc);
}

export function replaceBrainFileCompiledTruth(input: {
  content: string;
  compiledTruth: string;
  updatedAt?: string;
}): string {
  return replaceBrainCompiledTruth(input.content, input.compiledTruth, {
    ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
  });
}

export function deriveBrainFileProjection(input: {
  path: string;
  content: string;
}): BrainFileProjection {
  const normalizedPath = normalizeBrainFilePath(input.path);
  // The generated extracted-text block on binary-backed projections is never
  // authoritative: strip it before parsing so it can neither leak into the
  // content column nor let edits inside it flow back.
  const source = stripBrainAssetTextBlock(
    sourceFromSidecarOrPayloadSync(normalizedPath, input.content),
  );

  const pathBrainId = brainIdFromRelativePath(normalizedPath);
  const pathFolder = brainFolderFromRelativePath(normalizedPath);
  if (!pathBrainId || !pathFolder) {
    throw new Error(`Brain file path "${normalizedPath}" must be a safe markdown path.`);
  }

  const parsed = parseBrainDocument(source);
  const brainId =
    parsed.frontmatter.id && isValidBrainId(parsed.frontmatter.id)
      ? parsed.frontmatter.id
      : pathBrainId;
  const rawFolderPath =
    parsed.frontmatter.folder && isValidBrainFolder(parsed.frontmatter.folder)
      ? parsed.frontmatter.folder
      : pathFolder;
  const folderPath = normalizeBrainFolderForV1(rawFolderPath);
  if (brainId !== pathBrainId) {
    throw new Error(`frontmatter.id "${brainId}" does not match path id "${pathBrainId}".`);
  }
  if (folderPath !== pathFolder) {
    throw new Error(
      `frontmatter.folder "${rawFolderPath}" does not match path folder "${pathFolder}".`,
    );
  }
  const entityType =
    parsed.frontmatter.type && isBuiltInBrainEntityType(parsed.frontmatter.type)
      ? parsed.frontmatter.type
      : null;
  const kind = isValidBrainKind(parsed.frontmatter.kind) ? parsed.frontmatter.kind : null;
  const status = isValidBrainStatus(parsed.frontmatter.status)
    ? parsed.frontmatter.status
    : "draft";
  const title = parsed.title || parsed.frontmatter.title || titleFromId(brainId);
  const validation = validateBrainDocument(parsed, brainId, source);
  if (!validation.ok) throw new Error(validation.errors.join("\n"));
  if (!entityType) throw new Error("frontmatter.type must be a built-in brain entity type.");
  if (!kind) throw new Error('frontmatter.kind must be "page" or "evidence".');
  const body = normalizeBrainCompiledTruth(parsed.compiledTruth, title);
  const content = canonicalBrainContent({
    parsed,
    brainId,
    folderPath,
    title,
    kind,
    entityType,
    status,
    body,
    source,
  });
  const sizeBytes = Buffer.byteLength(content, "utf8");
  if (sizeBytes > MAX_BRAIN_FILE_BYTES) {
    throw new Error(`Brain file "${normalizedPath}" exceeds ${MAX_BRAIN_FILE_BYTES} bytes.`);
  }

  return {
    path: normalizedPath,
    brainId,
    folderPath,
    format: BRAIN_FILE_FORMAT,
    mimeType: BRAIN_FILE_MIME_TYPE,
    content,
    body,
    timeline: parsed.timeline,
    contentHash: hashBrainContent(content),
    sizeBytes,
    title,
    ...(parsed.frontmatter.description ? { description: parsed.frontmatter.description } : {}),
    kind,
    entityType,
    status,
    relations: parsed.frontmatter.relations ?? [],
    sources: parsed.frontmatter.sources ?? [],
    aliases: parsed.frontmatter.aliases ?? [],
  };
}

function canonicalBrainContent(input: {
  parsed: ReturnType<typeof parseBrainDocument>;
  brainId: string;
  folderPath: string;
  title: string;
  kind: BrainKind;
  entityType: BrainEntityType;
  status: BrainStatus;
  body: string;
  source: string;
}): string {
  const fm = input.parsed.frontmatter;
  if (
    fm.id === input.brainId &&
    fm.folder === input.folderPath &&
    fm.kind === input.kind &&
    fm.type === input.entityType &&
    fm.status === input.status &&
    fm.title === input.title &&
    input.parsed.compiledTruth === input.body
  ) {
    return input.source;
  }
  return serializeBrainDocument({
    title: input.title,
    compiledTruth: input.body,
    timeline: input.parsed.timeline,
    frontmatter: {
      id: input.brainId,
      folder: input.folderPath,
      kind: input.kind,
      type: input.entityType,
      status: input.status,
      title: input.title,
      createdAt: fm.createdAt ?? new Date().toISOString(),
      updatedAt: fm.updatedAt ?? new Date().toISOString(),
      relations: fm.relations ?? [],
      ...(fm.aliases ? { aliases: fm.aliases } : {}),
      ...(fm.description ? { description: fm.description } : {}),
      ...(fm.sources ? { sources: fm.sources } : {}),
      ...(fm.mergedInto ? { mergedInto: fm.mergedInto } : {}),
    },
  });
}

// Identity contract for all brain file mutations: `brainRef` (the brain the
// row belongs to) scopes every query; `userWorkosId` only attributes writes.
// Access control happens upstream (requireBrainAccess) before these run.
export type BrainScope = {
  brainRef: string;
  userWorkosId: string;
};

export async function listBrainFiles(
  input: { brainRef: string },
  options: { db?: DbClient; includeInvalid?: boolean } = {},
): Promise<BrainDocument[]> {
  const db = options.db ?? getDb();
  return db
    .select()
    .from(brainDocuments)
    .where(eq(brainDocuments.brainRef, input.brainRef))
    .orderBy(desc(brainDocuments.updatedAt));
}

export async function listBrainFolderRows(
  input: { brainRef: string },
  options: { db?: DbClient } = {},
): Promise<BrainFolder[]> {
  const db = options.db ?? getDb();
  const rows = await db
    .select()
    .from(brainFolders)
    .where(eq(brainFolders.brainRef, input.brainRef));
  return normalizeStoredFolderRows(Array.isArray(rows) ? rows : []).toSorted((a, b) =>
    a.path.localeCompare(b.path),
  );
}

export async function seedDefaultBrainFolders(
  input: BrainScope,
  options: { db?: DbClient } = {},
): Promise<void> {
  const db = options.db ?? getDb();
  await upsertFolderRows(db, input, defaultBrainFolderManifestEntries());
}

export async function createBrainFolderRow(
  input: BrainScope & { path: string },
  options: { db?: DbClient } = {},
): Promise<BrainFolder> {
  const db = options.db ?? getDb();
  const folderPath = normalizeBrainFolderForV1(input.path);
  if (!isValidBrainFolder(folderPath)) throw new Error("Folder path must be safe.");
  if (isHardDefaultBrainFolder(folderPath)) {
    throw new Error(`Folder "${folderPath}" is required and already exists.`);
  }
  const rows = await db
    .insert(brainFolders)
    .values(folderRowValues(input, folderPath, brainFolderSourceForPath(folderPath)))
    .onConflictDoUpdate({
      target: [brainFolders.brainRef, brainFolders.path],
      set: {
        userWorkosId: input.userWorkosId,
        source: brainFolderSourceForPath(folderPath),
        updatedAt: new Date(),
      },
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error("Failed to create opencompany Brain folder.");
  return row;
}

export async function deleteBrainFolderRow(
  input: BrainScope & { path: string },
  options: { db?: DbClient } = {},
): Promise<void> {
  const db = options.db ?? getDb();
  const folderPath = normalizeBrainFolderForV1(input.path);
  if (!isValidBrainFolder(folderPath)) throw new Error("Folder path must be safe.");
  if (isHardDefaultBrainFolder(folderPath)) {
    throw new Error(`Folder "${folderPath}" is required and cannot be removed.`);
  }
  const [docs, childFolders] = await Promise.all([
    documentsUnderFolder(db, input.brainRef, folderPath),
    foldersUnderFolder(db, input.brainRef, folderPath, { includeSelf: false }),
  ]);
  if (docs.length > 0 || childFolders.length > 0) {
    throw new Error(`Folder "${folderPath}" is not empty.`);
  }
  await db
    .delete(brainFolders)
    .where(and(eq(brainFolders.brainRef, input.brainRef), eq(brainFolders.path, folderPath)));
}

export async function renameBrainFolderRow(
  input: BrainScope & { fromPath: string; toPath: string },
  options: { db?: DbClient } = {},
): Promise<{ movedDocuments: number; movedFolders: number }> {
  const db = options.db ?? getDb();
  return runAtomically(db, async (tx: DbLike) => {
    const fromPath = normalizeBrainFolderForV1(input.fromPath);
    const toPath = normalizeBrainFolderForV1(input.toPath);
    if (!isValidBrainFolder(fromPath) || !isValidBrainFolder(toPath)) {
      throw new Error("Folder paths must be safe.");
    }
    if (fromPath === toPath) return { movedDocuments: 0, movedFolders: 0 };
    if (isHardDefaultBrainFolder(fromPath) || isHardDefaultBrainFolder(toPath)) {
      throw new Error("Required folders cannot be renamed.");
    }
    if (toPath.startsWith(`${fromPath}/`)) {
      throw new Error("Cannot rename a folder into one of its own children.");
    }
    if (brainKindForFolder(fromPath) !== brainKindForFolder(toPath)) {
      throw new Error("Cannot rename folders across the evidence boundary.");
    }
    const [targetDocs, targetFolders, sourceDocs, sourceFolders] = await Promise.all([
      documentsUnderFolder(tx, input.brainRef, toPath),
      foldersUnderFolder(tx, input.brainRef, toPath, { includeSelf: true }),
      documentsUnderFolder(tx, input.brainRef, fromPath),
      foldersUnderFolder(tx, input.brainRef, fromPath, { includeSelf: true }),
    ]);
    if (targetDocs.length > 0 || targetFolders.length > 0) {
      throw new Error(`Folder "${toPath}" already exists.`);
    }
    if (sourceDocs.length === 0 && sourceFolders.length === 0) {
      throw new Error(`Folder "${fromPath}" does not exist.`);
    }

    let movedDocuments = 0;
    for (const row of sourceDocs) {
      const nextFolder = replaceFolderPrefix(row.folderPath, fromPath, toPath);
      const parsed = parseBrainDocument(row.content);
      const content = serializeBrainDocument({
        title: parsed.title || row.title || row.brainId,
        compiledTruth: parsed.compiledTruth,
        timeline: parsed.timeline,
        frontmatter: {
          id: row.brainId,
          folder: nextFolder,
          kind: row.kind,
          type: row.entityType,
          status: parsed.frontmatter.status ?? row.status,
          title: parsed.frontmatter.title ?? row.title ?? row.brainId,
          createdAt: parsed.frontmatter.createdAt ?? row.createdAt.toISOString(),
          updatedAt: new Date().toISOString(),
          relations: parsed.frontmatter.relations ?? [],
          ...(parsed.frontmatter.aliases ? { aliases: parsed.frontmatter.aliases } : {}),
          ...(parsed.frontmatter.description
            ? { description: parsed.frontmatter.description }
            : {}),
          ...(parsed.frontmatter.sources ? { sources: parsed.frontmatter.sources } : {}),
          ...(parsed.frontmatter.mergedInto ? { mergedInto: parsed.frontmatter.mergedInto } : {}),
        },
      });
      await moveBrainFile(
        {
          brainRef: input.brainRef,
          userWorkosId: input.userWorkosId,
          fileId: row.id,
          path: brainFilePathFor(nextFolder, row.brainId),
          content,
        },
        { db: tx },
      );
      movedDocuments += 1;
    }

    const renamedFolders = sourceFolders.map((folder) => ({
      ...folder,
      path: replaceFolderPrefix(folder.path, fromPath, toPath),
      source: brainFolderSourceForPath(replaceFolderPrefix(folder.path, fromPath, toPath)),
    }));
    await upsertFolderRows(tx, input, renamedFolders);
    await deleteFolderRows(
      tx,
      input.brainRef,
      sourceFolders.map((folder) => folder.path),
    );
    return { movedDocuments, movedFolders: renamedFolders.length };
  });
}

export async function getBrainFile(
  input: { brainRef: string; fileId: string },
  options: { db?: DbClient } = {},
): Promise<BrainDocument | null> {
  const db = options.db ?? getDb();
  const rows = await db
    .select()
    .from(brainDocuments)
    .where(and(eq(brainDocuments.brainRef, input.brainRef), eq(brainDocuments.id, input.fileId)))
    .limit(1);
  return rows[0] ?? null;
}

// Internal locator lookup for authorization gateways that receive only the opaque document id.
// Callers must authorize the returned brainRef before exposing metadata or bytes.
export async function getBrainFileById(
  input: { fileId: string },
  options: { db?: DbClient } = {},
): Promise<BrainDocument | null> {
  const db = options.db ?? getDb();
  const rows = await db
    .select()
    .from(brainDocuments)
    .where(eq(brainDocuments.id, input.fileId))
    .limit(1);
  return rows[0] ?? null;
}

export async function upsertBrainFile(
  input: BrainScope & {
    path: string;
    content: string;
    id?: string;
    taskId?: string | null;
    importRunId?: string | null;
    // Recorded only when the row is created; conflicting upserts never touch
    // it. Defaults to the acting user; pass null when no human originated the
    // content (e.g. externally authored source ingestion).
    createdByWorkosId?: string | null;
  },
  options: { db?: DbClient } = {},
): Promise<BrainDocument> {
  const db = options.db ?? getDb();
  return runAtomically(db, async (tx: DbLike) => {
    const projection = deriveBrainFileProjection({
      path: input.path,
      content: input.content,
    });
    const now = new Date();
    const existing = await findDocumentForUpsert(tx, input.brainRef, projection.path);
    const documentId = existing?.id ?? input.id ?? `goat_brain_doc_${randomUUID()}`;
    if (existing && existing.contentHash !== projection.contentHash) {
      await insertVersion(
        tx,
        input.userWorkosId,
        existing,
        "overwrite",
        input.taskId ?? null,
        input.importRunId ?? null,
      );
    }

    const rows = await tx
      .insert(brainDocuments)
      .values({
        id: documentId,
        userWorkosId: input.userWorkosId,
        createdByWorkosId:
          input.createdByWorkosId === undefined ? input.userWorkosId : input.createdByWorkosId,
        brainRef: input.brainRef,
        ...documentValues(projection),
        format: BRAIN_FILE_FORMAT,
        mimeType: BRAIN_FILE_MIME_TYPE,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [brainDocuments.brainRef, brainDocuments.brainId],
        set: {
          ...documentValues(projection),
          userWorkosId: input.userWorkosId,
          updatedAt: now,
        },
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to upsert opencompany brain document.");
    await replaceDerivedRows(tx, input.userWorkosId, row, projection);
    return row;
  });
}

// Insert-only companion to upsertBrainFile for interactive file creation.
// A null result means another writer claimed the same brain id first; callers
// can safely allocate the next display name without overwriting that document.
export async function createBrainMarkdownDocument(
  input: BrainScope & {
    path: string;
    content: string;
    id?: string;
  },
  options: { db?: DbClient } = {},
): Promise<BrainDocument | null> {
  const db = options.db ?? getDb();
  const projection = deriveBrainFileProjection({ path: input.path, content: input.content });
  const edges = deriveBrainEdges({
    id: projection.brainId,
    relations: projection.relations,
    body: [projection.body, ...projection.timeline.map((entry) => entry.body)].join("\n\n"),
  });
  if (projection.timeline.length > 0 || edges.length > 0) {
    throw new Error(
      "Interactive brain file creation only supports documents without derived rows.",
    );
  }

  // Folder creation happens before the document insert, so the insert remains
  // the only post-validation write that can fail. Its unique conflict handling
  // is one atomic database statement even on the web app's neon-http client.
  await ensureFolderPath(db, input, projection.folderPath);
  const now = new Date();
  const rows = await db
    .insert(brainDocuments)
    .values({
      id: input.id ?? `goat_brain_doc_${randomUUID()}`,
      userWorkosId: input.userWorkosId,
      createdByWorkosId: input.userWorkosId,
      brainRef: input.brainRef,
      ...documentValues(projection),
      format: BRAIN_FILE_FORMAT,
      mimeType: BRAIN_FILE_MIME_TYPE,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({
      target: [brainDocuments.brainRef, brainDocuments.brainId],
    })
    .returning();
  return rows[0] ?? null;
}

export async function updateBrainFileContent(
  input: BrainScope & {
    fileId: string;
    content: string;
    expectedContentHash?: string;
  },
  options: { db?: DbClient } = {},
): Promise<BrainDocument> {
  const db = options.db ?? getDb();
  return runAtomically(db, async (tx: DbLike) => {
    const existing = await getDocumentById(tx, input.brainRef, input.fileId);
    if (!existing) throw new Error("Brain document not found.");
    if (input.expectedContentHash && existing.contentHash !== input.expectedContentHash) {
      throw new Error("Brain document changed since it was loaded. Retry with the latest content.");
    }
    const projection = deriveBrainFileProjection({
      path: brainFilePathFor(existing.folderPath, existing.brainId),
      content: input.content,
    });
    if (existing.contentHash !== projection.contentHash) {
      await insertVersion(tx, input.userWorkosId, existing, "overwrite", null, null);
    }
    const rows = await tx
      .update(brainDocuments)
      .set({
        ...documentValues(projection),
        userWorkosId: input.userWorkosId,
        updatedAt: new Date(),
      })
      .where(and(eq(brainDocuments.brainRef, input.brainRef), eq(brainDocuments.id, input.fileId)))
      .returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to update opencompany brain document.");
    await replaceDerivedRows(tx, input.userWorkosId, row, projection);
    return row;
  });
}

export async function moveBrainFile(
  input: BrainScope & { fileId: string; path: string; content: string },
  options: { db?: DbClient } = {},
): Promise<BrainDocument> {
  const db = options.db ?? getDb();
  return runAtomically(db, async (tx: DbLike) => {
    const existing = await getDocumentById(tx, input.brainRef, input.fileId);
    if (!existing) throw new Error("Brain document not found.");
    const projection = deriveBrainFileProjection({
      path: input.path,
      content: input.content,
    });
    if (
      existing.contentHash !== projection.contentHash ||
      existing.folderPath !== projection.folderPath
    ) {
      await insertVersion(tx, input.userWorkosId, existing, "overwrite", null, null);
    }
    const rows = await tx
      .update(brainDocuments)
      .set({
        ...documentValues(projection),
        userWorkosId: input.userWorkosId,
        updatedAt: new Date(),
      })
      .where(and(eq(brainDocuments.brainRef, input.brainRef), eq(brainDocuments.id, input.fileId)))
      .returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to move opencompany brain document.");
    await replaceDerivedRows(tx, input.userWorkosId, row, projection);
    return row;
  });
}

export async function deleteBrainFile(
  input: BrainScope & {
    fileId: string;
    taskId?: string | null;
    importRunId?: string | null;
  },
  options: { db?: DbClient } = {},
): Promise<void> {
  const db = options.db ?? getDb();
  const deleted = await runAtomically(db, async (tx: DbLike) => {
    const existing = await getDocumentById(tx, input.brainRef, input.fileId);
    if (existing)
      await insertVersion(
        tx,
        input.userWorkosId,
        existing,
        "delete",
        input.taskId ?? null,
        input.importRunId ?? null,
      );
    await tx
      .delete(brainDocuments)
      .where(and(eq(brainDocuments.brainRef, input.brainRef), eq(brainDocuments.id, input.fileId)));
    return existing as BrainDocument | null;
  });
  if (deleted?.assetStorageKey) await deleteBrainAssetBlob(deleted.assetStorageKey);
}

// Best-effort blob cleanup after the row is gone. Version rows keep the
// markdown projection, not the bytes, so a deleted asset's page can be
// restored but its file cannot.
async function deleteBrainAssetBlob(storageKey: string): Promise<void> {
  try {
    const { del } = await import("@vercel/blob");
    await del(storageKey);
  } catch (error) {
    console.warn(`Failed to delete opencompany brain asset blob "${storageKey}":`, error);
  }
}

// Creates the brain document for an uploaded binary file. The row's content
// column holds the normal markdown projection (frontmatter + compiled truth +
// timeline); the bytes live in blob storage behind assetStorageKey. The
// caller is responsible for choosing an unused brainId and for enqueuing the
// ingestion job that extracts text and curates the page.
export async function createBrainAssetDocument(
  input: BrainScope & {
    id?: string;
    brainId: string;
    folderPath: string;
    title: string;
    entityType?: BrainEntityType;
    format: Exclude<BrainDocumentFormat, "markdown">;
    mimeType: string;
    originalFileName: string;
    assetStorageKey: string;
    assetSizeBytes: number;
    assetContentHash?: string | null;
    sourceRef: string;
  },
  options: { db?: DbClient } = {},
): Promise<BrainDocument> {
  const db = options.db ?? getDb();
  const now = new Date();
  const content = createBrainMarkdownContent({
    id: input.brainId,
    folderPath: input.folderPath,
    title: input.title,
    type: input.entityType ?? "source",
    status: "draft",
    compiledTruth: `Uploaded file \`${input.originalFileName}\`. Ingestion pending.`,
    sources: [
      {
        ref: input.sourceRef,
        title: input.originalFileName,
        capturedAt: now.toISOString(),
      },
    ],
  });
  const projection = deriveBrainFileProjection({
    path: brainFilePathFor(input.folderPath, input.brainId),
    content,
  });
  return runAtomically(db, async (tx: DbLike) => {
    const rows = await tx
      .insert(brainDocuments)
      .values({
        id: input.id ?? `goat_brain_doc_${randomUUID()}`,
        userWorkosId: input.userWorkosId,
        createdByWorkosId: input.userWorkosId,
        brainRef: input.brainRef,
        ...documentValues(projection),
        format: input.format,
        mimeType: input.mimeType,
        originalFileName: input.originalFileName,
        assetStorageKey: input.assetStorageKey,
        assetSizeBytes: input.assetSizeBytes,
        assetContentHash: input.assetContentHash ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to create opencompany brain asset document.");
    await replaceDerivedRows(tx, input.userWorkosId, row, projection);
    return row;
  });
}

// Records the machine-extracted text of a binary asset (ingestion stage 1).
// Only asset columns move; the markdown projection is untouched, so no
// version row is written.
export async function updateBrainAssetExtraction(
  input: BrainScope & {
    fileId: string;
    extractedText: string;
    assetContentHash: string;
    assetSizeBytes: number;
    expectedAssetStorageKey: string;
  },
  options: { db?: DbClient } = {},
): Promise<BrainDocument | null> {
  const db = options.db ?? getDb();
  const extractedText = truncateUtf8(input.extractedText, MAX_BRAIN_ASSET_TEXT_BYTES);
  const rows = await db
    .update(brainDocuments)
    .set({
      assetExtractedText: extractedText || null,
      assetContentHash: input.assetContentHash,
      assetSizeBytes: input.assetSizeBytes,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(brainDocuments.brainRef, input.brainRef),
        eq(brainDocuments.id, input.fileId),
        eq(brainDocuments.assetStorageKey, input.expectedAssetStorageKey),
      ),
    )
    .returning();
  const row = rows[0];
  return row ?? null;
}

// Points an existing asset document at newly uploaded bytes (re-upload). The
// stale blob is removed best-effort and the extracted text is cleared until
// the next ingestion pass rebuilds it.
export async function replaceBrainAssetFile(
  input: BrainScope & {
    fileId: string;
    mimeType: string;
    originalFileName: string;
    assetStorageKey: string;
    assetSizeBytes: number;
    assetContentHash?: string | null;
    expectedAssetContentHash?: string | null;
    expectedAssetStorageKey?: string;
  },
  options: {
    db?: DbClient;
    cleanupReplacedBlob?: (storageKey: string) => Promise<void>;
  } = {},
): Promise<BrainDocument> {
  const db = options.db ?? getDb();
  const existing = await getDocumentById(db, input.brainRef, input.fileId);
  if (!existing) throw new Error("Brain document not found.");
  if (existing.format === BRAIN_FILE_FORMAT) {
    throw new Error("Only binary-backed brain documents can have their file replaced.");
  }
  const rows = await db
    .update(brainDocuments)
    .set({
      mimeType: input.mimeType,
      originalFileName: input.originalFileName,
      assetStorageKey: input.assetStorageKey,
      assetSizeBytes: input.assetSizeBytes,
      assetContentHash: input.assetContentHash ?? null,
      assetExtractedText: null,
      userWorkosId: input.userWorkosId,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(brainDocuments.brainRef, input.brainRef),
        eq(brainDocuments.id, input.fileId),
        ...(input.expectedAssetContentHash === undefined
          ? []
          : [
              input.expectedAssetContentHash === null
                ? isNull(brainDocuments.assetContentHash)
                : eq(brainDocuments.assetContentHash, input.expectedAssetContentHash),
            ]),
        ...(input.expectedAssetStorageKey
          ? [eq(brainDocuments.assetStorageKey, input.expectedAssetStorageKey)]
          : []),
      ),
    )
    .returning();
  const row = rows[0];
  if (!row) throw new Error("Brain asset changed before its file could be replaced.");
  if (existing.assetStorageKey && existing.assetStorageKey !== input.assetStorageKey) {
    await (options.cleanupReplacedBlob ?? deleteBrainAssetBlob)(existing.assetStorageKey);
  }
  return row;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  return Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8").replace(/�+$/, "");
}

export async function materializeBrainFilesToRoot(input: {
  brainRef: string;
  root: string;
  db?: DbClient;
  cliSource?: string;
}): Promise<MaterializedBrainFile[]> {
  await rm(input.root, { recursive: true, force: true });
  await mkdir(input.root, { recursive: true });
  const rows = await listBrainFiles(
    { brainRef: input.brainRef },
    {
      ...(input.db ? { db: input.db } : {}),
      includeInvalid: true,
    },
  );
  const folderRows = await listBrainFolderRows(
    { brainRef: input.brainRef },
    {
      ...(input.db ? { db: input.db } : {}),
    },
  );
  await writeRootFile(
    input.root,
    BRAIN_FOLDER_MANIFEST_PATH,
    serializeBrainFolderManifest(folderRows),
  );
  const materializedHashByPath = new Map<string, string>();
  for (const row of rows) {
    const payloadPath = brainFilePathFor(row.folderPath, row.brainId);
    if (row.format !== BRAIN_FILE_FORMAT) {
      // Binary-backed rows materialize as their markdown projection (the
      // content column) plus a generated, non-authoritative extracted-text
      // block; the bytes themselves stay in blob storage.
      const projected = appendBrainAssetTextBlock(row.content, row.assetExtractedText ?? "");
      await writeRootFile(input.root, payloadPath, projected);
      if (projected !== row.content) {
        materializedHashByPath.set(payloadPath, hashBrainContent(projected));
      }
      continue;
    }
    let entry: ReturnType<typeof brainEntryFromLegacyMarkdown> | null = null;
    try {
      entry = brainEntryFromLegacyMarkdown(row.content);
    } catch {}
    if (!entry) {
      await writeRootFile(input.root, payloadPath, row.content);
      continue;
    }

    const payload = serializeBrainPayload(entry);
    const sidecarPath = brainSidecarRelativePath(row.folderPath, row.brainId);
    await writeRootFile(input.root, payloadPath, payload);
    await writeRootFile(input.root, sidecarPath, serializeBrainSidecar(entry));
  }
  if (input.cliSource) {
    await writeFile(path.join(input.root, "opencompany-brain.mjs"), input.cliSource, "utf8");
  }
  return rows.map((row) => {
    const path = brainFilePathFor(row.folderPath, row.brainId);
    const materializedHash = materializedHashByPath.get(path);
    return {
      id: row.id,
      brainId: row.brainId,
      path,
      folderPath: row.folderPath,
      contentHash: row.contentHash,
      ...(row.assetContentHash !== undefined ? { assetContentHash: row.assetContentHash } : {}),
      ...(materializedHash ? { materializedHash } : {}),
    };
  });
}

export async function readBrainFilesFromRoot(root: string): Promise<BrainSyncFile[]> {
  const relativePaths = await walkMarkdown(root, "");
  const files: BrainSyncFile[] = [];
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

export async function readBrainFolderManifestFromRoot(
  root: string,
): Promise<BrainFolderManifestEntry[] | null> {
  try {
    const source = await readFile(path.join(root, BRAIN_FOLDER_MANIFEST_PATH), "utf8");
    return parseBrainFolderManifest(source);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export async function syncBrainFiles(input: {
  brainRef: string;
  userWorkosId: string;
  files: BrainSyncFile[];
  baseSnapshot: MaterializedBrainFile[];
  db?: DbClient;
  taskId?: string | null;
  importRunId?: string | null;
  folders?: BrainFolderManifestEntry[] | null;
  // Attribution for documents this sync *creates* (existing rows keep theirs).
  // Defaults to the acting user; pass null when no human originated the
  // content (e.g. externally authored source ingestion).
  createdByWorkosId?: string | null;
}): Promise<BrainSyncResult> {
  const db = input.db ?? getDb();
  const currentRows: BrainDocument[] = await db
    .select()
    .from(brainDocuments)
    .where(eq(brainDocuments.brainRef, input.brainRef));
  const currentByPath = new Map(
    currentRows.map((row: BrainDocument) => [brainFilePathFor(row.folderPath, row.brainId), row]),
  );
  const currentByBrainId = new Map(currentRows.map((row: BrainDocument) => [row.brainId, row]));
  const baseByPath = new Map(input.baseSnapshot.map((file) => [file.path, file]));
  const nextByPath = new Map<string, BrainSyncFile>();
  const skippedPaths = new Set<string>();
  for (const file of input.files) {
    const normalizedPath = normalizeBrainFilePath(file.path);
    if (nextByPath.has(normalizedPath))
      throw new Error(`Duplicate brain file path "${normalizedPath}".`);
    const base = baseByPath.get(normalizedPath);
    const unchangedFromBase =
      base !== undefined &&
      hashBrainContent(file.content) === (base.materializedHash ?? base.contentHash);
    const skip = Boolean(file.skip || unchangedFromBase);
    if (skip) {
      skippedPaths.add(normalizedPath);
    } else {
      deriveBrainFileProjection({
        path: normalizedPath,
        content: file.content,
      });
    }
    nextByPath.set(normalizedPath, {
      path: normalizedPath,
      content: file.content,
      ...(skip ? { skip: true } : {}),
    });
  }

  const conflicts: BrainSyncConflict[] = [];
  const handledConflictPaths = new Set<string>();
  for (const [pathName, next] of nextByPath) {
    // Files the agent left untouched are never written by this sync, so a
    // concurrent change to their stored row is not a write conflict — the
    // newer stored version simply stays. Only files this sync would actually
    // write (modified) or remove (handled below) can conflict.
    if (next.skip) continue;
    const current = currentByPath.get(pathName);
    const base = baseByPath.get(pathName);
    if (current && base && changedSinceMaterialize(current, base)) {
      conflicts.push({ path: pathName, reason: "changed_since_materialize" });
      handledConflictPaths.add(pathName);
    }
    if (current && !base) {
      conflicts.push({ path: pathName, reason: "created_since_materialize" });
      handledConflictPaths.add(pathName);
    }
  }
  for (const [pathName] of baseByPath) {
    if (nextByPath.has(pathName)) continue;
    const current = currentByPath.get(pathName);
    const base = baseByPath.get(pathName);
    if (current && base && changedSinceMaterialize(current, base)) {
      conflicts.push({ path: pathName, reason: "changed_since_materialize" });
    }
  }
  const unhandledConflicts = conflicts.filter(
    (conflict) => !handledConflictPaths.has(conflict.path),
  );
  if (unhandledConflicts.length > 0)
    return {
      upserted: 0,
      deleted: 0,
      conflicts: unhandledConflicts,
      pages: [],
    };

  let upserted = 0;
  const pages: BrainSyncPage[] = [];
  for (const pathName of handledConflictPaths) {
    const file = nextByPath.get(pathName);
    const current = currentByPath.get(pathName);
    if (!file || file.skip || !current) continue;
    const row = await upsertConflictDocument({
      brainRef: input.brainRef,
      userWorkosId: input.userWorkosId,
      path: pathName,
      content: file.content,
      current,
      taskId: input.taskId ?? null,
      importRunId: input.importRunId ?? null,
      createdByWorkosId:
        input.createdByWorkosId === undefined ? input.userWorkosId : input.createdByWorkosId,
      db,
    });
    addSyncPage(pages, row, "conflict_created");
    upserted += 1;
  }

  for (const [pathName, file] of nextByPath) {
    if (file.skip || handledConflictPaths.has(pathName)) continue;
    const brainId = brainIdFromRelativePath(pathName);
    const existing =
      currentByPath.get(pathName) ?? (brainId ? currentByBrainId.get(brainId) : undefined);
    const row = await upsertBrainFile(
      {
        brainRef: input.brainRef,
        userWorkosId: input.userWorkosId,
        path: pathName,
        content: file.content,
        ...(existing?.id ? { id: existing.id } : {}),
        taskId: input.taskId ?? null,
        importRunId: input.importRunId ?? null,
        ...(input.createdByWorkosId !== undefined
          ? { createdByWorkosId: input.createdByWorkosId }
          : {}),
      },
      { db },
    );
    addSyncPage(pages, row, existing ? "updated" : "created");
    upserted += 1;
  }

  const nextBrainIds = new Set(
    [...nextByPath.keys()]
      .map((pathName) => brainIdFromRelativePath(pathName))
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
    await deleteBrainFile(
      {
        brainRef: input.brainRef,
        userWorkosId: input.userWorkosId,
        fileId: id,
        taskId: input.taskId ?? null,
        importRunId: input.importRunId ?? null,
      },
      { db },
    );
  }
  if (input.folders) {
    await syncBrainFolderRows({
      db,
      scope: { brainRef: input.brainRef, userWorkosId: input.userWorkosId },
      folders: input.folders,
    });
  }
  return { upserted, deleted: deleteIds.length, conflicts: [], pages };
}

function changedSinceMaterialize(current: BrainDocument, base: MaterializedBrainFile) {
  return (
    current.contentHash !== base.contentHash ||
    ("assetContentHash" in base && current.assetContentHash !== base.assetContentHash)
  );
}

export async function syncBrainFilesFromRoot(input: {
  brainRef: string;
  userWorkosId: string;
  root: string;
  baseSnapshot: MaterializedBrainFile[];
  db?: DbClient;
  taskId?: string | null;
  importRunId?: string | null;
  createdByWorkosId?: string | null;
}): Promise<BrainSyncResult> {
  const files = await readBrainFilesFromRoot(input.root);
  const folders = await readBrainFolderManifestFromRoot(input.root);
  return syncBrainFiles({
    brainRef: input.brainRef,
    userWorkosId: input.userWorkosId,
    files,
    baseSnapshot: input.baseSnapshot,
    ...(input.db ? { db: input.db } : {}),
    taskId: input.taskId ?? null,
    importRunId: input.importRunId ?? null,
    folders,
    ...(input.createdByWorkosId !== undefined
      ? { createdByWorkosId: input.createdByWorkosId }
      : {}),
  });
}

async function upsertConflictDocument(input: {
  brainRef: string;
  userWorkosId: string;
  path: string;
  content: string;
  current: BrainDocument;
  taskId: string | null;
  importRunId: string | null;
  createdByWorkosId: string | null;
  db: DbClient;
}): Promise<BrainDocument> {
  const parsed = parseBrainDocument(input.content);
  const originalId = brainIdFromRelativePath(input.path) ?? input.current.brainId;
  const folderPath = brainFolderFromRelativePath(input.path) ?? input.current.folderPath;
  const conflictId = `${originalId}-conflict-${randomUUID().slice(0, 8)}`;
  const title = `${parsed.title || parsed.frontmatter.title || input.current.title || originalId} conflict`;
  const now = new Date().toISOString();
  const conflictContent = serializeBrainDocument({
    ...parsed,
    title,
    frontmatter: {
      ...parsed.frontmatter,
      id: conflictId,
      folder: folderPath,
      kind: parsed.frontmatter.kind ?? brainKindForFolder(folderPath),
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
  return upsertBrainFile(
    {
      brainRef: input.brainRef,
      userWorkosId: input.userWorkosId,
      path: brainFilePathFor(folderPath, conflictId),
      content: conflictContent,
      taskId: input.taskId,
      importRunId: input.importRunId,
      createdByWorkosId: input.createdByWorkosId,
    },
    { db: input.db },
  );
}

function addSyncPage(pages: BrainSyncPage[], row: BrainDocument, action: BrainSyncPageAction) {
  if (row.kind !== "page") return;
  pages.push({
    brainId: row.brainId,
    folderPath: row.folderPath,
    title: row.title || row.brainId,
    action,
  });
}

export function brainFilePathFor(folderPath: string, brainId: string): string {
  return brainRelativePath(folderPath, brainId);
}

// Markdown-plane fields only. format/mimeType and the asset columns are
// deliberately absent so file-plane syncs can never clobber a binary-backed
// row's asset identity; new rows get their format at insert time.
function documentValues(projection: BrainFileProjection) {
  return {
    brainId: projection.brainId,
    folderPath: projection.folderPath,
    title: projection.title,
    content: projection.content,
    body: projection.body,
    timeline: projection.timeline,
    relations: projection.relations,
    sources: projection.sources,
    kind: projection.kind,
    entityType: projection.entityType,
    status: projection.status,
    aliases: projection.aliases,
    contentHash: projection.contentHash,
    sizeBytes: projection.sizeBytes,
    searchText: brainSearchText(projection),
    nameText: brainNameText(projection),
  };
}

// Retrieval projections consumed by brain-read.ts: `search_text` feeds the generated FTS
// tsvector, `name_text` feeds trigram entity lookup. Migration 0102 backfills the same
// composition in SQL for pre-existing rows.
function brainSearchText(projection: BrainFileProjection): string {
  return [
    projection.title,
    projection.aliases.join(" "),
    projection.body,
    projection.timeline.map((entry) => entry.body).join("\n"),
    projection.relations.map((relation) => `${relation.type} ${relation.to}`).join("\n"),
  ]
    .filter(Boolean)
    .join("\n");
}

function brainNameText(projection: BrainFileProjection): string {
  return [projection.title, ...projection.aliases].filter(Boolean).join(" ").trim();
}

async function replaceDerivedRows(
  db: DbLike,
  userWorkosId: string,
  row: BrainDocument,
  projection: BrainFileProjection,
) {
  await ensureFolderPath(db, { brainRef: row.brainRef, userWorkosId }, projection.folderPath);
  const evidenceIds = projection.timeline.map((entry) => entry.evidenceId);
  if (evidenceIds.length > 0) {
    await db
      .delete(brainTimelineEntries)
      .where(
        and(
          eq(brainTimelineEntries.documentId, row.id),
          notInArray(brainTimelineEntries.evidenceId, evidenceIds),
        ),
      );
  } else {
    await db.delete(brainTimelineEntries).where(eq(brainTimelineEntries.documentId, row.id));
  }
  await db.delete(brainEdges).where(eq(brainEdges.documentId, row.id));

  for (const entry of projection.timeline) {
    const parts = timelineParts(entry);
    const values = {
      documentId: row.id,
      userWorkosId,
      brainRef: row.brainRef,
      brainId: row.brainId,
      evidenceId: entry.evidenceId,
      at: new Date(entry.at),
      sourceRef: parts.sourceRef,
      sourceTitle: parts.sourceTitle || null,
      summary: parts.summary,
      detail: parts.detail,
    };
    await db
      .insert(brainTimelineEntries)
      .values(values)
      .onConflictDoUpdate({
        target: [brainTimelineEntries.documentId, brainTimelineEntries.evidenceId],
        set: {
          userWorkosId,
          brainRef: row.brainRef,
          brainId: row.brainId,
          at: values.at,
          sourceRef: values.sourceRef,
          sourceTitle: values.sourceTitle,
          summary: values.summary,
          detail: values.detail,
        },
      });
  }

  for (const edge of deriveBrainEdges({
    id: row.brainId,
    relations: projection.relations,
    body: [projection.body, ...projection.timeline.map((entry) => entry.body)].join("\n\n"),
  })) {
    await db.insert(brainEdges).values({
      id: `goat_brain_edge_${hashBrainContent(
        `${row.id}:${edge.sourceKind}:${edge.type}:${edge.from}:${edge.to}`,
      ).slice(0, 32)}`,
      userWorkosId,
      brainRef: row.brainRef,
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

async function ensureFolderPath(db: DbLike, scope: BrainScope, folderPath: string) {
  const parts = folderPath.split("/").filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    const pathName = parts.slice(0, index + 1).join("/");
    await db
      .insert(brainFolders)
      .values(folderRowValues(scope, pathName, brainFolderSourceForPath(pathName)))
      .onConflictDoNothing();
  }
}

async function upsertFolderRows(
  db: DbLike,
  scope: BrainScope,
  folders: Iterable<Partial<BrainFolderManifestEntry> & { path?: unknown; source?: unknown }>,
) {
  const entries = normalizeBrainFolderEntries(folders);
  for (const entry of entries) {
    await db
      .insert(brainFolders)
      .values(folderRowValues(scope, entry.path, entry.source))
      .onConflictDoUpdate({
        target: [brainFolders.brainRef, brainFolders.path],
        set: {
          userWorkosId: scope.userWorkosId,
          source: entry.source,
          updatedAt: new Date(),
        },
      });
  }
}

async function syncBrainFolderRows(input: {
  db: DbLike;
  scope: BrainScope;
  folders: BrainFolderManifestEntry[];
}) {
  const desired = normalizeBrainFolderEntries(input.folders);
  await upsertFolderRows(input.db, input.scope, desired);
  const desiredPaths = new Set(desired.map((folder) => folder.path));
  const current = await listBrainFolderRows({ brainRef: input.scope.brainRef }, { db: input.db });
  const removable = current
    .filter((folder) => !desiredPaths.has(folder.path) && folder.source !== "system")
    .toSorted((a, b) => b.path.length - a.path.length);
  for (const folder of removable) {
    try {
      await deleteBrainFolderRow(
        {
          brainRef: input.scope.brainRef,
          userWorkosId: input.scope.userWorkosId,
          path: folder.path,
        },
        { db: input.db },
      );
    } catch (error) {
      if (!errorMessage(error).includes("not empty")) throw error;
    }
  }
}

async function deleteFolderRows(db: DbLike, brainRef: string, paths: string[]) {
  for (const pathName of paths.toSorted((a, b) => b.length - a.length)) {
    await db
      .delete(brainFolders)
      .where(and(eq(brainFolders.brainRef, brainRef), eq(brainFolders.path, pathName)));
  }
}

async function documentsUnderFolder(
  db: DbLike,
  brainRef: string,
  folderPath: string,
): Promise<BrainDocument[]> {
  return db
    .select()
    .from(brainDocuments)
    .where(
      and(
        eq(brainDocuments.brainRef, brainRef),
        or(
          eq(brainDocuments.folderPath, folderPath),
          like(brainDocuments.folderPath, `${folderPath}/%`),
        ),
      ),
    );
}

async function foldersUnderFolder(
  db: DbLike,
  brainRef: string,
  folderPath: string,
  options: { includeSelf: boolean },
): Promise<BrainFolder[]> {
  const condition = options.includeSelf
    ? or(eq(brainFolders.path, folderPath), like(brainFolders.path, `${folderPath}/%`))
    : like(brainFolders.path, `${folderPath}/%`);
  const rows = await db
    .select()
    .from(brainFolders)
    .where(and(eq(brainFolders.brainRef, brainRef), condition));
  return normalizeStoredFolderRows(rows);
}

function normalizeStoredFolderRows(rows: BrainFolder[]): BrainFolder[] {
  return rows.flatMap((row) => {
    if (typeof row.path !== "string") return [];
    const folderPath = normalizeBrainFolder(row.path);
    if (!isValidBrainFolder(folderPath)) return [];
    return [
      {
        ...row,
        path: folderPath,
        source:
          row.source === "system" && isHardDefaultBrainFolder(folderPath)
            ? "system"
            : brainFolderSourceForPath(folderPath),
      },
    ];
  });
}

function folderRowValues(scope: BrainScope, folderPath: string, source: BrainFolder["source"]) {
  return {
    id: `goat_brain_folder_${hashBrainContent(`${scope.brainRef}:${folderPath}`).slice(0, 24)}`,
    userWorkosId: scope.userWorkosId,
    brainRef: scope.brainRef,
    path: folderPath,
    source,
  };
}

function replaceFolderPrefix(pathName: string, fromPath: string, toPath: string) {
  if (pathName === fromPath) return toPath;
  return pathName.startsWith(`${fromPath}/`)
    ? `${toPath}/${pathName.slice(fromPath.length + 1)}`
    : pathName;
}

async function insertVersion(
  db: DbLike,
  userWorkosId: string,
  row: BrainDocument,
  operation: "overwrite" | "delete",
  taskId: string | null,
  importRunId: string | null,
) {
  await db.insert(brainDocumentVersions).values({
    userWorkosId,
    brainRef: row.brainRef,
    documentId: row.id,
    taskId,
    importRunId,
    brainId: row.brainId,
    folderPath: row.folderPath,
    content: row.content,
    contentHash: row.contentHash,
    sizeBytes: row.sizeBytes,
    operation,
  });
}

async function findDocumentForUpsert(db: DbLike, brainRef: string, pathName: string) {
  const brainId = brainIdFromRelativePath(pathName);
  if (!brainId) return null;
  const rows = await db
    .select()
    .from(brainDocuments)
    .where(and(eq(brainDocuments.brainRef, brainRef), eq(brainDocuments.brainId, brainId)))
    .limit(1);
  return rows[0] ?? null;
}

async function getDocumentById(db: DbLike, brainRef: string, id: string) {
  const rows = await db
    .select()
    .from(brainDocuments)
    .where(and(eq(brainDocuments.brainRef, brainRef), eq(brainDocuments.id, id)))
    .limit(1);
  return rows[0] ?? null;
}

function normalizeBrainFilePath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized.endsWith(".md") || !isSafeBrainRelativePath(normalized)) {
    throw new Error(`Invalid brain file path "${value}".`);
  }
  const brainId = brainIdFromRelativePath(normalized);
  const folder = brainFolderFromRelativePath(normalized);
  if (!brainId || !folder) throw new Error(`Invalid brain file path "${value}".`);
  return brainFilePathFor(normalizeBrainFolderForV1(folder), brainId);
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
    if (entry.name === "brain.mjs") continue;
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
  const id = brainIdFromRelativePath(relativePath);
  const folder = brainFolderFromRelativePath(relativePath);
  if (!id || !folder) return payload;
  let sidecarSource: string;
  try {
    sidecarSource = await readFile(path.join(root, brainSidecarRelativePath(folder, id)), "utf8");
  } catch (error) {
    if (isNotFound(error)) return payload;
    throw error;
  }
  try {
    const sidecar = parseBrainSidecar(sidecarSource);
    const validation = validateBrainSidecar({
      sidecar,
      payloadContent: payload,
      payloadRelativePath: relativePath,
    });
    if (validation.ok) return serializeLegacyBrainEntry(validation.entry);
    if (isLegacyBrainMarkdown(payload)) return payload;
    return recoverLegacyBrainEntryFromSidecar({
      sidecar,
      payloadContent: payload,
      payloadRelativePath: relativePath,
    });
  } catch {
    if (isLegacyBrainMarkdown(payload)) return payload;
    return null;
  }
}

function sourceFromSidecarOrPayloadSync(_relativePath: string, content: string) {
  return content;
}

function isLegacyBrainMarkdown(value: string) {
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

function timelineParts(entry: BrainTimelineEntry) {
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function titleFromId(id: string): string {
  return id
    .split("-")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

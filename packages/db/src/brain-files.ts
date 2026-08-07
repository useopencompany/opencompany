import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, like, notInArray, or } from "drizzle-orm";
import { NeonHttpDatabase } from "drizzle-orm/neon-http";
import {
  appendGoatBrainAssetTextBlock,
  defaultGoatBrainFolderManifestEntries,
  deriveGoatBrainEdges,
  GOAT_BRAIN_FOLDER_MANIFEST_PATH,
  type GoatBrainDocumentFormat,
  type GoatBrainEntityType,
  type GoatBrainFolderManifestEntry,
  type GoatBrainKind,
  type GoatBrainRelation,
  type GoatBrainSource,
  type GoatBrainStatus,
  type GoatBrainTimelineEntry,
  goatBrainEntryFromLegacyMarkdown,
  goatBrainFolderFromRelativePath,
  goatBrainFolderSourceForPath,
  goatBrainIdFromRelativePath,
  goatBrainKindForFolder,
  goatBrainRelativePath,
  goatBrainSidecarRelativePath,
  isBuiltInGoatBrainEntityType,
  isHardDefaultGoatBrainFolder,
  isSafeGoatBrainRelativePath,
  isValidGoatBrainFolder,
  isValidGoatBrainId,
  isValidGoatBrainKind,
  isValidGoatBrainStatus,
  normalizeGoatBrainCompiledTruth,
  normalizeGoatBrainFolder,
  normalizeGoatBrainFolderEntries,
  normalizeGoatBrainFolderForV1,
  type GoatBrainDocument as ParsedGoatBrainDocument,
  parseGoatBrainDocument,
  parseGoatBrainFolderManifest,
  parseGoatBrainSidecar,
  recoverLegacyGoatBrainEntryFromSidecar,
  replaceGoatBrainCompiledTruth,
  serializeGoatBrainDocument,
  serializeGoatBrainFolderManifest,
  serializeGoatBrainPayload,
  serializeGoatBrainSidecar,
  serializeLegacyGoatBrainEntry,
  stripGoatBrainAssetTextBlock,
  validateGoatBrainDocument,
  validateGoatBrainSidecar,
} from "../../brain/src/index";
import { getDb } from "./client";
import {
  type GoatBrainDocument,
  type GoatBrainFolder,
  goatBrainDocuments,
  goatBrainDocumentVersions,
  goatBrainEdges,
  goatBrainFolders,
  goatBrainTimelineEntries,
} from "./schema";

export const GOAT_BRAIN_FILE_MIME_TYPE = "text/markdown";
export const GOAT_BRAIN_FILE_FORMAT = "markdown";
export const MAX_GOAT_BRAIN_FILE_BYTES = 1_000_000;
// Cap on stored machine-extracted asset text for file-backed rows.
export const MAX_GOAT_BRAIN_ASSET_TEXT_BYTES = 200_000;

export type GoatBrainFileProjection = {
  path: string;
  brainId: string;
  folderPath: string;
  format: typeof GOAT_BRAIN_FILE_FORMAT;
  mimeType: typeof GOAT_BRAIN_FILE_MIME_TYPE;
  content: string;
  body: string;
  timeline: GoatBrainTimelineEntry[];
  contentHash: string;
  sizeBytes: number;
  title: string;
  description?: string;
  kind: GoatBrainKind;
  entityType: GoatBrainEntityType;
  status: GoatBrainStatus;
  relations: GoatBrainRelation[];
  sources: GoatBrainSource[];
  aliases: string[];
};

export type GoatBrainStoredFrontmatter = {
  id?: string;
  kind?: string;
  type?: string;
  status?: string;
  title?: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
  aliases?: string[];
  related?: GoatBrainRelation[];
  sources?: GoatBrainSource[];
  mergedInto?: string;
  folder?: string;
};

export type MaterializedGoatBrainFile = {
  id: string;
  brainId: string;
  path: string;
  folderPath: string;
  contentHash: string;
  // Hash of the bytes actually written to disk when they differ from the
  // row's contentHash (binary-backed rows materialize content plus a
  // generated extracted-text block). Sync uses it to detect unchanged files;
  // conflict detection keeps comparing DB rows via contentHash.
  materializedHash?: string;
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

export type GoatBrainSyncPageAction = "created" | "updated" | "conflict_created";

export type GoatBrainSyncPage = {
  brainId: string;
  folderPath: string;
  title: string;
  action: GoatBrainSyncPageAction;
};

export type GoatBrainSyncResult = {
  upserted: number;
  deleted: number;
  conflicts: GoatBrainSyncConflict[];
  pages: GoatBrainSyncPage[];
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

export function hashGoatBrainContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function createGoatBrainMarkdownContent(input: {
  id: string;
  folderPath: string;
  title: string;
  description?: string;
  type: GoatBrainEntityType;
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
      // Kind is derived from the folder: the evidence/ zone marks evidence docs.
      kind: goatBrainKindForFolder(folder),
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
  // The generated extracted-text block on binary-backed projections is never
  // authoritative: strip it before parsing so it can neither leak into the
  // content column nor let edits inside it flow back.
  const source = stripGoatBrainAssetTextBlock(
    sourceFromSidecarOrPayloadSync(normalizedPath, input.content),
  );

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
  const kind = isValidGoatBrainKind(parsed.frontmatter.kind) ? parsed.frontmatter.kind : null;
  const status = isValidGoatBrainStatus(parsed.frontmatter.status)
    ? parsed.frontmatter.status
    : "draft";
  const title = parsed.title || parsed.frontmatter.title || titleFromId(brainId);
  const validation = validateGoatBrainDocument(parsed, brainId, source);
  if (!validation.ok) throw new Error(validation.errors.join("\n"));
  if (!entityType) throw new Error("frontmatter.type must be a built-in brain entity type.");
  if (!kind) throw new Error('frontmatter.kind must be "page" or "evidence".');
  const body = normalizeGoatBrainCompiledTruth(parsed.compiledTruth, title);
  const content = canonicalGoatBrainContent({
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
  if (sizeBytes > MAX_GOAT_BRAIN_FILE_BYTES) {
    throw new Error(`Brain file "${normalizedPath}" exceeds ${MAX_GOAT_BRAIN_FILE_BYTES} bytes.`);
  }

  return {
    path: normalizedPath,
    brainId,
    folderPath,
    format: GOAT_BRAIN_FILE_FORMAT,
    mimeType: GOAT_BRAIN_FILE_MIME_TYPE,
    content,
    body,
    timeline: parsed.timeline,
    contentHash: hashGoatBrainContent(content),
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

function canonicalGoatBrainContent(input: {
  parsed: ReturnType<typeof parseGoatBrainDocument>;
  brainId: string;
  folderPath: string;
  title: string;
  kind: GoatBrainKind;
  entityType: GoatBrainEntityType;
  status: GoatBrainStatus;
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
  return serializeGoatBrainDocument({
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
// Access control happens upstream (requireGoatBrainAccess) before these run.
export type GoatBrainScope = {
  brainRef: string;
  userWorkosId: string;
};

export async function listGoatBrainFiles(
  input: { brainRef: string },
  options: { db?: DbClient; includeInvalid?: boolean } = {},
): Promise<GoatBrainDocument[]> {
  const db = options.db ?? getDb();
  return db
    .select()
    .from(goatBrainDocuments)
    .where(eq(goatBrainDocuments.brainRef, input.brainRef))
    .orderBy(desc(goatBrainDocuments.updatedAt));
}

export async function listGoatBrainFolderRows(
  input: { brainRef: string },
  options: { db?: DbClient } = {},
): Promise<GoatBrainFolder[]> {
  const db = options.db ?? getDb();
  const rows = await db
    .select()
    .from(goatBrainFolders)
    .where(eq(goatBrainFolders.brainRef, input.brainRef));
  return normalizeStoredFolderRows(Array.isArray(rows) ? rows : []).toSorted((a, b) =>
    a.path.localeCompare(b.path),
  );
}

export async function seedDefaultGoatBrainFolders(
  input: GoatBrainScope,
  options: { db?: DbClient } = {},
): Promise<void> {
  const db = options.db ?? getDb();
  await upsertFolderRows(db, input, defaultGoatBrainFolderManifestEntries());
}

export async function createGoatBrainFolderRow(
  input: GoatBrainScope & { path: string },
  options: { db?: DbClient } = {},
): Promise<GoatBrainFolder> {
  const db = options.db ?? getDb();
  const folderPath = normalizeGoatBrainFolderForV1(input.path);
  if (!isValidGoatBrainFolder(folderPath)) throw new Error("Folder path must be safe.");
  if (isHardDefaultGoatBrainFolder(folderPath)) {
    throw new Error(`Folder "${folderPath}" is required and already exists.`);
  }
  const rows = await db
    .insert(goatBrainFolders)
    .values(folderRowValues(input, folderPath, goatBrainFolderSourceForPath(folderPath)))
    .onConflictDoUpdate({
      target: [goatBrainFolders.brainRef, goatBrainFolders.path],
      set: {
        userWorkosId: input.userWorkosId,
        source: goatBrainFolderSourceForPath(folderPath),
        updatedAt: new Date(),
      },
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error("Failed to create Goat Brain folder.");
  return row;
}

export async function deleteGoatBrainFolderRow(
  input: GoatBrainScope & { path: string },
  options: { db?: DbClient } = {},
): Promise<void> {
  const db = options.db ?? getDb();
  const folderPath = normalizeGoatBrainFolderForV1(input.path);
  if (!isValidGoatBrainFolder(folderPath)) throw new Error("Folder path must be safe.");
  if (isHardDefaultGoatBrainFolder(folderPath)) {
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
    .delete(goatBrainFolders)
    .where(
      and(eq(goatBrainFolders.brainRef, input.brainRef), eq(goatBrainFolders.path, folderPath)),
    );
}

export async function renameGoatBrainFolderRow(
  input: GoatBrainScope & { fromPath: string; toPath: string },
  options: { db?: DbClient } = {},
): Promise<{ movedDocuments: number; movedFolders: number }> {
  const db = options.db ?? getDb();
  return runAtomically(db, async (tx: DbLike) => {
    const fromPath = normalizeGoatBrainFolderForV1(input.fromPath);
    const toPath = normalizeGoatBrainFolderForV1(input.toPath);
    if (!isValidGoatBrainFolder(fromPath) || !isValidGoatBrainFolder(toPath)) {
      throw new Error("Folder paths must be safe.");
    }
    if (fromPath === toPath) return { movedDocuments: 0, movedFolders: 0 };
    if (isHardDefaultGoatBrainFolder(fromPath) || isHardDefaultGoatBrainFolder(toPath)) {
      throw new Error("Required folders cannot be renamed.");
    }
    if (toPath.startsWith(`${fromPath}/`)) {
      throw new Error("Cannot rename a folder into one of its own children.");
    }
    if (goatBrainKindForFolder(fromPath) !== goatBrainKindForFolder(toPath)) {
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
      const parsed = parseGoatBrainDocument(row.content);
      const content = serializeGoatBrainDocument({
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
      await moveGoatBrainFile(
        {
          brainRef: input.brainRef,
          userWorkosId: input.userWorkosId,
          fileId: row.id,
          path: goatBrainFilePathFor(nextFolder, row.brainId),
          content,
        },
        { db: tx },
      );
      movedDocuments += 1;
    }

    const renamedFolders = sourceFolders.map((folder) => ({
      ...folder,
      path: replaceFolderPrefix(folder.path, fromPath, toPath),
      source: goatBrainFolderSourceForPath(replaceFolderPrefix(folder.path, fromPath, toPath)),
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

export async function getGoatBrainFile(
  input: { brainRef: string; fileId: string },
  options: { db?: DbClient } = {},
): Promise<GoatBrainDocument | null> {
  const db = options.db ?? getDb();
  const rows = await db
    .select()
    .from(goatBrainDocuments)
    .where(
      and(eq(goatBrainDocuments.brainRef, input.brainRef), eq(goatBrainDocuments.id, input.fileId)),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function upsertGoatBrainFile(
  input: GoatBrainScope & {
    path: string;
    content: string;
    id?: string;
    taskId?: string | null;
    importRunId?: string | null;
    // Recorded only when the row is created; conflicting upserts never touch
    // it. Defaults to the acting user; pass null when no human originated the
    // content (e.g. Slack-window ingestion).
    createdByWorkosId?: string | null;
  },
  options: { db?: DbClient } = {},
): Promise<GoatBrainDocument> {
  const db = options.db ?? getDb();
  return runAtomically(db, async (tx: DbLike) => {
    const projection = deriveGoatBrainFileProjection({
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
      .insert(goatBrainDocuments)
      .values({
        id: documentId,
        userWorkosId: input.userWorkosId,
        createdByWorkosId:
          input.createdByWorkosId === undefined ? input.userWorkosId : input.createdByWorkosId,
        brainRef: input.brainRef,
        ...documentValues(projection),
        format: GOAT_BRAIN_FILE_FORMAT,
        mimeType: GOAT_BRAIN_FILE_MIME_TYPE,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [goatBrainDocuments.brainRef, goatBrainDocuments.brainId],
        set: {
          ...documentValues(projection),
          userWorkosId: input.userWorkosId,
          updatedAt: now,
        },
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to upsert Goat brain document.");
    await replaceDerivedRows(tx, input.userWorkosId, row, projection);
    return row;
  });
}

// Insert-only companion to upsertGoatBrainFile for interactive file creation.
// A null result means another writer claimed the same brain id first; callers
// can safely allocate the next display name without overwriting that document.
export async function createGoatBrainMarkdownDocument(
  input: GoatBrainScope & {
    path: string;
    content: string;
    id?: string;
  },
  options: { db?: DbClient } = {},
): Promise<GoatBrainDocument | null> {
  const db = options.db ?? getDb();
  const projection = deriveGoatBrainFileProjection({ path: input.path, content: input.content });
  const edges = deriveGoatBrainEdges({
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
    .insert(goatBrainDocuments)
    .values({
      id: input.id ?? `goat_brain_doc_${randomUUID()}`,
      userWorkosId: input.userWorkosId,
      createdByWorkosId: input.userWorkosId,
      brainRef: input.brainRef,
      ...documentValues(projection),
      format: GOAT_BRAIN_FILE_FORMAT,
      mimeType: GOAT_BRAIN_FILE_MIME_TYPE,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({
      target: [goatBrainDocuments.brainRef, goatBrainDocuments.brainId],
    })
    .returning();
  return rows[0] ?? null;
}

export async function updateGoatBrainFileContent(
  input: GoatBrainScope & {
    fileId: string;
    content: string;
    expectedContentHash?: string;
  },
  options: { db?: DbClient } = {},
): Promise<GoatBrainDocument> {
  const db = options.db ?? getDb();
  return runAtomically(db, async (tx: DbLike) => {
    const existing = await getDocumentById(tx, input.brainRef, input.fileId);
    if (!existing) throw new Error("Brain document not found.");
    if (input.expectedContentHash && existing.contentHash !== input.expectedContentHash) {
      throw new Error("Brain document changed since it was loaded. Retry with the latest content.");
    }
    const projection = deriveGoatBrainFileProjection({
      path: goatBrainFilePathFor(existing.folderPath, existing.brainId),
      content: input.content,
    });
    if (existing.contentHash !== projection.contentHash) {
      await insertVersion(tx, input.userWorkosId, existing, "overwrite", null, null);
    }
    const rows = await tx
      .update(goatBrainDocuments)
      .set({
        ...documentValues(projection),
        userWorkosId: input.userWorkosId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(goatBrainDocuments.brainRef, input.brainRef),
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

export async function moveGoatBrainFile(
  input: GoatBrainScope & { fileId: string; path: string; content: string },
  options: { db?: DbClient } = {},
): Promise<GoatBrainDocument> {
  const db = options.db ?? getDb();
  return runAtomically(db, async (tx: DbLike) => {
    const existing = await getDocumentById(tx, input.brainRef, input.fileId);
    if (!existing) throw new Error("Brain document not found.");
    const projection = deriveGoatBrainFileProjection({
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
      .update(goatBrainDocuments)
      .set({
        ...documentValues(projection),
        userWorkosId: input.userWorkosId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(goatBrainDocuments.brainRef, input.brainRef),
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

export async function deleteGoatBrainFile(
  input: GoatBrainScope & {
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
      .delete(goatBrainDocuments)
      .where(
        and(
          eq(goatBrainDocuments.brainRef, input.brainRef),
          eq(goatBrainDocuments.id, input.fileId),
        ),
      );
    return existing as GoatBrainDocument | null;
  });
  if (deleted?.assetStorageKey) await deleteGoatBrainAssetBlob(deleted.assetStorageKey);
}

// Best-effort blob cleanup after the row is gone. Version rows keep the
// markdown projection, not the bytes, so a deleted asset's page can be
// restored but its file cannot.
async function deleteGoatBrainAssetBlob(storageKey: string): Promise<void> {
  try {
    const { del } = await import("@vercel/blob");
    await del(storageKey);
  } catch (error) {
    console.warn(`Failed to delete Goat brain asset blob "${storageKey}":`, error);
  }
}

// Creates the brain document for an uploaded binary file. The row's content
// column holds the normal markdown projection (frontmatter + compiled truth +
// timeline); the bytes live in blob storage behind assetStorageKey. The
// caller is responsible for choosing an unused brainId and for enqueuing the
// ingestion job that extracts text and curates the page.
export async function createGoatBrainAssetDocument(
  input: GoatBrainScope & {
    id?: string;
    brainId: string;
    folderPath: string;
    title: string;
    entityType?: GoatBrainEntityType;
    format: Exclude<GoatBrainDocumentFormat, "markdown">;
    mimeType: string;
    originalFileName: string;
    assetStorageKey: string;
    assetSizeBytes: number;
    assetContentHash?: string | null;
    sourceRef: string;
  },
  options: { db?: DbClient } = {},
): Promise<GoatBrainDocument> {
  const db = options.db ?? getDb();
  const now = new Date();
  const content = createGoatBrainMarkdownContent({
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
  const projection = deriveGoatBrainFileProjection({
    path: goatBrainFilePathFor(input.folderPath, input.brainId),
    content,
  });
  return runAtomically(db, async (tx: DbLike) => {
    const rows = await tx
      .insert(goatBrainDocuments)
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
    if (!row) throw new Error("Failed to create Goat brain asset document.");
    await replaceDerivedRows(tx, input.userWorkosId, row, projection);
    return row;
  });
}

// Records the machine-extracted text of a binary asset (ingestion stage 1).
// Only asset columns move; the markdown projection is untouched, so no
// version row is written.
export async function updateGoatBrainAssetExtraction(
  input: GoatBrainScope & {
    fileId: string;
    extractedText: string;
    assetContentHash: string;
    assetSizeBytes: number;
  },
  options: { db?: DbClient } = {},
): Promise<GoatBrainDocument> {
  const db = options.db ?? getDb();
  const extractedText = truncateUtf8(input.extractedText, MAX_GOAT_BRAIN_ASSET_TEXT_BYTES);
  const rows = await db
    .update(goatBrainDocuments)
    .set({
      assetExtractedText: extractedText || null,
      assetContentHash: input.assetContentHash,
      assetSizeBytes: input.assetSizeBytes,
      updatedAt: new Date(),
    })
    .where(
      and(eq(goatBrainDocuments.brainRef, input.brainRef), eq(goatBrainDocuments.id, input.fileId)),
    )
    .returning();
  const row = rows[0];
  if (!row) throw new Error("Brain document not found.");
  return row;
}

// Points an existing asset document at newly uploaded bytes (re-upload). The
// stale blob is removed best-effort and the extracted text is cleared until
// the next ingestion pass rebuilds it.
export async function replaceGoatBrainAssetFile(
  input: GoatBrainScope & {
    fileId: string;
    mimeType: string;
    originalFileName: string;
    assetStorageKey: string;
    assetSizeBytes: number;
    assetContentHash?: string | null;
  },
  options: { db?: DbClient } = {},
): Promise<GoatBrainDocument> {
  const db = options.db ?? getDb();
  const existing = await getDocumentById(db, input.brainRef, input.fileId);
  if (!existing) throw new Error("Brain document not found.");
  if (existing.format === GOAT_BRAIN_FILE_FORMAT) {
    throw new Error("Only binary-backed brain documents can have their file replaced.");
  }
  const rows = await db
    .update(goatBrainDocuments)
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
      and(eq(goatBrainDocuments.brainRef, input.brainRef), eq(goatBrainDocuments.id, input.fileId)),
    )
    .returning();
  const row = rows[0];
  if (!row) throw new Error("Failed to replace Goat brain asset file.");
  if (existing.assetStorageKey && existing.assetStorageKey !== input.assetStorageKey) {
    await deleteGoatBrainAssetBlob(existing.assetStorageKey);
  }
  return row;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  return Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8").replace(/�+$/, "");
}

export async function materializeGoatBrainFilesToRoot(input: {
  brainRef: string;
  root: string;
  db?: DbClient;
  cliSource?: string;
}): Promise<MaterializedGoatBrainFile[]> {
  await rm(input.root, { recursive: true, force: true });
  await mkdir(input.root, { recursive: true });
  const rows = await listGoatBrainFiles(
    { brainRef: input.brainRef },
    {
      ...(input.db ? { db: input.db } : {}),
      includeInvalid: true,
    },
  );
  const folderRows = await listGoatBrainFolderRows(
    { brainRef: input.brainRef },
    {
      ...(input.db ? { db: input.db } : {}),
    },
  );
  await writeRootFile(
    input.root,
    GOAT_BRAIN_FOLDER_MANIFEST_PATH,
    serializeGoatBrainFolderManifest(folderRows),
  );
  const materializedHashByPath = new Map<string, string>();
  for (const row of rows) {
    const payloadPath = goatBrainFilePathFor(row.folderPath, row.brainId);
    if (row.format !== GOAT_BRAIN_FILE_FORMAT) {
      // Binary-backed rows materialize as their markdown projection (the
      // content column) plus a generated, non-authoritative extracted-text
      // block; the bytes themselves stay in blob storage.
      const projected = appendGoatBrainAssetTextBlock(row.content, row.assetExtractedText ?? "");
      await writeRootFile(input.root, payloadPath, projected);
      if (projected !== row.content) {
        materializedHashByPath.set(payloadPath, hashGoatBrainContent(projected));
      }
      continue;
    }
    let entry: ReturnType<typeof goatBrainEntryFromLegacyMarkdown> | null = null;
    try {
      entry = goatBrainEntryFromLegacyMarkdown(row.content);
    } catch {}
    if (!entry) {
      await writeRootFile(input.root, payloadPath, row.content);
      continue;
    }

    const payload = serializeGoatBrainPayload(entry);
    const sidecarPath = goatBrainSidecarRelativePath(row.folderPath, row.brainId);
    await writeRootFile(input.root, payloadPath, payload);
    await writeRootFile(input.root, sidecarPath, serializeGoatBrainSidecar(entry));
  }
  if (input.cliSource)
    await writeFile(path.join(input.root, "goat-brain.mjs"), input.cliSource, "utf8");
  return rows.map((row) => {
    const path = goatBrainFilePathFor(row.folderPath, row.brainId);
    const materializedHash = materializedHashByPath.get(path);
    return {
      id: row.id,
      brainId: row.brainId,
      path,
      folderPath: row.folderPath,
      contentHash: row.contentHash,
      ...(materializedHash ? { materializedHash } : {}),
    };
  });
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

export async function readGoatBrainFolderManifestFromRoot(
  root: string,
): Promise<GoatBrainFolderManifestEntry[] | null> {
  try {
    const source = await readFile(path.join(root, GOAT_BRAIN_FOLDER_MANIFEST_PATH), "utf8");
    return parseGoatBrainFolderManifest(source);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export async function syncGoatBrainFiles(input: {
  brainRef: string;
  userWorkosId: string;
  files: GoatBrainSyncFile[];
  baseSnapshot: MaterializedGoatBrainFile[];
  db?: DbClient;
  taskId?: string | null;
  importRunId?: string | null;
  folders?: GoatBrainFolderManifestEntry[] | null;
  // Attribution for documents this sync *creates* (existing rows keep theirs).
  // Defaults to the acting user; pass null when no human originated the
  // content (e.g. Slack-window ingestion).
  createdByWorkosId?: string | null;
}): Promise<GoatBrainSyncResult> {
  const db = input.db ?? getDb();
  const currentRows: GoatBrainDocument[] = await db
    .select()
    .from(goatBrainDocuments)
    .where(eq(goatBrainDocuments.brainRef, input.brainRef));
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
      base !== undefined &&
      hashGoatBrainContent(file.content) === (base.materializedHash ?? base.contentHash);
    const skip = Boolean(file.skip || unchangedFromBase);
    if (skip) {
      skippedPaths.add(normalizedPath);
    } else {
      deriveGoatBrainFileProjection({
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

  const conflicts: GoatBrainSyncConflict[] = [];
  const handledConflictPaths = new Set<string>();
  for (const [pathName, next] of nextByPath) {
    // Files the agent left untouched are never written by this sync, so a
    // concurrent change to their stored row is not a write conflict — the
    // newer stored version simply stays. Only files this sync would actually
    // write (modified) or remove (handled below) can conflict.
    if (next.skip) continue;
    const current = currentByPath.get(pathName);
    const base = baseByPath.get(pathName);
    if (current && base && current.contentHash !== base.contentHash) {
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
    if (current && base && current.contentHash !== base.contentHash) {
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
  const pages: GoatBrainSyncPage[] = [];
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
    const brainId = goatBrainIdFromRelativePath(pathName);
    const existing =
      currentByPath.get(pathName) ?? (brainId ? currentByBrainId.get(brainId) : undefined);
    const row = await upsertGoatBrainFile(
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
    await deleteGoatBrainFile(
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
    await syncGoatBrainFolderRows({
      db,
      scope: { brainRef: input.brainRef, userWorkosId: input.userWorkosId },
      folders: input.folders,
    });
  }
  return { upserted, deleted: deleteIds.length, conflicts: [], pages };
}

export async function syncGoatBrainFilesFromRoot(input: {
  brainRef: string;
  userWorkosId: string;
  root: string;
  baseSnapshot: MaterializedGoatBrainFile[];
  db?: DbClient;
  taskId?: string | null;
  importRunId?: string | null;
  createdByWorkosId?: string | null;
}): Promise<GoatBrainSyncResult> {
  const files = await readGoatBrainFilesFromRoot(input.root);
  const folders = await readGoatBrainFolderManifestFromRoot(input.root);
  return syncGoatBrainFiles({
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
  current: GoatBrainDocument;
  taskId: string | null;
  importRunId: string | null;
  createdByWorkosId: string | null;
  db: DbClient;
}): Promise<GoatBrainDocument> {
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
      kind: parsed.frontmatter.kind ?? goatBrainKindForFolder(folderPath),
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
  return upsertGoatBrainFile(
    {
      brainRef: input.brainRef,
      userWorkosId: input.userWorkosId,
      path: goatBrainFilePathFor(folderPath, conflictId),
      content: conflictContent,
      taskId: input.taskId,
      importRunId: input.importRunId,
      createdByWorkosId: input.createdByWorkosId,
    },
    { db: input.db },
  );
}

function addSyncPage(
  pages: GoatBrainSyncPage[],
  row: GoatBrainDocument,
  action: GoatBrainSyncPageAction,
) {
  if (row.kind !== "page") return;
  pages.push({
    brainId: row.brainId,
    folderPath: row.folderPath,
    title: row.title || row.brainId,
    action,
  });
}

export function goatBrainFilePathFor(folderPath: string, brainId: string): string {
  return goatBrainRelativePath(folderPath, brainId);
}

// Markdown-plane fields only. format/mimeType and the asset columns are
// deliberately absent so file-plane syncs can never clobber a binary-backed
// row's asset identity; new rows get their format at insert time.
function documentValues(projection: GoatBrainFileProjection) {
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
    searchText: goatBrainSearchText(projection),
    nameText: goatBrainNameText(projection),
  };
}

// Retrieval projections consumed by goat-brain-read.ts: `search_text` feeds the generated FTS
// tsvector, `name_text` feeds trigram entity lookup. Migration 0102 backfills the same
// composition in SQL for pre-existing rows.
function goatBrainSearchText(projection: GoatBrainFileProjection): string {
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

function goatBrainNameText(projection: GoatBrainFileProjection): string {
  return [projection.title, ...projection.aliases].filter(Boolean).join(" ").trim();
}

async function replaceDerivedRows(
  db: DbLike,
  userWorkosId: string,
  row: GoatBrainDocument,
  projection: GoatBrainFileProjection,
) {
  await ensureFolderPath(db, { brainRef: row.brainRef, userWorkosId }, projection.folderPath);
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
      .insert(goatBrainTimelineEntries)
      .values(values)
      .onConflictDoUpdate({
        target: [goatBrainTimelineEntries.documentId, goatBrainTimelineEntries.evidenceId],
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

  for (const edge of deriveGoatBrainEdges({
    id: row.brainId,
    relations: projection.relations,
    body: [projection.body, ...projection.timeline.map((entry) => entry.body)].join("\n\n"),
  })) {
    await db.insert(goatBrainEdges).values({
      id: `goat_brain_edge_${hashGoatBrainContent(
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

async function ensureFolderPath(db: DbLike, scope: GoatBrainScope, folderPath: string) {
  const parts = folderPath.split("/").filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    const pathName = parts.slice(0, index + 1).join("/");
    await db
      .insert(goatBrainFolders)
      .values(folderRowValues(scope, pathName, goatBrainFolderSourceForPath(pathName)))
      .onConflictDoNothing();
  }
}

async function upsertFolderRows(
  db: DbLike,
  scope: GoatBrainScope,
  folders: Iterable<Partial<GoatBrainFolderManifestEntry> & { path?: unknown; source?: unknown }>,
) {
  const entries = normalizeGoatBrainFolderEntries(folders);
  for (const entry of entries) {
    await db
      .insert(goatBrainFolders)
      .values(folderRowValues(scope, entry.path, entry.source))
      .onConflictDoUpdate({
        target: [goatBrainFolders.brainRef, goatBrainFolders.path],
        set: {
          userWorkosId: scope.userWorkosId,
          source: entry.source,
          updatedAt: new Date(),
        },
      });
  }
}

async function syncGoatBrainFolderRows(input: {
  db: DbLike;
  scope: GoatBrainScope;
  folders: GoatBrainFolderManifestEntry[];
}) {
  const desired = normalizeGoatBrainFolderEntries(input.folders);
  await upsertFolderRows(input.db, input.scope, desired);
  const desiredPaths = new Set(desired.map((folder) => folder.path));
  const current = await listGoatBrainFolderRows(
    { brainRef: input.scope.brainRef },
    { db: input.db },
  );
  const removable = current
    .filter((folder) => !desiredPaths.has(folder.path) && folder.source !== "system")
    .toSorted((a, b) => b.path.length - a.path.length);
  for (const folder of removable) {
    try {
      await deleteGoatBrainFolderRow(
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
      .delete(goatBrainFolders)
      .where(and(eq(goatBrainFolders.brainRef, brainRef), eq(goatBrainFolders.path, pathName)));
  }
}

async function documentsUnderFolder(
  db: DbLike,
  brainRef: string,
  folderPath: string,
): Promise<GoatBrainDocument[]> {
  return db
    .select()
    .from(goatBrainDocuments)
    .where(
      and(
        eq(goatBrainDocuments.brainRef, brainRef),
        or(
          eq(goatBrainDocuments.folderPath, folderPath),
          like(goatBrainDocuments.folderPath, `${folderPath}/%`),
        ),
      ),
    );
}

async function foldersUnderFolder(
  db: DbLike,
  brainRef: string,
  folderPath: string,
  options: { includeSelf: boolean },
): Promise<GoatBrainFolder[]> {
  const condition = options.includeSelf
    ? or(eq(goatBrainFolders.path, folderPath), like(goatBrainFolders.path, `${folderPath}/%`))
    : like(goatBrainFolders.path, `${folderPath}/%`);
  const rows = await db
    .select()
    .from(goatBrainFolders)
    .where(and(eq(goatBrainFolders.brainRef, brainRef), condition));
  return normalizeStoredFolderRows(rows);
}

function normalizeStoredFolderRows(rows: GoatBrainFolder[]): GoatBrainFolder[] {
  return rows.flatMap((row) => {
    if (typeof row.path !== "string") return [];
    const folderPath = normalizeGoatBrainFolder(row.path);
    if (!isValidGoatBrainFolder(folderPath)) return [];
    return [
      {
        ...row,
        path: folderPath,
        source:
          row.source === "system" && isHardDefaultGoatBrainFolder(folderPath)
            ? "system"
            : goatBrainFolderSourceForPath(folderPath),
      },
    ];
  });
}

function folderRowValues(
  scope: GoatBrainScope,
  folderPath: string,
  source: GoatBrainFolder["source"],
) {
  return {
    id: `goat_brain_folder_${hashGoatBrainContent(`${scope.brainRef}:${folderPath}`).slice(0, 24)}`,
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
  row: GoatBrainDocument,
  operation: "overwrite" | "delete",
  taskId: string | null,
  importRunId: string | null,
) {
  await db.insert(goatBrainDocumentVersions).values({
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
  const brainId = goatBrainIdFromRelativePath(pathName);
  if (!brainId) return null;
  const rows = await db
    .select()
    .from(goatBrainDocuments)
    .where(and(eq(goatBrainDocuments.brainRef, brainRef), eq(goatBrainDocuments.brainId, brainId)))
    .limit(1);
  return rows[0] ?? null;
}

async function getDocumentById(db: DbLike, brainRef: string, id: string) {
  const rows = await db
    .select()
    .from(goatBrainDocuments)
    .where(and(eq(goatBrainDocuments.brainRef, brainRef), eq(goatBrainDocuments.id, id)))
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

import { createHash, randomUUID } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import {
  type GoatBrainRelation,
  type GoatBrainSource,
  goatBrainDocuments,
  goatBrainFolders,
} from "@opencompany/db/goat-schema";
import {
  DEFAULT_GOAT_BRAIN_FOLDERS,
  DEFAULT_GOAT_BRAIN_RELATION_TYPE,
  GOAT_BRAIN_MARKDOWN_MIME_TYPE,
  type GoatBrainDocument as GoatBrainContractDocument,
  type GoatBrainDocumentKind,
  type GoatBrainEntityType,
  type GoatBrainEntry,
  type GoatBrainFrontmatter,
  type GoatBrainTimelineEntry,
  goatBrainEntryFromLegacyMarkdown,
  inferGoatBrainEntityTypeFromFolder,
  isValidGoatBrainFolder,
  isValidGoatBrainId,
  normalizeGoatBrainFolder,
  normalizeGoatBrainId,
  parseGoatBrainDocument,
  serializeLegacyGoatBrainEntry,
  validateGoatBrainDocument,
} from "@opencompany/goat-brain";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { currentGoatUser } from "@/lib/auth";

export const MAX_GOAT_BRAIN_DOC_BYTES = 256 * 1024;

export type GoatBrainFolderView = {
  id: string;
  path: string;
  source: "system" | "custom";
};

export type GoatBrainDocumentView = {
  id: string;
  brainId: string;
  folderPath: string;
  title: string | null;
  content: string;
  body: string;
  timeline: GoatBrainTimelineEntry[];
  kind: GoatBrainDocumentKind;
  mimeType: string | null;
  originalFileName: string | null;
  assetStorageKey: string | null;
  relations: GoatBrainRelation[];
  sources: GoatBrainSource[];
  type: GoatBrainEntityType;
  aliases: string[];
  contentHash: string;
  sizeBytes: number;
  updatedAt: string;
  createdAt: string;
};

export type GoatBrainSnapshot = {
  folders: GoatBrainFolderView[];
  documents: GoatBrainDocumentView[];
};

export type BrainMutationResult =
  | { ok: true; path?: string; document?: GoatBrainDocumentView }
  | { ok: false; error: string };

export async function listCurrentUserGoatBrain(): Promise<GoatBrainSnapshot> {
  const { user } = await currentGoatUser();
  return listGoatBrainForUser(user.workosUserId);
}

export async function listGoatBrainForUser(userWorkosId: string): Promise<GoatBrainSnapshot> {
  await ensureGoatBrainDefaultFolders(userWorkosId);
  const db = getDb();
  const [folders, documents] = await Promise.all([
    db
      .select()
      .from(goatBrainFolders)
      .where(eq(goatBrainFolders.userWorkosId, userWorkosId))
      .orderBy(asc(goatBrainFolders.path)),
    db
      .select()
      .from(goatBrainDocuments)
      .where(eq(goatBrainDocuments.userWorkosId, userWorkosId))
      .orderBy(asc(goatBrainDocuments.folderPath), desc(goatBrainDocuments.updatedAt)),
  ]);

  return {
    folders: folders.map((folder) => ({
      id: folder.id,
      path: folder.path,
      source: folder.source,
    })),
    documents: documents.map(documentViewFromRow),
  };
}

export async function ensureGoatBrainDefaultFolders(userWorkosId: string) {
  const now = new Date();
  const db = getDb();
  for (const path of DEFAULT_GOAT_BRAIN_FOLDERS) {
    await db
      .insert(goatBrainFolders)
      .values({
        id: `goat_brain_folder_${randomUUID()}`,
        userWorkosId,
        path,
        source: "system",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [goatBrainFolders.userWorkosId, goatBrainFolders.path],
      });
    await db
      .update(goatBrainFolders)
      .set({ source: "system", updatedAt: now })
      .where(
        and(
          eq(goatBrainFolders.userWorkosId, userWorkosId),
          eq(goatBrainFolders.path, path),
          eq(goatBrainFolders.source, "custom"),
        ),
      );
  }
}

export async function createGoatBrainFolderForUser(
  userWorkosId: string,
  rawPath: string,
): Promise<BrainMutationResult> {
  const path = normalizeGoatBrainFolder(rawPath);
  if (!isValidGoatBrainFolder(path)) {
    return { ok: false, error: "Folder path must be a safe lowercase path." };
  }

  const source = DEFAULT_GOAT_BRAIN_FOLDERS.includes(path as never) ? "system" : "custom";
  await ensureGoatBrainDefaultFolders(userWorkosId);
  const now = new Date();
  const [folder] = await getDb()
    .insert(goatBrainFolders)
    .values({
      id: `goat_brain_folder_${randomUUID()}`,
      userWorkosId,
      path,
      source,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [goatBrainFolders.userWorkosId, goatBrainFolders.path],
      set: { source, updatedAt: now },
    })
    .returning();

  return { ok: true, path: folder?.path ?? path };
}

export async function createGoatBrainDocumentForUser(input: {
  userWorkosId: string;
  folderPath: string;
  title?: string;
  truth?: string;
}): Promise<BrainMutationResult> {
  const folderPath = normalizeGoatBrainFolder(input.folderPath || "inbox");
  if (!isValidGoatBrainFolder(folderPath)) {
    return { ok: false, error: "Folder path must be a safe lowercase path." };
  }

  await createGoatBrainFolderForUser(input.userWorkosId, folderPath);
  const nowIso = new Date().toISOString();
  const baseId = normalizeGoatBrainId(input.title || "untitled") || "untitled";
  const brainId = await nextAvailableGoatBrainId(input.userWorkosId, baseId);
  const title = input.title?.trim() || titleFromId(brainId);
  const entry: GoatBrainEntry = {
    id: brainId,
    folder: folderPath,
    title,
    kind: "markdown",
    mimeType: GOAT_BRAIN_MARKDOWN_MIME_TYPE,
    body: input.truth?.trim() || "",
    createdAt: nowIso,
    updatedAt: nowIso,
    relations: [],
    sources: [],
    type: inferGoatBrainEntityTypeFromFolder(folderPath),
    aliases: [],
    tags: [],
    timeline: [],
  };
  const content = serializeLegacyGoatBrainEntry(entry);
  const normalized = validateAndDeriveGoatBrainDocument(content);
  if (!normalized.ok) return normalized;

  const now = new Date();
  const [row] = await getDb()
    .insert(goatBrainDocuments)
    .values({
      id: `goat_brain_doc_${randomUUID()}`,
      userWorkosId: input.userWorkosId,
      brainId: normalized.document.frontmatter.id,
      folderPath: normalized.document.frontmatter.folder,
      title: normalized.title,
      content,
      body: entry.body,
      timeline: entry.timeline,
      kind: entry.kind,
      mimeType: entry.mimeType,
      relations: normalized.relations,
      sources: normalized.sources,
      entityType: entry.type,
      aliases: entry.aliases,
      contentHash: normalized.contentHash,
      sizeBytes: normalized.sizeBytes,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  if (!row) return { ok: false, error: "Could not create brain document." };
  return {
    ok: true,
    path: brainDocumentPath(row.folderPath, row.brainId),
    document: documentViewFromRow(row),
  };
}

export async function updateGoatBrainDocumentForUser(input: {
  userWorkosId: string;
  documentId: string;
  body: string;
}): Promise<BrainMutationResult> {
  const db = getDb();
  const [existing] = await db
    .select()
    .from(goatBrainDocuments)
    .where(
      and(
        eq(goatBrainDocuments.id, input.documentId),
        eq(goatBrainDocuments.userWorkosId, input.userWorkosId),
      ),
    )
    .limit(1);
  if (!existing) return { ok: false, error: "Brain document was not found." };

  const entry = entryFromDocumentRow(existing);
  const updatedAt = new Date().toISOString();
  const nextEntry: GoatBrainEntry = {
    ...entry,
    body: input.body,
    updatedAt,
  };
  const content = serializeLegacyGoatBrainEntry(nextEntry);
  const normalized = validateAndDeriveGoatBrainDocument(content);
  if (!normalized.ok) return normalized;

  const snapshot = await listGoatBrainForUser(input.userWorkosId);
  const collision = snapshot.documents.find(
    (document) =>
      document.id !== input.documentId && document.brainId === normalized.document.frontmatter.id,
  );
  if (collision) {
    return { ok: false, error: `A brain document with id "${collision.brainId}" already exists.` };
  }

  await createGoatBrainFolderForUser(input.userWorkosId, normalized.document.frontmatter.folder);
  const now = new Date();
  const [row] = rowsFromExecute<GoatBrainDocumentRow>(
    await db.execute(sql`
      WITH existing AS (
        SELECT *
        FROM goat.brain_documents
        WHERE id = ${input.documentId}
          AND user_workos_id = ${input.userWorkosId}
        LIMIT 1
      ),
      version AS (
        INSERT INTO goat.brain_document_versions (
          user_workos_id,
          document_id,
          brain_id,
          folder_path,
          content,
          content_hash,
          size_bytes,
          operation,
          created_at
        )
        SELECT
          existing.user_workos_id,
          existing.id,
          existing.brain_id,
          existing.folder_path,
          existing.content,
          existing.content_hash,
          existing.size_bytes,
          'overwrite',
          ${now}
        FROM existing
        RETURNING document_id
      ),
      updated AS (
        UPDATE goat.brain_documents AS document
        SET brain_id = ${normalized.document.frontmatter.id},
            folder_path = ${normalized.document.frontmatter.folder},
            title = ${normalized.title},
            content = ${content},
            body = ${nextEntry.body},
            timeline = ${JSON.stringify(nextEntry.timeline)}::jsonb,
            kind = ${nextEntry.kind},
            mime_type = ${nextEntry.mimeType},
            original_file_name = ${nextEntry.originalFileName ?? null},
            asset_storage_key = ${nextEntry.assetStorageKey ?? null},
            relations = ${JSON.stringify(normalized.relations)}::jsonb,
            sources = ${JSON.stringify(normalized.sources)}::jsonb,
            entity_type = ${nextEntry.type},
            aliases = ${JSON.stringify(nextEntry.aliases)}::jsonb,
            content_hash = ${normalized.contentHash},
            size_bytes = ${normalized.sizeBytes},
            updated_at = ${now}
        WHERE document.id = ${input.documentId}
          AND document.user_workos_id = ${input.userWorkosId}
          AND EXISTS (SELECT 1 FROM version)
        RETURNING document.*
      )
      SELECT
        id,
        user_workos_id AS "userWorkosId",
        brain_id AS "brainId",
        folder_path AS "folderPath",
        title,
        content,
        body,
        timeline,
        kind,
        mime_type AS "mimeType",
        original_file_name AS "originalFileName",
        asset_storage_key AS "assetStorageKey",
        relations,
        sources,
        entity_type AS "entityType",
        aliases,
        content_hash AS "contentHash",
        size_bytes AS "sizeBytes",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM updated
    `),
  );

  if (!row) return { ok: false, error: "Could not save brain document." };
  return {
    ok: true,
    path: brainDocumentPath(row.folderPath, row.brainId),
    document: documentViewFromRow(row),
  };
}

export async function moveGoatBrainDocumentForUser(input: {
  userWorkosId: string;
  documentId: string;
  folderPath: string;
}): Promise<BrainMutationResult> {
  const folderPath = normalizeGoatBrainFolder(input.folderPath);
  if (!isValidGoatBrainFolder(folderPath)) {
    return { ok: false, error: "Folder path must be a safe lowercase path." };
  }

  const db = getDb();
  const [existing] = await db
    .select()
    .from(goatBrainDocuments)
    .where(
      and(
        eq(goatBrainDocuments.id, input.documentId),
        eq(goatBrainDocuments.userWorkosId, input.userWorkosId),
      ),
    )
    .limit(1);
  if (!existing) return { ok: false, error: "Brain document was not found." };

  const entry = entryFromDocumentRow(existing);
  const content = serializeLegacyGoatBrainEntry({
    ...entry,
    folder: folderPath,
    updatedAt: new Date().toISOString(),
  });

  return updateGoatBrainDocumentContentForUser({
    userWorkosId: input.userWorkosId,
    documentId: input.documentId,
    content,
  });
}

async function updateGoatBrainDocumentContentForUser(input: {
  userWorkosId: string;
  documentId: string;
  content: string;
}): Promise<BrainMutationResult> {
  const normalized = validateAndDeriveGoatBrainDocument(input.content);
  if (!normalized.ok) return normalized;
  const entry = goatBrainEntryFromLegacyMarkdown(input.content);

  const db = getDb();
  const [existing] = await db
    .select()
    .from(goatBrainDocuments)
    .where(
      and(
        eq(goatBrainDocuments.id, input.documentId),
        eq(goatBrainDocuments.userWorkosId, input.userWorkosId),
      ),
    )
    .limit(1);
  if (!existing) return { ok: false, error: "Brain document was not found." };

  const snapshot = await listGoatBrainForUser(input.userWorkosId);
  const collision = snapshot.documents.find(
    (document) =>
      document.id !== input.documentId && document.brainId === normalized.document.frontmatter.id,
  );
  if (collision) {
    return { ok: false, error: `A brain document with id "${collision.brainId}" already exists.` };
  }

  await createGoatBrainFolderForUser(input.userWorkosId, normalized.document.frontmatter.folder);
  const now = new Date();
  const [row] = rowsFromExecute<GoatBrainDocumentRow>(
    await db.execute(sql`
      WITH existing AS (
        SELECT *
        FROM goat.brain_documents
        WHERE id = ${input.documentId}
          AND user_workos_id = ${input.userWorkosId}
        LIMIT 1
      ),
      version AS (
        INSERT INTO goat.brain_document_versions (
          user_workos_id,
          document_id,
          brain_id,
          folder_path,
          content,
          content_hash,
          size_bytes,
          operation,
          created_at
        )
        SELECT
          existing.user_workos_id,
          existing.id,
          existing.brain_id,
          existing.folder_path,
          existing.content,
          existing.content_hash,
          existing.size_bytes,
          'overwrite',
          ${now}
        FROM existing
        RETURNING document_id
      ),
      updated AS (
        UPDATE goat.brain_documents AS document
        SET brain_id = ${normalized.document.frontmatter.id},
            folder_path = ${normalized.document.frontmatter.folder},
            title = ${normalized.title},
            content = ${input.content},
            body = ${entry.body},
            timeline = ${JSON.stringify(entry.timeline)}::jsonb,
            kind = ${entry.kind},
            mime_type = ${entry.mimeType},
            original_file_name = ${entry.originalFileName ?? null},
            asset_storage_key = ${entry.assetStorageKey ?? null},
            relations = ${JSON.stringify(normalized.relations)}::jsonb,
            sources = ${JSON.stringify(normalized.sources)}::jsonb,
            entity_type = ${entry.type},
            aliases = ${JSON.stringify(entry.aliases)}::jsonb,
            content_hash = ${normalized.contentHash},
            size_bytes = ${normalized.sizeBytes},
            updated_at = ${now}
        WHERE document.id = ${input.documentId}
          AND document.user_workos_id = ${input.userWorkosId}
          AND EXISTS (SELECT 1 FROM version)
        RETURNING document.*
      )
      SELECT
        id,
        user_workos_id AS "userWorkosId",
        brain_id AS "brainId",
        folder_path AS "folderPath",
        title,
        content,
        body,
        timeline,
        kind,
        mime_type AS "mimeType",
        original_file_name AS "originalFileName",
        asset_storage_key AS "assetStorageKey",
        relations,
        sources,
        entity_type AS "entityType",
        aliases,
        content_hash AS "contentHash",
        size_bytes AS "sizeBytes",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM updated
    `),
  );

  if (!row) return { ok: false, error: "Could not save brain document." };
  return {
    ok: true,
    path: brainDocumentPath(row.folderPath, row.brainId),
    document: documentViewFromRow(row),
  };
}

export async function deleteGoatBrainDocumentForUser(input: {
  userWorkosId: string;
  documentId: string;
}): Promise<BrainMutationResult> {
  const db = getDb();
  const [existing] = await db
    .select()
    .from(goatBrainDocuments)
    .where(
      and(
        eq(goatBrainDocuments.id, input.documentId),
        eq(goatBrainDocuments.userWorkosId, input.userWorkosId),
      ),
    )
    .limit(1);
  if (!existing) return { ok: false, error: "Brain document was not found." };

  const now = new Date();
  const deleted = rowsFromExecute<{ id: string }>(
    await db.execute(sql`
      WITH existing AS (
        SELECT *
        FROM goat.brain_documents
        WHERE id = ${input.documentId}
          AND user_workos_id = ${input.userWorkosId}
        LIMIT 1
      ),
      version AS (
        INSERT INTO goat.brain_document_versions (
          user_workos_id,
          document_id,
          brain_id,
          folder_path,
          content,
          content_hash,
          size_bytes,
          operation,
          created_at
        )
        SELECT
          existing.user_workos_id,
          existing.id,
          existing.brain_id,
          existing.folder_path,
          existing.content,
          existing.content_hash,
          existing.size_bytes,
          'delete',
          ${now}
        FROM existing
        RETURNING document_id
      )
      DELETE FROM goat.brain_documents AS document
      WHERE document.id = ${input.documentId}
        AND document.user_workos_id = ${input.userWorkosId}
        AND EXISTS (SELECT 1 FROM version)
      RETURNING document.id
    `),
  );

  if (deleted.length === 0) return { ok: false, error: "Could not delete brain document." };

  return { ok: true, path: "/brain" };
}

export type ValidatedGoatBrainContent =
  | {
      ok: true;
      document: GoatBrainContractDocument;
      title: string;
      relations: GoatBrainRelation[];
      sources: GoatBrainSource[];
      contentHash: string;
      sizeBytes: number;
    }
  | { ok: false; error: string };

export function validateAndDeriveGoatBrainDocument(source: string): ValidatedGoatBrainContent {
  const sizeBytes = Buffer.byteLength(source, "utf8");
  if (sizeBytes > MAX_GOAT_BRAIN_DOC_BYTES) {
    return { ok: false, error: "Brain document is too large." };
  }

  const parsed = parseGoatBrainDocument(source);
  const validation = validateGoatBrainDocument(parsed, parsed.frontmatter.id, source);
  if (!validation.ok) return { ok: false, error: validation.errors.join(" ") };

  const frontmatter = parsed.frontmatter as GoatBrainFrontmatter;
  if (!isValidGoatBrainId(frontmatter.id) || !isValidGoatBrainFolder(frontmatter.folder)) {
    return { ok: false, error: "Brain document frontmatter is invalid." };
  }

  const title = (frontmatter.title ?? parsed.title).trim();
  return {
    ok: true,
    document: {
      frontmatter,
      title,
      compiledTruth: parsed.compiledTruth,
      timeline: parsed.timeline,
    },
    title,
    relations: frontmatter.relations.map((relation) => ({
      type: relation.type,
      to: relation.to,
    })),
    sources: (frontmatter.sources ?? []).map((sourceEntry) => ({
      ref: sourceEntry.ref,
      ...(sourceEntry.title ? { title: sourceEntry.title } : {}),
      ...(sourceEntry.capturedAt ? { capturedAt: sourceEntry.capturedAt } : {}),
    })),
    contentHash: hashGoatBrainContent(source),
    sizeBytes,
  };
}

export function hashGoatBrainContent(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

export async function nextAvailableGoatBrainId(userWorkosId: string, baseId: string) {
  const normalizedBase = normalizeGoatBrainId(baseId) || "untitled";
  const existing = await getDb()
    .select({ brainId: goatBrainDocuments.brainId })
    .from(goatBrainDocuments)
    .where(eq(goatBrainDocuments.userWorkosId, userWorkosId));
  const taken = new Set(existing.map((document) => document.brainId));
  if (!taken.has(normalizedBase)) return normalizedBase;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${normalizedBase}-${suffix}`;
    if (!taken.has(candidate) && isValidGoatBrainId(candidate)) return candidate;
  }
  return `note-${randomUUID().slice(0, 8)}`;
}

type GoatBrainDocumentRow = Omit<
  typeof goatBrainDocuments.$inferSelect,
  "createdAt" | "updatedAt"
> & {
  createdAt: Date | string;
  updatedAt: Date | string;
};

function documentViewFromRow(row: GoatBrainDocumentRow): GoatBrainDocumentView {
  const entry = entryFromDocumentRow(row);
  return {
    id: row.id,
    brainId: entry.id,
    folderPath: entry.folder,
    title: row.title ?? entry.title,
    content: row.content,
    body: entry.body,
    timeline: entry.timeline,
    kind: entry.kind,
    mimeType: entry.mimeType,
    originalFileName: entry.originalFileName ?? null,
    assetStorageKey: entry.assetStorageKey ?? null,
    relations: entry.relations,
    sources: entry.sources,
    type: entry.type,
    aliases: entry.aliases,
    contentHash: row.contentHash,
    sizeBytes: row.sizeBytes,
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

function entryFromDocumentRow(row: GoatBrainDocumentRow): GoatBrainEntry {
  const legacyEntry = safeLegacyEntry(row.content);
  const kind = isGoatBrainDocumentKind(row.kind) ? row.kind : "markdown";
  const body = row.body || legacyEntry?.body || "";
  const timeline = normalizeTimeline(row.timeline, legacyEntry?.timeline ?? []);
  return {
    id: row.brainId,
    folder: row.folderPath,
    title: row.title?.trim() || legacyEntry?.title || titleFromId(row.brainId),
    kind,
    mimeType: row.mimeType?.trim() || mimeTypeForKind(kind),
    body,
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
    relations: normalizeEntryRelations(row.relations ?? legacyEntry?.relations ?? []),
    sources: row.sources ?? legacyEntry?.sources ?? [],
    type: row.entityType || legacyEntry?.type || inferGoatBrainEntityTypeFromFolder(row.folderPath),
    aliases: normalizeStringArray(row.aliases, legacyEntry?.aliases ?? []),
    tags: legacyEntry?.tags ?? [],
    timeline: kind === "markdown" ? timeline : [],
    ...(row.originalFileName ? { originalFileName: row.originalFileName } : {}),
    ...(row.assetStorageKey ? { assetStorageKey: row.assetStorageKey } : {}),
  };
}

function safeLegacyEntry(content: string): GoatBrainEntry | null {
  try {
    return goatBrainEntryFromLegacyMarkdown(content);
  } catch {
    return null;
  }
}

function normalizeTimeline(value: unknown, fallback: GoatBrainTimelineEntry[]) {
  if (!Array.isArray(value)) return fallback;
  const entries = value.flatMap((entry): GoatBrainTimelineEntry[] => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.at !== "string" || typeof record.body !== "string") return [];
    return [{ at: record.at, body: record.body }];
  });
  return entries;
}

function normalizeEntryRelations(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((relation): GoatBrainEntry["relations"] => {
    if (!relation || typeof relation !== "object") return [];
    const record = relation as Record<string, unknown>;
    if (typeof record.to !== "string") return [];
    return [
      {
        type: typeof record.type === "string" ? record.type : DEFAULT_GOAT_BRAIN_RELATION_TYPE,
        to: record.to,
      },
    ];
  });
}

function normalizeStringArray(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) return fallback;
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function isGoatBrainDocumentKind(value: unknown): value is GoatBrainDocumentKind {
  return value === "markdown" || value === "pdf" || value === "docx";
}

function mimeTypeForKind(kind: GoatBrainDocumentKind) {
  if (kind === "pdf") return "application/pdf";
  if (kind === "docx") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  return GOAT_BRAIN_MARKDOWN_MIME_TYPE;
}

function titleFromId(id: string) {
  return id
    .split("-")
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function brainDocumentPath(folderPath: string, brainId: string) {
  const folderSegments = folderPath.split("/").map((segment) => encodeURIComponent(segment));
  return `/brain/${folderSegments.join("/")}/${encodeURIComponent(brainId)}`;
}

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as T[];
  }
  return [];
}

function toIsoString(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { shellQuote } from "@opencompany/agent-runtime";
import {
  type GoatBrainRelation,
  type GoatBrainSource,
  goatBrainDocuments,
  goatBrainDocumentVersions,
  goatBrainFolders,
} from "@opencompany/db/goat-schema";
import {
  DEFAULT_GOAT_BRAIN_FOLDERS,
  DEFAULT_GOAT_BRAIN_RELATION_TYPE,
  GOAT_BRAIN_MARKDOWN_MIME_TYPE,
  type GoatBrainDocument as GoatBrainContractDocument,
  type GoatBrainDocumentKind,
  type GoatBrainEntry,
  type GoatBrainFrontmatter,
  type GoatBrainTimelineEntry,
  goatBrainEntryFromLegacyMarkdown,
  goatBrainFolderFromRelativePath,
  goatBrainIdFromRelativePath,
  goatBrainPayloadRelativePath,
  goatBrainRelativePath,
  goatBrainSidecarRelativePath,
  isSafeGoatBrainRelativePath,
  isValidGoatBrainFolder,
  isValidGoatBrainId,
  normalizeGoatBrainId,
  parseGoatBrainDocument,
  parseGoatBrainSidecar,
  serializeGoatBrainDocument,
  serializeGoatBrainPayload,
  serializeGoatBrainSidecar,
  serializeLegacyGoatBrainEntry,
  validateGoatBrainDocument,
  validateGoatBrainSidecar,
} from "@opencompany/goat-brain";
import { getGoatBrainCliSource } from "@opencompany/goat-brain/cli-bundle";
import { and, eq } from "drizzle-orm";
import { getDb } from "./db";
import type { SandboxHandle } from "./sandbox";

export const GOAT_BRAIN_ROOT = "/home/user/goat-brain";
export const GOAT_BRAIN_CLI_PATH = "/tmp/goat-brain.mjs";
export const MAX_GOAT_BRAIN_SANDBOX_FILE_BYTES = 256 * 1024;

type GoatBrainDocumentRow = typeof goatBrainDocuments.$inferSelect;
type SandboxBrainFile = {
  relativePath: string;
  content: string;
  sidecarContent?: string;
};

export type MaterializedGoatBrainSnapshot = {
  files: MaterializedGoatBrainFile[];
};

export type MaterializedGoatBrainFile = {
  documentId: string;
  brainId: string;
  folderPath: string;
  relativePath: string;
  contentHash: string;
};

export async function materializeGoatBrainForTask(input: {
  sandbox: SandboxHandle;
  userWorkosId: string;
}): Promise<MaterializedGoatBrainSnapshot> {
  const documents = await getDb()
    .select()
    .from(goatBrainDocuments)
    .where(eq(goatBrainDocuments.userWorkosId, input.userWorkosId));

  await input.sandbox.commands.run(
    `rm -rf ${shellQuote(GOAT_BRAIN_ROOT)} && mkdir -p ${shellQuote(GOAT_BRAIN_ROOT)}`,
    { timeoutMs: 30_000 },
  );
  await input.sandbox.files.write(GOAT_BRAIN_CLI_PATH, getGoatBrainCliSource());
  await input.sandbox.commands.run(`chmod 700 ${shellQuote(GOAT_BRAIN_CLI_PATH)}`, {
    timeoutMs: 30_000,
  });

  const files: MaterializedGoatBrainFile[] = [];
  for (const document of documents) {
    const entry = entryFromDocumentRow(document);
    const relativePath = goatBrainPayloadRelativePath(
      entry.folder,
      entry.id,
      entry.kind,
      entry.originalFileName,
    );
    const sidecarPath = goatBrainSidecarRelativePath(entry.folder, entry.id);
    await input.sandbox.commands.run(
      `mkdir -p ${shellQuote(`${GOAT_BRAIN_ROOT}/${entry.folder}`)} ${shellQuote(
        `${GOAT_BRAIN_ROOT}/${entry.folder}/.brain`,
      )}`,
      { timeoutMs: 30_000 },
    );
    await input.sandbox.files.write(
      `${GOAT_BRAIN_ROOT}/${relativePath}`,
      serializeGoatBrainPayload(entry),
    );
    await input.sandbox.files.write(
      `${GOAT_BRAIN_ROOT}/${sidecarPath}`,
      serializeGoatBrainSidecar(entry),
    );
    files.push({
      documentId: document.id,
      brainId: document.brainId,
      folderPath: document.folderPath,
      relativePath,
      contentHash: document.contentHash,
    });
  }

  return { files };
}

export async function materializeGoatBrainToLocalRoot(input: {
  root: string;
  userWorkosId: string;
}): Promise<MaterializedGoatBrainSnapshot & { cliPath: string }> {
  const documents = await getDb()
    .select()
    .from(goatBrainDocuments)
    .where(eq(goatBrainDocuments.userWorkosId, input.userWorkosId));
  const cliPath = path.join(input.root, "goat-brain.mjs");

  await rm(input.root, { recursive: true, force: true });
  await mkdir(input.root, { recursive: true });
  await writeFile(cliPath, getGoatBrainCliSource(), "utf8");

  const files: MaterializedGoatBrainFile[] = [];
  for (const document of documents) {
    const entry = entryFromDocumentRow(document);
    const relativePath = goatBrainPayloadRelativePath(
      entry.folder,
      entry.id,
      entry.kind,
      entry.originalFileName,
    );
    const sidecarPath = goatBrainSidecarRelativePath(entry.folder, entry.id);
    const fullPath = path.join(input.root, relativePath);
    const sidecarFullPath = path.join(input.root, sidecarPath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await mkdir(path.dirname(sidecarFullPath), { recursive: true });
    await writeFile(fullPath, serializeGoatBrainPayload(entry), "utf8");
    await writeFile(sidecarFullPath, serializeGoatBrainSidecar(entry), "utf8");
    files.push({
      documentId: document.id,
      brainId: document.brainId,
      folderPath: document.folderPath,
      relativePath,
      contentHash: document.contentHash,
    });
  }

  return { files, cliPath };
}

export async function syncGoatBrainFromSandbox(input: {
  sandbox: SandboxHandle;
  userWorkosId: string;
  taskId: string;
  baseSnapshot: MaterializedGoatBrainSnapshot;
}) {
  const sandboxFiles = await readSandboxBrainFiles(input.sandbox);
  await syncGoatBrainFiles({
    files: sandboxFiles,
    userWorkosId: input.userWorkosId,
    taskId: input.taskId,
    baseSnapshot: input.baseSnapshot,
  });
}

export async function syncGoatBrainFromLocalRoot(input: {
  root: string;
  userWorkosId: string;
  taskId: string;
  baseSnapshot: MaterializedGoatBrainSnapshot;
}) {
  const files = await readLocalBrainFiles(input.root);
  await syncGoatBrainFiles({
    files,
    userWorkosId: input.userWorkosId,
    taskId: input.taskId,
    baseSnapshot: input.baseSnapshot,
  });
}

async function syncGoatBrainFiles(input: {
  files: SandboxBrainFile[];
  userWorkosId: string;
  taskId: string;
  baseSnapshot: MaterializedGoatBrainSnapshot;
}) {
  const sandboxFiles = input.files;
  const baseByPath = new Map(input.baseSnapshot.files.map((file) => [file.relativePath, file]));
  const baseByBrainId = new Map(input.baseSnapshot.files.map((file) => [file.brainId, file]));
  const currentRows = await getDb()
    .select()
    .from(goatBrainDocuments)
    .where(eq(goatBrainDocuments.userWorkosId, input.userWorkosId));
  const currentByDocumentId = new Map(currentRows.map((row) => [row.id, row]));
  const currentByBrainId = new Map(currentRows.map((row) => [row.brainId, row]));
  const seenBrainIds = new Set<string>();
  const seenBasePaths = new Set<string>();

  for (const file of sandboxFiles) {
    const pathId = goatBrainIdFromRelativePath(file.relativePath);
    const baseForPath =
      baseByPath.get(file.relativePath) ?? (pathId ? baseByBrainId.get(pathId) : undefined);
    const validated = validateSandboxBrainFile(file);
    if (!validated.ok) {
      if (baseForPath) {
        seenBasePaths.add(baseForPath.relativePath);
        seenBrainIds.add(baseForPath.brainId);
      }
      continue;
    }
    const base = baseForPath ?? baseByBrainId.get(validated.brainId);
    if (base) {
      seenBasePaths.add(base.relativePath);
      seenBrainIds.add(base.brainId);
    }
    if (base?.contentHash === validated.contentHash) continue;

    const current = base
      ? currentByDocumentId.get(base.documentId)
      : currentByBrainId.get(validated.brainId);
    const collidingCurrent = base && current ? currentByBrainId.get(validated.brainId) : undefined;
    if (
      base &&
      current?.contentHash === base.contentHash &&
      collidingCurrent &&
      collidingCurrent.id !== current.id
    ) {
      await insertConflictBrainDocumentFromSandbox({
        userWorkosId: input.userWorkosId,
        taskId: input.taskId,
        validated,
      });
      continue;
    }

    if (base && current?.contentHash === base.contentHash) {
      await updateBrainDocumentFromSandbox({
        userWorkosId: input.userWorkosId,
        taskId: input.taskId,
        current,
        validated,
      });
      continue;
    }

    if (!base && !current) {
      await insertBrainDocumentFromSandbox({
        userWorkosId: input.userWorkosId,
        validated,
      });
      continue;
    }

    await insertConflictBrainDocumentFromSandbox({
      userWorkosId: input.userWorkosId,
      taskId: input.taskId,
      validated,
    });
  }

  for (const base of input.baseSnapshot.files) {
    if (seenBasePaths.has(base.relativePath) || seenBrainIds.has(base.brainId)) continue;
    const current = currentByDocumentId.get(base.documentId);
    if (!current || current.contentHash !== base.contentHash) continue;
    await deleteBrainDocumentFromSandbox({
      userWorkosId: input.userWorkosId,
      taskId: input.taskId,
      current,
    });
  }
}

async function readSandboxBrainFiles(sandbox: SandboxHandle) {
  const result = await sandbox.commands.run(
    `if [ -d ${shellQuote(GOAT_BRAIN_ROOT)} ]; then find ${shellQuote(
      GOAT_BRAIN_ROOT,
    )} -type f -name '*.md' -print | sort; fi`,
    { timeoutMs: 30_000 },
  );
  const paths = String(result.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((absolutePath) => stripRootPrefix(absolutePath))
    .filter((relativePath): relativePath is string => Boolean(relativePath));

  const files: SandboxBrainFile[] = [];
  for (const relativePath of paths) {
    if (!isSafeGoatBrainRelativePath(relativePath)) continue;
    const content = String(await sandbox.files.read(`${GOAT_BRAIN_ROOT}/${relativePath}`));
    if (Buffer.byteLength(content, "utf8") > MAX_GOAT_BRAIN_SANDBOX_FILE_BYTES) continue;
    const sidecarContent = await readSandboxSidecar(sandbox, relativePath);
    files.push({ relativePath, content, ...(sidecarContent ? { sidecarContent } : {}) });
  }
  return files;
}

async function readLocalBrainFiles(root: string) {
  const relativePaths = await walkLocalMarkdown(root, "");
  const files: SandboxBrainFile[] = [];
  for (const relativePath of relativePaths) {
    if (!isSafeGoatBrainRelativePath(relativePath)) continue;
    const content = await readFile(path.join(root, relativePath), "utf8");
    if (Buffer.byteLength(content, "utf8") > MAX_GOAT_BRAIN_SANDBOX_FILE_BYTES) continue;
    const sidecarContent = await readLocalSidecar(root, relativePath);
    files.push({ relativePath, content, ...(sidecarContent ? { sidecarContent } : {}) });
  }
  return files;
}

async function readSandboxSidecar(sandbox: SandboxHandle, relativePath: string) {
  const id = goatBrainIdFromRelativePath(relativePath);
  const folder = goatBrainFolderFromRelativePath(relativePath);
  if (!id || !folder) return null;
  try {
    return String(
      await sandbox.files.read(`${GOAT_BRAIN_ROOT}/${goatBrainSidecarRelativePath(folder, id)}`),
    );
  } catch {
    return null;
  }
}

async function readLocalSidecar(root: string, relativePath: string) {
  const id = goatBrainIdFromRelativePath(relativePath);
  const folder = goatBrainFolderFromRelativePath(relativePath);
  if (!id || !folder) return null;
  try {
    return await readFile(path.join(root, goatBrainSidecarRelativePath(folder, id)), "utf8");
  } catch (error) {
    if (error && typeof error === "object" && (error as { code?: string }).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function walkLocalMarkdown(root: string, relDir: string): Promise<string[]> {
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = (await readdir(path.join(root, relDir), { withFileTypes: true })) as Array<{
      name: string;
      isDirectory(): boolean;
      isFile(): boolean;
    }>;
  } catch (error) {
    if (error && typeof error === "object" && (error as { code?: string }).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const found: string[] = [];
  for (const entry of entries) {
    const childRel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === ".brain") continue;
      found.push(...(await walkLocalMarkdown(root, childRel)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      found.push(childRel);
    }
  }
  return found.sort();
}

function validateSandboxBrainFile(file: SandboxBrainFile):
  | {
      ok: true;
      brainId: string;
      folderPath: string;
      title: string;
      content: string;
      body: string;
      timeline: GoatBrainTimelineEntry[];
      kind: GoatBrainDocumentKind;
      mimeType: string;
      originalFileName: string | null;
      assetStorageKey: string | null;
      contentHash: string;
      sizeBytes: number;
      related: GoatBrainRelation[];
      sources: GoatBrainSource[];
      document: GoatBrainContractDocument;
    }
  | { ok: false } {
  const pathId = goatBrainIdFromRelativePath(file.relativePath);
  const pathFolder = goatBrainFolderFromRelativePath(file.relativePath);
  if (!pathId || !pathFolder) return { ok: false };

  if (file.sidecarContent) {
    const sidecarValidation = validateGoatBrainSidecar({
      sidecar: parseGoatBrainSidecar(file.sidecarContent),
      payloadContent: file.content,
      payloadRelativePath: file.relativePath,
    });
    if (!sidecarValidation.ok) return { ok: false };
    const entry = sidecarValidation.entry;
    const content = serializeLegacyGoatBrainEntry(entry);
    const parsed = parseGoatBrainDocument(content);
    const validation = validateGoatBrainDocument(parsed, pathId, content);
    if (!validation.ok || entry.folder !== pathFolder || entry.id !== pathId) return { ok: false };
    const sizeBytes = Buffer.byteLength(content, "utf8");
    return {
      ok: true,
      brainId: entry.id,
      folderPath: entry.folder,
      title: entry.title,
      content,
      body: entry.body,
      timeline: entry.kind === "markdown" ? entry.timeline : [],
      kind: entry.kind,
      mimeType: entry.mimeType,
      originalFileName: entry.originalFileName ?? null,
      assetStorageKey: entry.assetStorageKey ?? null,
      contentHash: hashContent(content),
      sizeBytes,
      related: entry.related,
      sources: entry.sources,
      document: {
        frontmatter: parsed.frontmatter as GoatBrainFrontmatter,
        title: entry.title,
        compiledTruth: entry.body,
        timeline: entry.kind === "markdown" ? entry.timeline : [],
      },
    };
  }

  const parsed = parseGoatBrainDocument(file.content);
  const validation = validateGoatBrainDocument(parsed, pathId, file.content);
  if (!validation.ok) return { ok: false };
  if (parsed.frontmatter.folder !== pathFolder) return { ok: false };
  const frontmatter = parsed.frontmatter as GoatBrainFrontmatter;
  if (!isValidGoatBrainId(frontmatter.id) || !isValidGoatBrainFolder(frontmatter.folder)) {
    return { ok: false };
  }

  const sizeBytes = Buffer.byteLength(file.content, "utf8");
  const entry = goatBrainEntryFromLegacyMarkdown(file.content);
  return {
    ok: true,
    brainId: frontmatter.id,
    folderPath: frontmatter.folder,
    title: (frontmatter.title ?? parsed.title).trim() || frontmatter.id,
    content: file.content,
    body: entry.body,
    timeline: entry.timeline,
    kind: entry.kind,
    mimeType: entry.mimeType,
    originalFileName: entry.originalFileName ?? null,
    assetStorageKey: entry.assetStorageKey ?? null,
    contentHash: hashContent(file.content),
    sizeBytes,
    related: frontmatter.related.map((relation) => ({
      type: relation.type,
      target: relation.target,
    })),
    sources: (frontmatter.sources ?? []).map((source) => ({
      ref: source.ref,
      ...(source.title ? { title: source.title } : {}),
      ...(source.capturedAt ? { capturedAt: source.capturedAt } : {}),
    })),
    document: {
      frontmatter,
      title: (frontmatter.title ?? parsed.title).trim() || frontmatter.id,
      compiledTruth: parsed.compiledTruth,
      timeline: parsed.timeline,
    },
  };
}

async function updateBrainDocumentFromSandbox(input: {
  userWorkosId: string;
  taskId: string;
  current: GoatBrainDocumentRow | undefined;
  validated: ValidatedSandboxBrainFile;
}) {
  if (!input.current) {
    await insertBrainDocumentFromSandbox(input);
    return;
  }
  const current = input.current;

  await ensureBrainFolder(input.userWorkosId, input.validated.folderPath);
  const now = new Date();
  await getDb().transaction(async (tx) => {
    await tx.insert(goatBrainDocumentVersions).values({
      userWorkosId: input.userWorkosId,
      documentId: current.id,
      taskId: input.taskId,
      brainId: current.brainId,
      folderPath: current.folderPath,
      content: current.content,
      contentHash: current.contentHash,
      sizeBytes: current.sizeBytes,
      operation: "overwrite",
      createdAt: now,
    });
    await tx
      .update(goatBrainDocuments)
      .set({
        brainId: input.validated.brainId,
        folderPath: input.validated.folderPath,
        title: input.validated.title,
        content: input.validated.content,
        body: input.validated.body,
        timeline: input.validated.timeline,
        kind: input.validated.kind,
        mimeType: input.validated.mimeType,
        originalFileName: input.validated.originalFileName,
        assetStorageKey: input.validated.assetStorageKey,
        related: input.validated.related,
        sources: input.validated.sources,
        contentHash: input.validated.contentHash,
        sizeBytes: input.validated.sizeBytes,
        updatedAt: now,
      })
      .where(
        and(
          eq(goatBrainDocuments.id, current.id),
          eq(goatBrainDocuments.userWorkosId, input.userWorkosId),
        ),
      );
  });
}

async function insertBrainDocumentFromSandbox(input: {
  userWorkosId: string;
  validated: ValidatedSandboxBrainFile;
}) {
  await ensureBrainFolder(input.userWorkosId, input.validated.folderPath);
  const now = new Date();
  await getDb()
    .insert(goatBrainDocuments)
    .values({
      id: `goat_brain_doc_${randomUUID()}`,
      userWorkosId: input.userWorkosId,
      brainId: input.validated.brainId,
      folderPath: input.validated.folderPath,
      title: input.validated.title,
      content: input.validated.content,
      body: input.validated.body,
      timeline: input.validated.timeline,
      kind: input.validated.kind,
      mimeType: input.validated.mimeType,
      originalFileName: input.validated.originalFileName,
      assetStorageKey: input.validated.assetStorageKey,
      related: input.validated.related,
      sources: input.validated.sources,
      contentHash: input.validated.contentHash,
      sizeBytes: input.validated.sizeBytes,
      createdAt: now,
      updatedAt: now,
    });
}

async function insertConflictBrainDocumentFromSandbox(input: {
  userWorkosId: string;
  taskId: string;
  validated: ValidatedSandboxBrainFile;
}) {
  const conflictId = await nextConflictBrainId(input.userWorkosId, input.validated.brainId);
  const conflictDocument: GoatBrainContractDocument = {
    ...input.validated.document,
    frontmatter: {
      ...input.validated.document.frontmatter,
      id: conflictId,
      title: `${input.validated.title} conflict`,
      updatedAt: new Date().toISOString(),
      related: [
        ...input.validated.document.frontmatter.related,
        { type: "conflicts_with", target: input.validated.brainId },
      ],
    },
    title: `${input.validated.title} conflict`,
  };
  const content = serializeGoatBrainDocument(conflictDocument);
  const validated = validateSandboxBrainFile({
    relativePath: goatBrainRelativePath(conflictDocument.frontmatter.folder, conflictId),
    content,
  });
  if (!validated.ok) return;
  await insertBrainDocumentFromSandbox({
    userWorkosId: input.userWorkosId,
    validated,
  });
  await getDb().insert(goatBrainDocumentVersions).values({
    userWorkosId: input.userWorkosId,
    taskId: input.taskId,
    brainId: input.validated.brainId,
    folderPath: input.validated.folderPath,
    content: input.validated.content,
    contentHash: input.validated.contentHash,
    sizeBytes: input.validated.sizeBytes,
    operation: "overwrite",
    createdAt: new Date(),
  });
}

async function deleteBrainDocumentFromSandbox(input: {
  userWorkosId: string;
  taskId: string;
  current: GoatBrainDocumentRow;
}) {
  const now = new Date();
  await getDb().transaction(async (tx) => {
    await tx.insert(goatBrainDocumentVersions).values({
      userWorkosId: input.userWorkosId,
      documentId: input.current.id,
      taskId: input.taskId,
      brainId: input.current.brainId,
      folderPath: input.current.folderPath,
      content: input.current.content,
      contentHash: input.current.contentHash,
      sizeBytes: input.current.sizeBytes,
      operation: "delete",
      createdAt: now,
    });
    await tx
      .delete(goatBrainDocuments)
      .where(
        and(
          eq(goatBrainDocuments.id, input.current.id),
          eq(goatBrainDocuments.userWorkosId, input.userWorkosId),
        ),
      );
  });
}

async function ensureBrainFolder(userWorkosId: string, path: string) {
  if (!isValidGoatBrainFolder(path)) return;
  const now = new Date();
  const source = (DEFAULT_GOAT_BRAIN_FOLDERS as readonly string[]).includes(path)
    ? "system"
    : "custom";
  await getDb()
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
    });
}

async function nextConflictBrainId(userWorkosId: string, brainId: string) {
  const base = normalizeGoatBrainId(`${brainId}-conflict`) || "conflict";
  const existing = await getDb()
    .select({ brainId: goatBrainDocuments.brainId })
    .from(goatBrainDocuments)
    .where(eq(goatBrainDocuments.userWorkosId, userWorkosId));
  const taken = new Set(existing.map((document) => document.brainId));
  for (let suffix = 1; suffix < 10_000; suffix += 1) {
    const candidate = normalizeGoatBrainId(`${base}-${suffix}`);
    if (candidate && isValidGoatBrainId(candidate) && !taken.has(candidate)) return candidate;
  }
  return normalizeGoatBrainId(`conflict-${randomUUID().slice(0, 8)}`) || "conflict";
}

function stripRootPrefix(absolutePath: string) {
  const prefix = `${GOAT_BRAIN_ROOT}/`;
  return absolutePath.startsWith(prefix) ? absolutePath.slice(prefix.length) : null;
}

function hashContent(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

function entryFromDocumentRow(row: GoatBrainDocumentRow): GoatBrainEntry {
  const legacyEntry = safeLegacyEntry(row.content);
  const kind = isGoatBrainDocumentKind(row.kind) ? row.kind : "markdown";
  return {
    id: row.brainId,
    folder: row.folderPath,
    title: row.title?.trim() || legacyEntry?.title || row.brainId,
    kind,
    mimeType: row.mimeType?.trim() || mimeTypeForKind(kind),
    body: row.body || legacyEntry?.body || "",
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
    related: normalizeEntryRelations(row.related ?? legacyEntry?.related ?? []),
    sources: row.sources ?? legacyEntry?.sources ?? [],
    tags: legacyEntry?.tags ?? [],
    timeline:
      kind === "markdown" ? normalizeTimeline(row.timeline, legacyEntry?.timeline ?? []) : [],
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
  return value.flatMap((entry): GoatBrainTimelineEntry[] => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.at !== "string" || typeof record.body !== "string") return [];
    return [{ at: record.at, body: record.body }];
  });
}

function normalizeEntryRelations(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((relation): GoatBrainEntry["related"] => {
    if (!relation || typeof relation !== "object") return [];
    const record = relation as Record<string, unknown>;
    if (typeof record.target !== "string") return [];
    return [
      {
        type: typeof record.type === "string" ? record.type : DEFAULT_GOAT_BRAIN_RELATION_TYPE,
        target: record.target,
      },
    ];
  });
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

function toIsoString(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

type ValidatedSandboxBrainFile = Extract<ReturnType<typeof validateSandboxBrainFile>, { ok: true }>;

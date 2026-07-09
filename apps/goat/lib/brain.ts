import {
  createGoatBrainMarkdownContent,
  deleteGoatBrainFile,
  deriveGoatBrainFileProjection,
  getGoatBrainFile,
  goatBrainFilePathFor,
  hashGoatBrainContent,
  listGoatBrainFiles,
  moveGoatBrainFile,
  replaceGoatBrainFileCompiledTruth,
  updateGoatBrainFileContent,
  upsertGoatBrainFile,
} from "@opencompany/db/goat-brain-files";
import type { GoatBrainDocument as GoatBrainDocumentRow } from "@opencompany/db/goat-schema";
import {
  DEFAULT_GOAT_BRAIN_FOLDERS,
  type GoatBrainDocument,
  type GoatBrainEntityType,
  type GoatBrainKind,
  type GoatBrainRelation,
  type GoatBrainSource,
  type GoatBrainStatus,
  type GoatBrainTimelineEntry,
  goatBrainFolderKindError,
  goatBrainKindForFolder,
  isBuiltInGoatBrainEntityType,
  isValidGoatBrainFolder,
  isValidGoatBrainId,
  isValidGoatBrainKind,
  normalizeGoatBrainCompiledTruth,
  normalizeGoatBrainFolderForV1,
  normalizeGoatBrainId,
  nowIso,
  parseGoatBrainDocument,
  serializeGoatBrainDocument,
} from "@opencompany/goat-brain";
import { currentGoatUser } from "@/lib/auth";

export type GoatBrainFolderView = {
  id: string;
  path: string;
  name: string;
  source: "system" | "custom";
  createdAt: string;
  updatedAt: string;
};

export type GoatBrainDocumentView = {
  id: string;
  brainId: string;
  folderPath: string;
  path: string;
  title: string;
  content: string;
  body: string;
  timeline: GoatBrainTimelineEntry[];
  format: "markdown" | "pdf" | "docx";
  mimeType: string;
  originalFileName?: string | null;
  assetStorageKey?: string | null;
  relations: GoatBrainRelation[];
  sources: GoatBrainSource[];
  kind: GoatBrainKind;
  type: GoatBrainEntityType;
  status: GoatBrainStatus;
  aliases: string[];
  contentHash: string;
  sizeBytes: number;
  parseError?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GoatBrainSnapshot = {
  folders: GoatBrainFolderView[];
  documents: GoatBrainDocumentView[];
};

export type BrainMutationResult =
  | { ok: true; path?: string; document?: GoatBrainDocumentView }
  | { ok: false; message: string };

export type ValidatedGoatBrainContent = {
  document: GoatBrainDocument;
  title: string;
  body: string;
  timeline: GoatBrainTimelineEntry[];
  relations: GoatBrainRelation[];
  sources: GoatBrainSource[];
  aliases: string[];
  kind: GoatBrainKind;
  type: GoatBrainEntityType;
  status: GoatBrainStatus;
  contentHash: string;
  sizeBytes: number;
  parseError: string | null;
};

export async function listCurrentUserGoatBrain(): Promise<GoatBrainSnapshot> {
  const context = await currentGoatUser();
  if (!context.activeBrain) return { folders: [], documents: [] };
  return listGoatBrainForBrain(context.activeBrain.id);
}

export async function listGoatBrainForBrain(brainRef: string): Promise<GoatBrainSnapshot> {
  const rows = await listGoatBrainFiles({ brainRef }, { includeInvalid: true });
  const documents = rows.map(documentViewFromFileRow).sort(compareBrainDocuments);
  return {
    folders: deriveFolderViews(documents),
    documents,
  };
}

export async function updateGoatBrainDocumentForUser(input: {
  brainRef: string;
  userWorkosId: string;
  documentId: string;
  body: string;
  expectedContentHash?: string;
}): Promise<BrainMutationResult> {
  const existing = await getGoatBrainFile({
    brainRef: input.brainRef,
    fileId: input.documentId,
  });
  if (!existing) return { ok: false, message: "Brain file not found." };
  const content = replaceGoatBrainFileCompiledTruth({
    content: existing.content,
    compiledTruth: input.body,
    updatedAt: nowIso(),
  });
  const row = await updateGoatBrainFileContent({
    brainRef: input.brainRef,
    userWorkosId: input.userWorkosId,
    fileId: input.documentId,
    content,
    ...(input.expectedContentHash ? { expectedContentHash: input.expectedContentHash } : {}),
  });
  return {
    ok: true,
    path: goatBrainFilePathFor(row.folderPath, row.brainId),
    document: documentViewFromFileRow(row),
  };
}

export async function renameGoatBrainDocumentForUser(input: {
  brainRef: string;
  userWorkosId: string;
  documentId: string;
  title: string;
}): Promise<BrainMutationResult> {
  const title = input.title.trim();
  if (!title) return { ok: false, message: "Title cannot be empty." };
  const existing = await getGoatBrainFile({
    brainRef: input.brainRef,
    fileId: input.documentId,
  });
  if (!existing) return { ok: false, message: "Brain file not found." };
  const parsed = parseGoatBrainDocument(existing.content);
  const type =
    parsed.frontmatter.type && isBuiltInGoatBrainEntityType(parsed.frontmatter.type)
      ? parsed.frontmatter.type
      : existing.entityType;
  const kind = isValidGoatBrainKind(parsed.frontmatter.kind)
    ? parsed.frontmatter.kind
    : existing.kind;
  const content = serializeGoatBrainDocument({
    title,
    compiledTruth: parsed.compiledTruth,
    timeline: parsed.timeline,
    frontmatter: {
      id: existing.brainId,
      folder: existing.folderPath,
      kind,
      type,
      status: parsed.frontmatter.status ?? existing.status,
      title,
      createdAt: parsed.frontmatter.createdAt ?? existing.createdAt.toISOString(),
      updatedAt: nowIso(),
      relations: parsed.frontmatter.relations ?? [],
      ...(parsed.frontmatter.aliases ? { aliases: parsed.frontmatter.aliases } : {}),
      ...(parsed.frontmatter.sources ? { sources: parsed.frontmatter.sources } : {}),
      ...(parsed.frontmatter.mergedInto ? { mergedInto: parsed.frontmatter.mergedInto } : {}),
    },
  });
  const row = await updateGoatBrainFileContent({
    brainRef: input.brainRef,
    userWorkosId: input.userWorkosId,
    fileId: input.documentId,
    content,
  });
  return {
    ok: true,
    path: goatBrainFilePathFor(row.folderPath, row.brainId),
    document: documentViewFromFileRow(row),
  };
}

export async function moveGoatBrainDocumentForUser(input: {
  brainRef: string;
  userWorkosId: string;
  documentId: string;
  folderPath: string;
}): Promise<BrainMutationResult> {
  const folderPath = normalizeGoatBrainFolderForV1(input.folderPath);
  if (!isValidGoatBrainFolder(folderPath)) {
    return { ok: false, message: "Folder paths must be lowercase slugs separated by /." };
  }
  const existing = await getGoatBrainFile({
    brainRef: input.brainRef,
    fileId: input.documentId,
  });
  if (!existing) return { ok: false, message: "Brain file not found." };
  const parsed = parseGoatBrainDocument(existing.content);
  const type =
    parsed.frontmatter.type && isBuiltInGoatBrainEntityType(parsed.frontmatter.type)
      ? parsed.frontmatter.type
      : existing.entityType;
  const kind = isValidGoatBrainKind(parsed.frontmatter.kind)
    ? parsed.frontmatter.kind
    : existing.kind;
  const folderKindError = goatBrainFolderKindError(folderPath, kind);
  if (folderKindError) {
    return {
      ok: false,
      message: `Folder "${folderPath}" does not match kind "${kind}". ${folderKindError}`,
    };
  }
  const content = serializeGoatBrainDocument({
    title: parsed.title || existing.title || existing.brainId,
    compiledTruth: parsed.compiledTruth,
    timeline: parsed.timeline,
    frontmatter: {
      id: existing.brainId,
      folder: folderPath,
      kind,
      type,
      status: parsed.frontmatter.status ?? existing.status,
      title: parsed.frontmatter.title ?? existing.title ?? existing.brainId,
      createdAt: parsed.frontmatter.createdAt ?? existing.createdAt.toISOString(),
      updatedAt: nowIso(),
      relations: parsed.frontmatter.relations ?? [],
      ...(parsed.frontmatter.aliases ? { aliases: parsed.frontmatter.aliases } : {}),
      ...(parsed.frontmatter.sources ? { sources: parsed.frontmatter.sources } : {}),
      ...(parsed.frontmatter.mergedInto ? { mergedInto: parsed.frontmatter.mergedInto } : {}),
    },
  });
  const row = await moveGoatBrainFile({
    brainRef: input.brainRef,
    userWorkosId: input.userWorkosId,
    fileId: input.documentId,
    path: goatBrainFilePathFor(folderPath, existing.brainId),
    content,
  });
  return {
    ok: true,
    path: goatBrainFilePathFor(row.folderPath, row.brainId),
    document: documentViewFromFileRow(row),
  };
}

export async function deleteGoatBrainDocumentForUser(input: {
  brainRef: string;
  userWorkosId: string;
  documentId: string;
}): Promise<BrainMutationResult> {
  await deleteGoatBrainFile({
    brainRef: input.brainRef,
    userWorkosId: input.userWorkosId,
    fileId: input.documentId,
  });
  return { ok: true };
}

export function validateAndDeriveGoatBrainDocument(source: string): ValidatedGoatBrainContent {
  const parsed = parseGoatBrainDocument(source);
  const id =
    parsed.frontmatter.id && isValidGoatBrainId(parsed.frontmatter.id)
      ? parsed.frontmatter.id
      : "temporary";
  const folder =
    parsed.frontmatter.folder && isValidGoatBrainFolder(parsed.frontmatter.folder)
      ? parsed.frontmatter.folder
      : "inbox";
  const projection = deriveGoatBrainFileProjection({
    path: goatBrainFilePathFor(folder, id),
    content: source,
  });
  return {
    document: {
      title: parsed.title || projection.title || projection.brainId,
      compiledTruth: projection.body,
      timeline: parsed.timeline,
      frontmatter: {
        id: parsed.frontmatter.id ?? projection.brainId,
        folder: parsed.frontmatter.folder ?? projection.folderPath,
        kind: projection.kind,
        type: projection.entityType,
        status: projection.status,
        title: parsed.frontmatter.title ?? projection.title ?? projection.brainId,
        createdAt: parsed.frontmatter.createdAt ?? nowIso(),
        updatedAt: parsed.frontmatter.updatedAt ?? nowIso(),
        relations: parsed.frontmatter.relations ?? [],
        ...(parsed.frontmatter.aliases ? { aliases: parsed.frontmatter.aliases } : {}),
        ...(parsed.frontmatter.sources ? { sources: parsed.frontmatter.sources } : {}),
        ...(parsed.frontmatter.mergedInto ? { mergedInto: parsed.frontmatter.mergedInto } : {}),
      },
    },
    title: projection.title ?? projection.brainId,
    body: projection.body,
    timeline: parsed.timeline,
    relations: parsed.frontmatter.relations ?? [],
    sources: parsed.frontmatter.sources ?? [],
    aliases: parsed.frontmatter.aliases ?? [],
    kind: projection.kind,
    type: projection.entityType,
    status: projection.status,
    contentHash: projection.contentHash,
    sizeBytes: projection.sizeBytes,
    parseError: null,
  };
}

export function documentViewFromFileRow(row: GoatBrainDocumentRow): GoatBrainDocumentView {
  const parsed = parseGoatBrainDocument(row.content);
  const path = goatBrainFilePathFor(row.folderPath, row.brainId);
  return {
    id: row.id,
    brainId: row.brainId,
    folderPath: row.folderPath,
    path,
    title: row.title || parsed.title || row.brainId,
    content: row.content,
    body: normalizeGoatBrainCompiledTruth(row.body, row.title || parsed.title || row.brainId),
    timeline: parsed.timeline,
    format: "markdown",
    mimeType: row.mimeType ?? "text/markdown",
    originalFileName: null,
    assetStorageKey: null,
    relations: parsed.frontmatter.relations ?? [],
    sources: parsed.frontmatter.sources ?? [],
    kind: row.kind,
    type: row.entityType,
    status: row.status,
    aliases: parsed.frontmatter.aliases ?? [],
    contentHash: row.contentHash,
    sizeBytes: row.sizeBytes,
    parseError: null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function nextAvailableGoatBrainId(brainRef: string, baseId: string): Promise<string> {
  const base = isValidGoatBrainId(baseId) ? baseId : "untitled";
  const rows = await listGoatBrainFiles({ brainRef }, { includeInvalid: true });
  const used = new Set(rows.map((row) => row.brainId));
  if (!used.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error("Could not allocate a unique brain id.");
}

export { hashGoatBrainContent };

function deriveFolderViews(documents: GoatBrainDocumentView[]): GoatBrainFolderView[] {
  const now = new Date(0).toISOString();
  const byPath = new Map<string, GoatBrainFolderView>();
  for (const folder of DEFAULT_GOAT_BRAIN_FOLDERS) {
    byPath.set(folder, {
      id: `folder:${folder}`,
      path: folder,
      name: folderName(folder),
      source: "system",
      createdAt: now,
      updatedAt: now,
    });
  }
  for (const document of documents) {
    for (const path of ancestorFolders(document.folderPath)) {
      const existing = byPath.get(path);
      const updatedAt =
        existing && existing.updatedAt > document.updatedAt
          ? existing.updatedAt
          : document.updatedAt;
      byPath.set(path, {
        id: `folder:${path}`,
        path,
        name: folderName(path),
        source: DEFAULT_GOAT_BRAIN_FOLDERS.includes(
          path as (typeof DEFAULT_GOAT_BRAIN_FOLDERS)[number],
        )
          ? "system"
          : "custom",
        createdAt: existing?.createdAt ?? document.createdAt,
        updatedAt,
      });
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function ancestorFolders(folderPath: string): string[] {
  const parts = folderPath.split("/").filter(Boolean);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

function folderName(folderPath: string): string {
  const last = folderPath.split("/").filter(Boolean).at(-1) ?? folderPath;
  return last
    .split("-")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function compareBrainDocuments(a: GoatBrainDocumentView, b: GoatBrainDocumentView) {
  const folder = a.folderPath.localeCompare(b.folderPath);
  if (folder !== 0) return folder;
  return a.title.localeCompare(b.title);
}

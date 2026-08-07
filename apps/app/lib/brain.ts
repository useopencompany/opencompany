import {
  type BrainDocument,
  type BrainEntityType,
  type BrainKind,
  type BrainRelation,
  type BrainSource,
  type BrainStatus,
  type BrainTimelineEntry,
  brainFolderKindError,
  brainFolderSourceForPath,
  compareBrainFolderPaths,
  isBrainSkillFolder,
  isBrainWorkflowFolder,
  isBuiltInBrainEntityType,
  isValidBrainFolder,
  isValidBrainId,
  isValidBrainKind,
  isValidBrainStatus,
  normalizeBrainCompiledTruth,
  normalizeBrainFolderForV1,
  normalizeBrainId,
  nowIso,
  parseBrainDocument,
  serializeBrainDocument,
} from "@opencompany/brain";
import {
  brainFilePathFor,
  createBrainFolderRow,
  createBrainMarkdownContent,
  createBrainMarkdownDocument,
  deleteBrainFile,
  deleteBrainFolderRow,
  deriveBrainFileProjection,
  getBrainFile,
  hashBrainContent,
  listBrainFiles,
  listBrainFolderRows,
  moveBrainFile,
  renameBrainFolderRow,
  replaceBrainFileCompiledTruth,
  updateBrainFileContent,
} from "@opencompany/db/brain-files";
import type {
  BrainDocument as BrainDocumentRow,
  BrainFolder as BrainFolderRow,
} from "@opencompany/db/schema";
import { currentUser } from "@/lib/auth";
import { isWorkflowModelToken } from "@/lib/workflow-model-options";

export type BrainFolderView = {
  id: string;
  path: string;
  name: string;
  source: "system" | "custom";
  createdAt: string;
  updatedAt: string;
};

export type BrainDocumentView = {
  id: string;
  brainId: string;
  folderPath: string;
  path: string;
  title: string;
  description?: string;
  content: string;
  body: string;
  timeline: BrainTimelineEntry[];
  format: "markdown" | "pdf" | "docx" | "xlsx" | "srt" | "csv" | "tsv" | "json" | "text" | "image";
  mimeType: string;
  originalFileName?: string | null;
  assetStorageKey?: string | null;
  assetSizeBytes?: number | null;
  relations: BrainRelation[];
  sources: BrainSource[];
  kind: BrainKind;
  type: BrainEntityType;
  status: BrainStatus;
  aliases: string[];
  contentHash: string;
  sizeBytes: number;
  parseError?: string | null;
  // Who originally put the document in the brain; null when no human did
  // (e.g. Slack ingestion) or when history made the creator unrecoverable.
  createdByWorkosId?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type BrainSnapshot = {
  folders: BrainFolderView[];
  documents: BrainDocumentView[];
};

export type BrainMutationResult =
  | { ok: true; path?: string; document?: BrainDocumentView; quotaPaused?: boolean }
  | { ok: false; message: string };

export type ValidatedBrainContent = {
  document: BrainDocument;
  title: string;
  body: string;
  timeline: BrainTimelineEntry[];
  relations: BrainRelation[];
  sources: BrainSource[];
  aliases: string[];
  kind: BrainKind;
  type: BrainEntityType;
  status: BrainStatus;
  contentHash: string;
  sizeBytes: number;
  parseError: string | null;
};

export async function listCurrentUserBrain(): Promise<BrainSnapshot> {
  const context = await currentUser();
  if (!context.activeBrain) return { folders: [], documents: [] };
  return listBrainForBrain(context.activeBrain.id);
}

export async function listBrainForBrain(brainRef: string): Promise<BrainSnapshot> {
  const [rows, folderRows] = await Promise.all([
    listBrainFiles({ brainRef }, { includeInvalid: true }),
    listBrainFolderRows({ brainRef }),
  ]);
  const documents = rows.map(documentViewFromFileRow).sort(compareBrainDocuments);
  return {
    folders: deriveFolderViews(documents, folderRows),
    documents,
  };
}

export async function updateBrainDocumentForUser(input: {
  brainRef: string;
  userWorkosId: string;
  documentId: string;
  body: string;
  expectedContentHash?: string;
}): Promise<BrainMutationResult> {
  const existing = await getBrainFile({
    brainRef: input.brainRef,
    fileId: input.documentId,
  });
  if (!existing) return { ok: false, message: "Brain file not found." };
  const content = replaceBrainFileCompiledTruth({
    content: existing.content,
    compiledTruth: input.body,
    updatedAt: nowIso(),
  });
  const row = await updateBrainFileContent({
    brainRef: input.brainRef,
    userWorkosId: input.userWorkosId,
    fileId: input.documentId,
    content,
    ...(input.expectedContentHash ? { expectedContentHash: input.expectedContentHash } : {}),
  });
  return {
    ok: true,
    path: brainFilePathFor(row.folderPath, row.brainId),
    document: documentViewFromFileRow(row),
  };
}

export async function createBrainDocumentForUser(input: {
  brainRef: string;
  userWorkosId: string;
  folderPath: string;
  fileName: string;
  description?: string;
  compiledTruth?: string;
  brainIdMaxLength?: number;
}): Promise<BrainMutationResult> {
  const folderPath = normalizeBrainFolderForV1(input.folderPath);
  if (!isValidBrainFolder(folderPath)) {
    return { ok: false, message: "Folder paths must be lowercase slugs separated by /." };
  }

  const fileName = input.fileName.trim();
  if (!fileName) return { ok: false, message: "Give the Markdown file a name." };
  if (fileName.includes("/") || fileName.includes("\\")) {
    return { ok: false, message: "File names cannot include a folder path." };
  }
  const title = fileName.replace(/\.md$/i, "").trim();
  if (!title) return { ok: false, message: "Give the Markdown file a name." };
  if (title.length > 160) {
    return { ok: false, message: "File names must be 160 characters or fewer." };
  }

  const brainIdMaxLength = Math.min(80, Math.max(1, input.brainIdMaxLength ?? 80));
  const baseId = normalizeBrainId(title).slice(0, brainIdMaxLength).replace(/-+$/g, "");
  if (!baseId) {
    return { ok: false, message: "File names must contain at least one letter or number." };
  }

  try {
    const rows = await listBrainFiles({ brainRef: input.brainRef }, { includeInvalid: true });
    const used = new Set(rows.map((row) => row.brainId));
    for (let suffix = 1; suffix < 1000; suffix++) {
      const brainId = brainIdCandidate(baseId, suffix, brainIdMaxLength);
      if (used.has(brainId)) continue;
      const path = brainFilePathFor(folderPath, brainId);
      const row = await createBrainMarkdownDocument({
        brainRef: input.brainRef,
        userWorkosId: input.userWorkosId,
        path,
        content: createBrainMarkdownContent({
          id: brainId,
          folderPath,
          title,
          ...(input.description ? { description: input.description } : {}),
          type: "note",
          status: "draft",
          ...(input.compiledTruth ? { compiledTruth: input.compiledTruth } : {}),
        }),
      });
      if (row) return { ok: true, path, document: documentViewFromFileRow(row) };
      used.add(brainId);
    }
    throw new Error("Could not allocate a unique brain id.");
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
}

export async function createBrainSkillForUser(input: {
  brainRef: string;
  userWorkosId: string;
  folderPath: string;
  name: string;
  description?: string;
}): Promise<BrainMutationResult> {
  const folderPath = normalizeBrainFolderForV1(input.folderPath);
  if (!isBrainSkillFolder(folderPath)) {
    return { ok: false, message: 'Skills must live in the "skills" folder.' };
  }
  const invalid = validateBrainSkillFields({
    name: input.name,
    description: input.description ?? "",
  });
  if (invalid) return { ok: false, message: invalid };
  return createBrainDocumentForUser({
    brainRef: input.brainRef,
    userWorkosId: input.userWorkosId,
    folderPath,
    fileName: input.name,
    ...(input.description?.trim() ? { description: input.description.trim() } : {}),
    brainIdMaxLength: 64,
  });
}

export async function updateBrainSkillForUser(input: {
  brainRef: string;
  userWorkosId: string;
  documentId: string;
  name: string;
  description: string;
  instructions: string;
  expectedContentHash?: string;
}): Promise<BrainMutationResult> {
  const invalid = validateBrainSkillFields(input);
  if (invalid) return { ok: false, message: invalid };
  const existing = await getBrainFile({
    brainRef: input.brainRef,
    fileId: input.documentId,
  });
  if (!existing) return { ok: false, message: "Brain skill not found." };
  if (existing.format !== "markdown" || !isBrainSkillFolder(existing.folderPath)) {
    return { ok: false, message: "That Brain document is not a skill." };
  }
  const parsed = parseBrainDocument(existing.content);
  const content = serializeBrainDocument({
    title: input.name.trim(),
    compiledTruth: input.instructions,
    timeline: parsed.timeline,
    frontmatter: {
      id: existing.brainId,
      folder: existing.folderPath,
      kind: "page",
      type: "note",
      status: isValidBrainStatus(parsed.frontmatter.status)
        ? parsed.frontmatter.status
        : existing.status,
      title: input.name.trim(),
      ...(input.description.trim() ? { description: input.description.trim() } : {}),
      createdAt: parsed.frontmatter.createdAt ?? existing.createdAt.toISOString(),
      updatedAt: nowIso(),
      relations: parsed.frontmatter.relations ?? [],
      ...(parsed.frontmatter.aliases ? { aliases: parsed.frontmatter.aliases } : {}),
      ...(parsed.frontmatter.sources ? { sources: parsed.frontmatter.sources } : {}),
      ...(parsed.frontmatter.mergedInto ? { mergedInto: parsed.frontmatter.mergedInto } : {}),
    },
  });
  try {
    const row = await updateBrainFileContent({
      brainRef: input.brainRef,
      userWorkosId: input.userWorkosId,
      fileId: input.documentId,
      content,
      ...(input.expectedContentHash ? { expectedContentHash: input.expectedContentHash } : {}),
    });
    return {
      ok: true,
      path: brainFilePathFor(row.folderPath, row.brainId),
      document: documentViewFromFileRow(row),
    };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
}

export async function createBrainWorkflowForUser(input: {
  brainRef: string;
  userWorkosId: string;
  folderPath: string;
  name: string;
  description?: string;
}): Promise<BrainMutationResult> {
  const folderPath = normalizeBrainFolderForV1(input.folderPath);
  if (!isBrainWorkflowFolder(folderPath)) {
    return { ok: false, message: 'Workflows must live in the "workflows" folder.' };
  }
  const invalid = validateBrainSkillFields({
    name: input.name,
    description: input.description ?? "",
  });
  if (invalid) return { ok: false, message: invalid };
  return createBrainDocumentForUser({
    brainRef: input.brainRef,
    userWorkosId: input.userWorkosId,
    folderPath,
    fileName: input.name,
    ...(input.description?.trim() ? { description: input.description.trim() } : {}),
    brainIdMaxLength: 64,
  });
}

export async function updateBrainWorkflowForUser(input: {
  brainRef: string;
  userWorkosId: string;
  documentId: string;
  name: string;
  description: string;
  instructions: string;
  // Model mention token ("kimi-k2.6", "codex", ...); undefined keeps the stored
  // value, "" clears it back to the default.
  model?: string;
  expectedContentHash?: string;
}): Promise<BrainMutationResult> {
  const invalid = validateBrainSkillFields(input);
  if (invalid) return { ok: false, message: invalid };
  if (input.model?.trim() && !isWorkflowModelToken(input.model.trim())) {
    return { ok: false, message: "That workflow model is not available." };
  }
  const existing = await getBrainFile({
    brainRef: input.brainRef,
    fileId: input.documentId,
  });
  if (!existing) return { ok: false, message: "Brain workflow not found." };
  if (existing.format !== "markdown" || !isBrainWorkflowFolder(existing.folderPath)) {
    return { ok: false, message: "That Brain document is not a workflow." };
  }
  const parsed = parseBrainDocument(existing.content);
  const model = input.model === undefined ? parsed.frontmatter.model : input.model.trim();
  const content = serializeBrainDocument({
    title: input.name.trim(),
    compiledTruth: input.instructions,
    timeline: parsed.timeline,
    frontmatter: {
      id: existing.brainId,
      folder: existing.folderPath,
      kind: "page",
      type: "note",
      status: isValidBrainStatus(parsed.frontmatter.status)
        ? parsed.frontmatter.status
        : existing.status,
      title: input.name.trim(),
      ...(input.description.trim() ? { description: input.description.trim() } : {}),
      ...(model ? { model } : {}),
      createdAt: parsed.frontmatter.createdAt ?? existing.createdAt.toISOString(),
      updatedAt: nowIso(),
      relations: parsed.frontmatter.relations ?? [],
      ...(parsed.frontmatter.aliases ? { aliases: parsed.frontmatter.aliases } : {}),
      ...(parsed.frontmatter.sources ? { sources: parsed.frontmatter.sources } : {}),
      ...(parsed.frontmatter.mergedInto ? { mergedInto: parsed.frontmatter.mergedInto } : {}),
    },
  });
  try {
    const row = await updateBrainFileContent({
      brainRef: input.brainRef,
      userWorkosId: input.userWorkosId,
      fileId: input.documentId,
      content,
      ...(input.expectedContentHash ? { expectedContentHash: input.expectedContentHash } : {}),
    });
    return {
      ok: true,
      path: brainFilePathFor(row.folderPath, row.brainId),
      document: documentViewFromFileRow(row),
    };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
}

export async function renameBrainDocumentForUser(input: {
  brainRef: string;
  userWorkosId: string;
  documentId: string;
  title: string;
}): Promise<BrainMutationResult> {
  const title = input.title.trim();
  if (!title) return { ok: false, message: "Title cannot be empty." };
  const existing = await getBrainFile({
    brainRef: input.brainRef,
    fileId: input.documentId,
  });
  if (!existing) return { ok: false, message: "Brain file not found." };
  const parsed = parseBrainDocument(existing.content);
  const type =
    parsed.frontmatter.type && isBuiltInBrainEntityType(parsed.frontmatter.type)
      ? parsed.frontmatter.type
      : existing.entityType;
  const kind = isValidBrainKind(parsed.frontmatter.kind) ? parsed.frontmatter.kind : existing.kind;
  const content = serializeBrainDocument({
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
      ...(parsed.frontmatter.description ? { description: parsed.frontmatter.description } : {}),
      ...(parsed.frontmatter.sources ? { sources: parsed.frontmatter.sources } : {}),
      ...(parsed.frontmatter.mergedInto ? { mergedInto: parsed.frontmatter.mergedInto } : {}),
    },
  });
  const row = await updateBrainFileContent({
    brainRef: input.brainRef,
    userWorkosId: input.userWorkosId,
    fileId: input.documentId,
    content,
  });
  return {
    ok: true,
    path: brainFilePathFor(row.folderPath, row.brainId),
    document: documentViewFromFileRow(row),
  };
}

export async function moveBrainDocumentForUser(input: {
  brainRef: string;
  userWorkosId: string;
  documentId: string;
  folderPath: string;
}): Promise<BrainMutationResult> {
  const folderPath = normalizeBrainFolderForV1(input.folderPath);
  if (!isValidBrainFolder(folderPath)) {
    return { ok: false, message: "Folder paths must be lowercase slugs separated by /." };
  }
  const existing = await getBrainFile({
    brainRef: input.brainRef,
    fileId: input.documentId,
  });
  if (!existing) return { ok: false, message: "Brain file not found." };
  const parsed = parseBrainDocument(existing.content);
  const type =
    parsed.frontmatter.type && isBuiltInBrainEntityType(parsed.frontmatter.type)
      ? parsed.frontmatter.type
      : existing.entityType;
  const kind = isValidBrainKind(parsed.frontmatter.kind) ? parsed.frontmatter.kind : existing.kind;
  const folderKindError = brainFolderKindError(folderPath, kind);
  if (folderKindError) {
    return {
      ok: false,
      message: `Folder "${folderPath}" does not match kind "${kind}". ${folderKindError}`,
    };
  }
  const content = serializeBrainDocument({
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
      ...(parsed.frontmatter.description ? { description: parsed.frontmatter.description } : {}),
      ...(parsed.frontmatter.sources ? { sources: parsed.frontmatter.sources } : {}),
      ...(parsed.frontmatter.mergedInto ? { mergedInto: parsed.frontmatter.mergedInto } : {}),
    },
  });
  const row = await moveBrainFile({
    brainRef: input.brainRef,
    userWorkosId: input.userWorkosId,
    fileId: input.documentId,
    path: brainFilePathFor(folderPath, existing.brainId),
    content,
  });
  return {
    ok: true,
    path: brainFilePathFor(row.folderPath, row.brainId),
    document: documentViewFromFileRow(row),
  };
}

export async function deleteBrainDocumentForUser(input: {
  brainRef: string;
  userWorkosId: string;
  documentId: string;
}): Promise<BrainMutationResult> {
  await deleteBrainFile({
    brainRef: input.brainRef,
    userWorkosId: input.userWorkosId,
    fileId: input.documentId,
  });
  return { ok: true };
}

export async function createBrainFolderForUser(input: {
  brainRef: string;
  userWorkosId: string;
  folderPath: string;
}): Promise<BrainMutationResult> {
  try {
    await createBrainFolderRow({
      brainRef: input.brainRef,
      userWorkosId: input.userWorkosId,
      path: input.folderPath,
    });
    return { ok: true, path: normalizeBrainFolderForV1(input.folderPath) };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
}

export async function renameBrainFolderForUser(input: {
  brainRef: string;
  userWorkosId: string;
  fromPath: string;
  toPath: string;
}): Promise<BrainMutationResult> {
  try {
    await renameBrainFolderRow({
      brainRef: input.brainRef,
      userWorkosId: input.userWorkosId,
      fromPath: input.fromPath,
      toPath: input.toPath,
    });
    return { ok: true, path: normalizeBrainFolderForV1(input.toPath) };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
}

export async function deleteBrainFolderForUser(input: {
  brainRef: string;
  userWorkosId: string;
  folderPath: string;
}): Promise<BrainMutationResult> {
  try {
    await deleteBrainFolderRow({
      brainRef: input.brainRef,
      userWorkosId: input.userWorkosId,
      path: input.folderPath,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
}

export function validateAndDeriveBrainDocument(source: string): ValidatedBrainContent {
  const parsed = parseBrainDocument(source);
  const id =
    parsed.frontmatter.id && isValidBrainId(parsed.frontmatter.id)
      ? parsed.frontmatter.id
      : "temporary";
  const folder =
    parsed.frontmatter.folder && isValidBrainFolder(parsed.frontmatter.folder)
      ? parsed.frontmatter.folder
      : "inbox";
  const projection = deriveBrainFileProjection({
    path: brainFilePathFor(folder, id),
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
        ...(parsed.frontmatter.description ? { description: parsed.frontmatter.description } : {}),
        ...(parsed.frontmatter.sources ? { sources: parsed.frontmatter.sources } : {}),
        ...(parsed.frontmatter.mergedInto ? { mergedInto: parsed.frontmatter.mergedInto } : {}),
      },
    },
    title: projection.title ?? projection.brainId,
    ...(parsed.frontmatter.description ? { description: parsed.frontmatter.description } : {}),
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

export function documentViewFromFileRow(row: BrainDocumentRow): BrainDocumentView {
  const parsed = parseBrainDocument(row.content);
  const path = brainFilePathFor(row.folderPath, row.brainId);
  return {
    id: row.id,
    brainId: row.brainId,
    folderPath: row.folderPath,
    path,
    title: row.title || parsed.title || row.brainId,
    ...(parsed.frontmatter.description ? { description: parsed.frontmatter.description } : {}),
    content: row.content,
    body: normalizeBrainCompiledTruth(row.body, row.title || parsed.title || row.brainId),
    timeline: parsed.timeline,
    format: row.format,
    mimeType: row.mimeType ?? "text/markdown",
    originalFileName: row.originalFileName,
    assetStorageKey: row.assetStorageKey,
    assetSizeBytes: row.assetSizeBytes,
    relations: parsed.frontmatter.relations ?? [],
    sources: parsed.frontmatter.sources ?? [],
    kind: row.kind,
    type: row.entityType,
    status: row.status,
    aliases: parsed.frontmatter.aliases ?? [],
    contentHash: row.contentHash,
    sizeBytes: row.sizeBytes,
    parseError: null,
    createdByWorkosId: row.createdByWorkosId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function nextAvailableBrainId(brainRef: string, baseId: string): Promise<string> {
  const base = isValidBrainId(baseId) ? baseId : "untitled";
  const rows = await listBrainFiles({ brainRef }, { includeInvalid: true });
  const used = new Set(rows.map((row) => row.brainId));
  if (!used.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix++) {
    const candidate = brainIdCandidate(base, suffix);
    if (!used.has(candidate)) return candidate;
  }
  throw new Error("Could not allocate a unique brain id.");
}

function brainIdCandidate(base: string, suffix: number, maxLength = 80): string {
  if (suffix <= 1) return base;
  const ending = `-${suffix}`;
  const prefix = base.slice(0, maxLength - ending.length).replace(/-+$/g, "");
  return `${prefix || "untitled"}${ending}`;
}

export { hashBrainContent };

function deriveFolderViews(
  documents: BrainDocumentView[],
  folderRows: BrainFolderRow[] = [],
): BrainFolderView[] {
  const now = new Date(0).toISOString();
  const byPath = new Map<string, BrainFolderView>();
  for (const folder of folderRows) {
    byPath.set(folder.path, {
      id: folder.id,
      path: folder.path,
      name: folderName(folder.path),
      source: folder.source,
      createdAt: folder.createdAt.toISOString(),
      updatedAt: folder.updatedAt.toISOString(),
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
        id: existing?.id ?? `folder:${path}`,
        path,
        name: folderName(path),
        source: existing?.source ?? brainFolderSourceForPath(path),
        createdAt: existing?.createdAt ?? document.createdAt,
        updatedAt,
      });
    }
  }
  if (byPath.size === 0) {
    byPath.set("inbox", {
      id: "folder:inbox",
      path: "inbox",
      name: "Inbox",
      source: "system",
      createdAt: now,
      updatedAt: now,
    });
  }
  return [...byPath.values()].sort((a, b) => compareBrainFolderPaths(a.path, b.path));
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

function compareBrainDocuments(a: BrainDocumentView, b: BrainDocumentView) {
  const folder = a.folderPath.localeCompare(b.folderPath);
  if (folder !== 0) return folder;
  return a.title.localeCompare(b.title);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateBrainSkillFields(input: { name: string; description: string }): string | null {
  const name = input.name.trim();
  const description = input.description.trim();
  if (!name) return "Skill name cannot be empty.";
  if (name.length > 160) return "Skill names must be 160 characters or fewer.";
  if (description.length > 1_000) {
    return "Skill descriptions must be 1,000 characters or fewer.";
  }
  if (description.includes("<") || description.includes(">")) {
    return 'Skill descriptions cannot contain "<" or ">".';
  }
  return null;
}

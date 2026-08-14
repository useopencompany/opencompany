import { randomUUID } from "node:crypto";
import { captureProductIngestionQuotaAnalytics } from "@opencompany/analytics/product";
import {
  isBrainSkillFolder,
  isValidBrainFolder,
  normalizeBrainFolderForV1,
  normalizeBrainId,
  normalizeUploadAsset,
  nowIso,
} from "@opencompany/brain";
import {
  brainFilePathFor,
  createBrainAssetDocument,
  replaceBrainAssetFile,
} from "@opencompany/db/brain-files";
import {
  BRAIN_AGENT_INGEST_JOB_KIND,
  upsertBrainSourceItemAndEnqueue,
} from "@opencompany/db/brain-ingest";
import {
  type BrainMutationResult,
  documentViewFromFileRow,
  nextAvailableBrainId,
} from "./brain-files";
import {
  CHAT_SRT_MIME_TYPE,
  normalizedChatAttachmentMediaType,
  validateChatAttachmentCandidate,
} from "./chat-attachment-formats";

export const BRAIN_ASSET_MAX_BYTES = 20 * 1024 * 1024;
// Claude's per-image limit is 5 MB; the ingestion agent sees images natively.
export const BRAIN_ASSET_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

export type BrainAssetFormat =
  | "pdf"
  | "docx"
  | "xlsx"
  | "srt"
  | "csv"
  | "tsv"
  | "json"
  | "text"
  | "image";

const CONTENT_TYPE_FORMATS: Record<string, BrainAssetFormat> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  [CHAT_SRT_MIME_TYPE]: "srt",
  "text/csv": "csv",
  "text/tab-separated-values": "tsv",
  "application/json": "json",
  "text/markdown": "text",
  "text/plain": "text",
  "image/png": "image",
  "image/jpeg": "image",
  "image/webp": "image",
};

export const BRAIN_ASSET_CONTENT_TYPES = Object.keys(CONTENT_TYPE_FORMATS);

export function brainAssetUploadPrefix(brainRef: string): string {
  return `goat-brain/${brainRef}/assets/`;
}

export type BrainAssetUploadInput = {
  folderPath: string;
  blobUrl: string;
  originalFileName: string;
  mimeType: string;
  sizeBytes: number;
  // sha256 hex of the uploaded bytes. Canonical API callers compute this at
  // the server boundary; the ingestion worker independently verifies it.
  contentSha256: string;
};

export async function createBrainAssetForUser(
  input: BrainAssetUploadInput & {
    brainRef: string;
    userWorkosId: string;
  },
  options: { db?: any; documentId?: string } = {},
): Promise<BrainMutationResult> {
  const validated = validateAssetUpload(input.brainRef, input);
  if (!validated.ok) return validated;

  const folderPath = normalizeBrainFolderForV1(input.folderPath);
  if (!isValidBrainFolder(folderPath)) {
    return { ok: false, message: "Folder paths must be lowercase slugs separated by /." };
  }
  if (isBrainSkillFolder(folderPath)) {
    return { ok: false, message: "Skills are Markdown-only and cannot contain uploads." };
  }

  const fileName = input.originalFileName.trim() || "upload";
  const title = fileName.replace(/\.[a-z0-9]+$/i, "").trim() || fileName;
  const baseId = normalizeBrainId(title) || "upload";
  const brainId = await nextAvailableBrainId(input.brainRef, baseId, {
    ...(options.db ? { db: options.db } : {}),
  });
  const documentId = options.documentId ?? `goat_brain_doc_${randomUUID()}`;

  const row = await createBrainAssetDocument(
    {
      brainRef: input.brainRef,
      userWorkosId: input.userWorkosId,
      id: documentId,
      brainId,
      folderPath,
      title,
      format: validated.format,
      mimeType: validated.mediaType,
      originalFileName: fileName,
      assetStorageKey: input.blobUrl,
      assetSizeBytes: input.sizeBytes,
      assetContentHash: input.contentSha256,
      sourceRef: `upload:${documentId}`,
    },
    options.db ? { db: options.db } : {},
  );

  const ingest = await enqueueAssetIngest({
    brainRef: input.brainRef,
    userWorkosId: input.userWorkosId,
    documentId,
    brainId,
    folderPath,
    format: validated.format,
    mimeType: validated.mediaType,
    originalFileName: fileName,
    sizeBytes: input.sizeBytes,
    contentSha256: input.contentSha256,
    ...(options.db ? { db: options.db } : {}),
  });

  return {
    ok: true,
    path: brainFilePathFor(row.folderPath, row.brainId),
    document: documentViewFromFileRow(row),
    quotaPaused: Boolean(ingest.paused),
  };
}

export async function replaceBrainAssetForUser(
  input: BrainAssetUploadInput & {
    brainRef: string;
    userWorkosId: string;
    documentId: string;
    expectedAssetContentHash?: string | null;
    expectedAssetStorageKey?: string;
  },
  options: {
    db?: any;
    cleanupReplacedBlob?: (storageKey: string) => Promise<void>;
  } = {},
): Promise<BrainMutationResult> {
  const validated = validateAssetUpload(input.brainRef, input);
  if (!validated.ok) return validated;

  const fileName = input.originalFileName.trim() || "upload";
  let row: Awaited<ReturnType<typeof replaceBrainAssetFile>>;
  try {
    row = await replaceBrainAssetFile(
      {
        brainRef: input.brainRef,
        userWorkosId: input.userWorkosId,
        fileId: input.documentId,
        mimeType: validated.mediaType,
        originalFileName: fileName,
        assetStorageKey: input.blobUrl,
        assetSizeBytes: input.sizeBytes,
        assetContentHash: input.contentSha256,
        ...(input.expectedAssetContentHash !== undefined
          ? { expectedAssetContentHash: input.expectedAssetContentHash }
          : {}),
        ...(input.expectedAssetStorageKey
          ? { expectedAssetStorageKey: input.expectedAssetStorageKey }
          : {}),
      },
      {
        ...(options.db ? { db: options.db } : {}),
        ...(options.cleanupReplacedBlob
          ? { cleanupReplacedBlob: options.cleanupReplacedBlob }
          : {}),
      },
    );
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Replace failed." };
  }

  const ingest = await enqueueAssetIngest({
    brainRef: input.brainRef,
    userWorkosId: input.userWorkosId,
    documentId: row.id,
    brainId: row.brainId,
    folderPath: row.folderPath,
    format: validated.format,
    mimeType: validated.mediaType,
    originalFileName: fileName,
    sizeBytes: input.sizeBytes,
    contentSha256: input.contentSha256,
    ...(options.db ? { db: options.db } : {}),
  });

  return {
    ok: true,
    path: brainFilePathFor(row.folderPath, row.brainId),
    document: documentViewFromFileRow(row),
    quotaPaused: Boolean(ingest.paused),
  };
}

function validateAssetUpload(
  brainRef: string,
  input: BrainAssetUploadInput,
): { ok: true; format: BrainAssetFormat; mediaType: string } | { ok: false; message: string } {
  const candidate = validateBrainAssetFile({
    originalFileName: input.originalFileName,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
  });
  if (!candidate.ok) return candidate;
  let pathname: string;
  try {
    pathname = new URL(input.blobUrl).pathname.replace(/^\/+/, "");
  } catch {
    return { ok: false, message: "Upload URL is invalid." };
  }
  // The upload route only mints tokens for this brain's prefix; re-checking
  // here stops a crafted action call from attaching someone else's blob.
  if (!pathname.startsWith(brainAssetUploadPrefix(brainRef))) {
    return { ok: false, message: "Upload does not belong to this brain." };
  }
  return candidate;
}

export function validateBrainAssetFile(input: {
  originalFileName: string;
  mimeType: string;
  sizeBytes: number;
}): { ok: true; format: BrainAssetFormat; mediaType: string } | { ok: false; message: string } {
  const mediaType = normalizedChatAttachmentMediaType({
    mediaType: input.mimeType,
    filename: input.originalFileName,
  });
  const candidate = validateChatAttachmentCandidate({
    mediaType,
    filename: input.originalFileName,
    sizeBytes: input.sizeBytes,
  });
  if (!candidate.ok) return { ok: false, message: candidate.message };
  const format = CONTENT_TYPE_FORMATS[mediaType];
  if (!format) {
    return {
      ok: false,
      message:
        "Supported uploads: PDF, Word (.docx), Excel (.xlsx), CSV, TSV, Markdown, text, JSON, SRT, PNG, JPEG, WebP.",
    };
  }
  if (!Number.isFinite(input.sizeBytes) || input.sizeBytes <= 0) {
    return { ok: false, message: "Upload size is invalid." };
  }
  if (input.sizeBytes > BRAIN_ASSET_MAX_BYTES) {
    return { ok: false, message: "Uploads are limited to 20 MB." };
  }
  if (format === "image" && input.sizeBytes > BRAIN_ASSET_IMAGE_MAX_BYTES) {
    return { ok: false, message: "Images are limited to 5 MB." };
  }
  return { ok: true, format, mediaType };
}

export function validateBrainAssetFolderPath(
  value: string,
): { ok: true; folderPath: string } | { ok: false; message: string } {
  const folderPath = normalizeBrainFolderForV1(value);
  if (!isValidBrainFolder(folderPath)) {
    return { ok: false, message: "Folder paths must be lowercase slugs separated by /." };
  }
  if (isBrainSkillFolder(folderPath)) {
    return { ok: false, message: "Skills cannot contain file uploads." };
  }
  return { ok: true, folderPath };
}

async function enqueueAssetIngest(input: {
  brainRef: string;
  userWorkosId: string;
  documentId: string;
  brainId: string;
  folderPath: string;
  format: string;
  mimeType: string;
  originalFileName: string;
  sizeBytes: number;
  contentSha256: string;
  db?: any;
}) {
  const item = normalizeUploadAsset({
    documentId: input.documentId,
    brainId: input.brainId,
    folderPath: input.folderPath,
    format: input.format,
    mimeType: input.mimeType,
    originalFileName: input.originalFileName,
    sizeBytes: input.sizeBytes,
    contentSha256: input.contentSha256,
    uploadedAt: nowIso(),
  });
  const result = await upsertBrainSourceItemAndEnqueue({
    userWorkosId: input.userWorkosId,
    sourceConnectionId: input.brainRef,
    item,
    rawPayload: item.contentHashInput,
    kind: BRAIN_AGENT_INGEST_JOB_KIND,
    brainRefs: [input.brainRef],
    ...(input.db ? { db: input.db } : {}),
  });
  captureProductIngestionQuotaAnalytics(result.quotaUpdates);
  return result;
}

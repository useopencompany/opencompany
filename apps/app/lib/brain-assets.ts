import { randomUUID } from "node:crypto";
import { captureIngestionQuotaAnalytics } from "@opencompany/analytics/app";
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
  GOAT_BRAIN_AGENT_INGEST_JOB_KIND,
  upsertBrainSourceItemAndEnqueue,
} from "@opencompany/db/brain-ingest";
import {
  type BrainMutationResult,
  documentViewFromFileRow,
  nextAvailableBrainId,
} from "@/lib/brain";
import {
  GOAT_CHAT_SRT_MIME_TYPE,
  normalizedChatAttachmentMediaType,
  validateChatAttachmentCandidate,
} from "@/lib/chat-attachment-formats";

export const GOAT_BRAIN_ASSET_MAX_BYTES = 20 * 1024 * 1024;
// Claude's per-image limit is 5 MB; the ingestion agent sees images natively.
export const GOAT_BRAIN_ASSET_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

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
  [GOAT_CHAT_SRT_MIME_TYPE]: "srt",
  "text/csv": "csv",
  "text/tab-separated-values": "tsv",
  "application/json": "json",
  "text/markdown": "text",
  "text/plain": "text",
  "image/png": "image",
  "image/jpeg": "image",
  "image/webp": "image",
};

export const GOAT_BRAIN_ASSET_CONTENT_TYPES = Object.keys(CONTENT_TYPE_FORMATS);

export function brainAssetUploadPrefix(brainRef: string): string {
  return `goat-brain/${brainRef}/assets/`;
}

export type BrainAssetUploadInput = {
  folderPath: string;
  blobUrl: string;
  originalFileName: string;
  mimeType: string;
  sizeBytes: number;
  // sha256 hex of the uploaded bytes, computed client-side; the ingestion
  // worker recomputes it from the blob and stores the authoritative value.
  contentSha256: string;
};

export async function createBrainAssetForUser(
  input: BrainAssetUploadInput & {
    brainRef: string;
    userWorkosId: string;
  },
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
  const brainId = await nextAvailableBrainId(input.brainRef, baseId);
  const documentId = `goat_brain_doc_${randomUUID()}`;

  const row = await createBrainAssetDocument({
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
    sourceRef: `upload:${documentId}`,
  });

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
  },
): Promise<BrainMutationResult> {
  const validated = validateAssetUpload(input.brainRef, input);
  if (!validated.ok) return validated;

  const fileName = input.originalFileName.trim() || "upload";
  let row: Awaited<ReturnType<typeof replaceBrainAssetFile>>;
  try {
    row = await replaceBrainAssetFile({
      brainRef: input.brainRef,
      userWorkosId: input.userWorkosId,
      fileId: input.documentId,
      mimeType: validated.mediaType,
      originalFileName: fileName,
      assetStorageKey: input.blobUrl,
      assetSizeBytes: input.sizeBytes,
    });
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
  if (input.sizeBytes > GOAT_BRAIN_ASSET_MAX_BYTES) {
    return { ok: false, message: "Uploads are limited to 20 MB." };
  }
  if (format === "image" && input.sizeBytes > GOAT_BRAIN_ASSET_IMAGE_MAX_BYTES) {
    return { ok: false, message: "Images are limited to 5 MB." };
  }
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
  return { ok: true, format, mediaType };
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
    kind: GOAT_BRAIN_AGENT_INGEST_JOB_KIND,
    brainRefs: [input.brainRef],
  });
  captureIngestionQuotaAnalytics(result.quotaUpdates);
  return result;
}

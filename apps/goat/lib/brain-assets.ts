import { randomUUID } from "node:crypto";
import { captureGoatIngestionQuotaAnalytics } from "@opencompany/analytics/goat";
import {
  createGoatBrainAssetDocument,
  goatBrainFilePathFor,
  replaceGoatBrainAssetFile,
} from "@opencompany/db/goat-brain-files";
import {
  GOAT_BRAIN_AGENT_INGEST_JOB_KIND,
  upsertGoatBrainSourceItemAndEnqueue,
} from "@opencompany/db/goat-brain-ingest";
import {
  isGoatBrainSkillFolder,
  isValidGoatBrainFolder,
  normalizeGoatBrainFolderForV1,
  normalizeGoatBrainId,
  normalizeUploadAsset,
  nowIso,
} from "@opencompany/goat-brain";
import {
  type BrainMutationResult,
  documentViewFromFileRow,
  nextAvailableGoatBrainId,
} from "@/lib/brain";

export const GOAT_BRAIN_ASSET_MAX_BYTES = 20 * 1024 * 1024;
// Claude's per-image limit is 5 MB; the ingestion agent sees images natively.
export const GOAT_BRAIN_ASSET_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

export type GoatBrainAssetFormat = "pdf" | "docx" | "xlsx" | "image";

const CONTENT_TYPE_FORMATS: Record<string, GoatBrainAssetFormat> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "image/png": "image",
  "image/jpeg": "image",
  "image/webp": "image",
};

export const GOAT_BRAIN_ASSET_CONTENT_TYPES = Object.keys(CONTENT_TYPE_FORMATS);

export function goatBrainAssetUploadPrefix(brainRef: string): string {
  return `goat-brain/${brainRef}/assets/`;
}

export type GoatBrainAssetUploadInput = {
  folderPath: string;
  blobUrl: string;
  originalFileName: string;
  mimeType: string;
  sizeBytes: number;
  // sha256 hex of the uploaded bytes, computed client-side; the ingestion
  // worker recomputes it from the blob and stores the authoritative value.
  contentSha256: string;
};

export async function createGoatBrainAssetForUser(
  input: GoatBrainAssetUploadInput & {
    brainRef: string;
    userWorkosId: string;
  },
): Promise<BrainMutationResult> {
  const validated = validateAssetUpload(input.brainRef, input);
  if (!validated.ok) return validated;

  const folderPath = normalizeGoatBrainFolderForV1(input.folderPath);
  if (!isValidGoatBrainFolder(folderPath)) {
    return { ok: false, message: "Folder paths must be lowercase slugs separated by /." };
  }
  if (isGoatBrainSkillFolder(folderPath)) {
    return { ok: false, message: "Skills are Markdown-only and cannot contain uploads." };
  }

  const fileName = input.originalFileName.trim() || "upload";
  const title = fileName.replace(/\.[a-z0-9]+$/i, "").trim() || fileName;
  const baseId = normalizeGoatBrainId(title) || "upload";
  const brainId = await nextAvailableGoatBrainId(input.brainRef, baseId);
  const documentId = `goat_brain_doc_${randomUUID()}`;

  const row = await createGoatBrainAssetDocument({
    brainRef: input.brainRef,
    userWorkosId: input.userWorkosId,
    id: documentId,
    brainId,
    folderPath,
    title,
    format: validated.format,
    mimeType: input.mimeType,
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
    mimeType: input.mimeType,
    originalFileName: fileName,
    sizeBytes: input.sizeBytes,
    contentSha256: input.contentSha256,
  });

  return {
    ok: true,
    path: goatBrainFilePathFor(row.folderPath, row.brainId),
    document: documentViewFromFileRow(row),
    quotaPaused: Boolean(ingest.paused),
  };
}

export async function replaceGoatBrainAssetForUser(
  input: GoatBrainAssetUploadInput & {
    brainRef: string;
    userWorkosId: string;
    documentId: string;
  },
): Promise<BrainMutationResult> {
  const validated = validateAssetUpload(input.brainRef, input);
  if (!validated.ok) return validated;

  const fileName = input.originalFileName.trim() || "upload";
  let row: Awaited<ReturnType<typeof replaceGoatBrainAssetFile>>;
  try {
    row = await replaceGoatBrainAssetFile({
      brainRef: input.brainRef,
      userWorkosId: input.userWorkosId,
      fileId: input.documentId,
      mimeType: input.mimeType,
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
    mimeType: input.mimeType,
    originalFileName: fileName,
    sizeBytes: input.sizeBytes,
    contentSha256: input.contentSha256,
  });

  return {
    ok: true,
    path: goatBrainFilePathFor(row.folderPath, row.brainId),
    document: documentViewFromFileRow(row),
    quotaPaused: Boolean(ingest.paused),
  };
}

function validateAssetUpload(
  brainRef: string,
  input: GoatBrainAssetUploadInput,
): { ok: true; format: GoatBrainAssetFormat } | { ok: false; message: string } {
  const format = CONTENT_TYPE_FORMATS[input.mimeType];
  if (!format) {
    return {
      ok: false,
      message: "Supported uploads: PDF, Word (.docx), Excel (.xlsx), PNG, JPEG, WebP.",
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
  if (!pathname.startsWith(goatBrainAssetUploadPrefix(brainRef))) {
    return { ok: false, message: "Upload does not belong to this brain." };
  }
  return { ok: true, format };
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
  const result = await upsertGoatBrainSourceItemAndEnqueue({
    userWorkosId: input.userWorkosId,
    sourceConnectionId: input.brainRef,
    item,
    rawPayload: item.contentHashInput,
    kind: GOAT_BRAIN_AGENT_INGEST_JOB_KIND,
    brainRefs: [input.brainRef],
  });
  captureGoatIngestionQuotaAnalytics(result.quotaUpdates);
  return result;
}

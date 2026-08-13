export type GoatChatAttachmentKind =
  | "image"
  | "pdf"
  | "docx"
  | "xlsx"
  | "srt"
  | "csv"
  | "tsv"
  | "json"
  | "text";

export type GoatChatMessageAttachment = {
  id: string;
  kind: GoatChatAttachmentKind;
  mediaType: string;
  filename: string;
  sizeBytes: number;
  blobPathname: string;
  blobUrl: string;
};

// Isomorphic (client + server) constants for Goat chat attachments. The core
// set matches what the brain asset pipeline can ingest: pdf, docx, xlsx, SRT,
// still images, and text-like founder artifacts such as CSV exports, Markdown,
// plain text, and JSON. No legacy .doc/.xls or gif (animated frames collapse).
export const GOAT_CHAT_SRT_MIME_TYPE = "application/x-subrip";
export const GOAT_CHAT_TSV_MIME_TYPE = "text/tab-separated-values";

export const GOAT_CHAT_ATTACHMENT_MIME_KINDS: Record<string, GoatChatAttachmentKind> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  [GOAT_CHAT_SRT_MIME_TYPE]: "srt",
  "application/srt": "srt",
  "text/srt": "srt",
  "text/csv": "csv",
  [GOAT_CHAT_TSV_MIME_TYPE]: "tsv",
  "application/json": "json",
  "text/markdown": "text",
  "text/plain": "text",
  "image/png": "image",
  "image/jpeg": "image",
  "image/webp": "image",
};

export const GOAT_CHAT_ATTACHMENT_CONTENT_TYPES = Object.keys(GOAT_CHAT_ATTACHMENT_MIME_KINDS);

export const GOAT_CHAT_ATTACHMENT_ACCEPT = [
  ...GOAT_CHAT_ATTACHMENT_CONTENT_TYPES,
  ".pdf",
  ".docx",
  ".xlsx",
  ".srt",
  ".csv",
  ".tsv",
  ".md",
  ".markdown",
  ".txt",
  ".json",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
].join(",");

export const GOAT_CHAT_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
// Claude's per-image request limit is 5 MB; reject rather than downscale (v1).
export const GOAT_CHAT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const GOAT_CHAT_ATTACHMENT_MAX_PER_MESSAGE = 5;

export function goatChatAttachmentKindForMime(mediaType: string): GoatChatAttachmentKind | null {
  return GOAT_CHAT_ATTACHMENT_MIME_KINDS[normalizedMimeType(mediaType)] ?? null;
}

export type GoatChatAttachmentValidation =
  | { ok: true; kind: GoatChatAttachmentKind; mediaType: string }
  | { ok: false; reason: "type" | "size"; message: string };

export function validateGoatChatAttachmentCandidate(input: {
  mediaType: string;
  filename?: string;
  sizeBytes: number;
}): GoatChatAttachmentValidation {
  const mediaType = normalizedGoatChatAttachmentMediaType(input);
  const kind = goatChatAttachmentKindForMime(mediaType);
  if (!kind) {
    return {
      ok: false,
      reason: "type",
      message:
        "Supported files: PDF, Word (.docx), Excel (.xlsx), CSV, TSV, Markdown, text, JSON, SRT, PNG, JPEG, WebP.",
    };
  }
  // Unlike the binary formats, SRT has no registered media type that browsers
  // agree on. Require its extension as the stable part of the contract.
  if (kind === "srt" && !isSrtFilename(input.filename)) {
    return {
      ok: false,
      reason: "type",
      message: "Subtitle files must use the .srt extension.",
    };
  }
  if (!Number.isFinite(input.sizeBytes) || input.sizeBytes <= 0) {
    return { ok: false, reason: "size", message: "File is empty or its size is unknown." };
  }
  const maxBytes = kind === "image" ? GOAT_CHAT_IMAGE_MAX_BYTES : GOAT_CHAT_ATTACHMENT_MAX_BYTES;
  if (input.sizeBytes > maxBytes) {
    return {
      ok: false,
      reason: "size",
      message: kind === "image" ? "Images are limited to 5 MB." : "Files are limited to 20 MB.",
    };
  }
  return { ok: true, kind, mediaType };
}

export function normalizedGoatChatAttachmentMediaType(input: {
  mediaType: string;
  filename?: string;
}): string {
  const mediaType = normalizedMimeType(input.mediaType);
  const extension = extensionOf(input.filename);
  if (
    extension === "srt" &&
    (!mediaType ||
      mediaType === "application/octet-stream" ||
      mediaType === "text/plain" ||
      goatChatAttachmentKindForMime(mediaType) === "srt")
  ) {
    return GOAT_CHAT_SRT_MIME_TYPE;
  }
  if (shouldTrustExtension(mediaType)) {
    if (extension === "csv") return "text/csv";
    if (extension === "tsv") return GOAT_CHAT_TSV_MIME_TYPE;
    if (extension === "md" || extension === "markdown") return "text/markdown";
    if (extension === "txt") return "text/plain";
    if (extension === "json") return "application/json";
  }
  return mediaType;
}

function normalizedMimeType(mediaType: string): string {
  return mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function isSrtFilename(filename: string | undefined): boolean {
  return filename?.trim().toLowerCase().endsWith(".srt") ?? false;
}

function extensionOf(filename: string | undefined): string {
  const trimmed = filename?.trim().toLowerCase();
  if (!trimmed) return "";
  const dot = trimmed.lastIndexOf(".");
  return dot >= 0 ? trimmed.slice(dot + 1) : "";
}

function shouldTrustExtension(mediaType: string): boolean {
  return (
    !mediaType ||
    mediaType === "application/octet-stream" ||
    mediaType === "text/plain" ||
    mediaType === "application/vnd.ms-excel"
  );
}

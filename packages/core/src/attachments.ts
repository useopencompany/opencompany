import type { MessageAttachment } from "./chat";

export const CHAT_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
export const CHAT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const CHAT_ATTACHMENTS_PER_MESSAGE = 5;
export const CHAT_ATTACHMENT_UPLOAD_TTL_MS = 24 * 60 * 60 * 1_000;

export const CHAT_ATTACHMENT_FORMATS = [
  "pdf",
  "docx",
  "xlsx",
  "srt",
  "csv",
  "tsv",
  "json",
  "text",
  "image",
] as const;
export type ChatAttachmentFormat = (typeof CHAT_ATTACHMENT_FORMATS)[number];

const MIME_FORMATS: Readonly<Record<string, ChatAttachmentFormat>> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/x-subrip": "srt",
  "application/srt": "srt",
  "text/srt": "srt",
  "text/csv": "csv",
  "text/tab-separated-values": "tsv",
  "application/json": "json",
  "text/markdown": "text",
  "text/plain": "text",
  "image/png": "image",
  "image/jpeg": "image",
  "image/webp": "image",
};

export const CHAT_ATTACHMENT_MEDIA_TYPES = Object.freeze(Object.keys(MIME_FORMATS));

export type ChatAttachmentValidation =
  | {
      ok: true;
      format: ChatAttachmentFormat;
      kind: MessageAttachment["kind"];
      mediaType: string;
    }
  | { ok: false; code: "unsupported_type" | "invalid_size"; message: string };

export function validateChatAttachment(input: {
  filename?: string;
  mediaType: string;
  sizeBytes: number;
}): ChatAttachmentValidation {
  const mediaType = normalizeChatAttachmentMediaType(input);
  const format = MIME_FORMATS[mediaType];
  if (!format) {
    return {
      ok: false,
      code: "unsupported_type",
      message:
        "Supported files: PDF, Word (.docx), Excel (.xlsx), CSV, TSV, Markdown, text, JSON, SRT, PNG, JPEG, WebP.",
    };
  }
  if (format === "srt" && !input.filename?.trim().toLowerCase().endsWith(".srt")) {
    return {
      ok: false,
      code: "unsupported_type",
      message: "Subtitle files must use the .srt extension.",
    };
  }
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0) {
    return {
      ok: false,
      code: "invalid_size",
      message: "File is empty or its size is unknown.",
    };
  }
  const maxBytes = format === "image" ? CHAT_IMAGE_MAX_BYTES : CHAT_ATTACHMENT_MAX_BYTES;
  if (input.sizeBytes > maxBytes) {
    return {
      ok: false,
      code: "invalid_size",
      message: format === "image" ? "Images are limited to 5 MB." : "Files are limited to 20 MB.",
    };
  }
  return {
    ok: true,
    format,
    kind: format === "image" ? "image" : "document",
    mediaType,
  };
}

function normalizeChatAttachmentMediaType(input: { filename?: string; mediaType: string }) {
  const mediaType = input.mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const filename = input.filename?.trim().toLowerCase() ?? "";
  const dot = filename.lastIndexOf(".");
  const extension = dot >= 0 ? filename.slice(dot + 1) : "";
  if (
    extension === "srt" &&
    (!mediaType || mediaType === "application/octet-stream" || mediaType === "text/plain")
  ) {
    return "application/x-subrip";
  }
  if (
    !mediaType ||
    mediaType === "application/octet-stream" ||
    mediaType === "text/plain" ||
    mediaType === "application/vnd.ms-excel"
  ) {
    if (extension === "csv") return "text/csv";
    if (extension === "tsv") return "text/tab-separated-values";
    if (extension === "md" || extension === "markdown") return "text/markdown";
    if (extension === "txt") return "text/plain";
    if (extension === "json") return "application/json";
  }
  return mediaType;
}

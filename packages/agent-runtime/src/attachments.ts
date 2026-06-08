import { AGENT_MODEL_CATALOG } from "./models";

export type AttachmentKind = "image" | "pdf" | "text";

export const ATTACHMENT_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export const ATTACHMENT_PDF_MIME_TYPES = ["application/pdf"] as const;

export const ATTACHMENT_TEXT_MIME_TYPES = [
  "text/plain",
  "text/markdown",
  "text/html",
  "text/csv",
  "text/tab-separated-values",
  "application/json",
  "application/xml",
  "text/xml",
  "text/css",
  "text/yaml",
  "application/x-yaml",
  "application/toml",
] as const;

// Code/config files: browsers report octet-stream/empty MIME, so detect by extension.
export const ATTACHMENT_TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "html",
  "htm",
  "csv",
  "tsv",
  "json",
  "jsonc",
  "xml",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "log",
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "swift",
  "c",
  "h",
  "cpp",
  "cc",
  "hpp",
  "cs",
  "php",
  "sh",
  "bash",
  "zsh",
  "sql",
  "css",
  "scss",
  "sass",
  "less",
]);

export const ALLOWED_ATTACHMENT_MIME_TYPES = [
  ...ATTACHMENT_IMAGE_MIME_TYPES,
  ...ATTACHMENT_PDF_MIME_TYPES,
] as const;

// The upload route accepts a broad set: code files arrive as octet-stream (or with an
// empty/odd MIME) and are classified by extension at validation time, so the token must
// not reject them up front.
export const ATTACHMENT_UPLOAD_CONTENT_TYPES = [
  ...ATTACHMENT_IMAGE_MIME_TYPES,
  ...ATTACHMENT_PDF_MIME_TYPES,
  ...ATTACHMENT_TEXT_MIME_TYPES,
  "application/octet-stream",
] as const;

export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024; // images/pdf: 25 MB per file
export const ATTACHMENT_TEXT_MAX_BYTES = 2 * 1024 * 1024; // text: 2 MB (inlined → guards model context)
export const ATTACHMENT_MAX_PER_MESSAGE = 10;

function extensionOf(filename?: string): string {
  if (!filename) return "";
  const dot = filename.lastIndexOf(".");
  if (dot < 0 || dot === filename.length - 1) return "";
  return filename.slice(dot + 1).toLowerCase();
}

export function attachmentKindForMime(mediaType: string, filename?: string): AttachmentKind | null {
  if ((ATTACHMENT_IMAGE_MIME_TYPES as readonly string[]).includes(mediaType)) return "image";
  if ((ATTACHMENT_PDF_MIME_TYPES as readonly string[]).includes(mediaType)) return "pdf";
  if (
    (ATTACHMENT_TEXT_MIME_TYPES as readonly string[]).includes(mediaType) ||
    ATTACHMENT_TEXT_EXTENSIONS.has(extensionOf(filename))
  ) {
    return "text";
  }
  return null;
}

export function isAllowedAttachmentMime(mediaType: string): boolean {
  return (ALLOWED_ATTACHMENT_MIME_TYPES as readonly string[]).includes(mediaType);
}

export type AttachmentValidation =
  | { ok: true; kind: AttachmentKind }
  | { ok: false; reason: "type" | "size" };

export function validateAttachmentCandidate(input: {
  mediaType: string;
  sizeBytes: number;
  filename?: string;
}): AttachmentValidation {
  const kind = attachmentKindForMime(input.mediaType, input.filename);
  if (!kind) return { ok: false, reason: "type" };
  const maxBytes = kind === "text" ? ATTACHMENT_TEXT_MAX_BYTES : ATTACHMENT_MAX_BYTES;
  if (input.sizeBytes > maxBytes || input.sizeBytes <= 0) {
    return { ok: false, reason: "size" };
  }
  return { ok: true, kind };
}

export function modelSupportsAttachments(modelId: string): { images: boolean; pdf: boolean } {
  const model = AGENT_MODEL_CATALOG.find((entry) => entry.id === modelId);
  return { images: Boolean(model?.supportsImages), pdf: Boolean(model?.supportsPdf) };
}

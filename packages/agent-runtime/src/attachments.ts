import { AGENT_MODEL_CATALOG } from "./models";

export type AttachmentKind = "image" | "pdf";

export const ATTACHMENT_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export const ATTACHMENT_PDF_MIME_TYPES = ["application/pdf"] as const;

export const ALLOWED_ATTACHMENT_MIME_TYPES = [
  ...ATTACHMENT_IMAGE_MIME_TYPES,
  ...ATTACHMENT_PDF_MIME_TYPES,
] as const;

export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024; // 25 MB per file
export const ATTACHMENT_MAX_PER_MESSAGE = 10;

export function attachmentKindForMime(mediaType: string): AttachmentKind | null {
  if ((ATTACHMENT_IMAGE_MIME_TYPES as readonly string[]).includes(mediaType)) return "image";
  if ((ATTACHMENT_PDF_MIME_TYPES as readonly string[]).includes(mediaType)) return "pdf";
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
}): AttachmentValidation {
  const kind = attachmentKindForMime(input.mediaType);
  if (!kind) return { ok: false, reason: "type" };
  if (input.sizeBytes > ATTACHMENT_MAX_BYTES || input.sizeBytes <= 0) {
    return { ok: false, reason: "size" };
  }
  return { ok: true, kind };
}

export function modelSupportsAttachments(modelId: string): { images: boolean; pdf: boolean } {
  const model = AGENT_MODEL_CATALOG.find((entry) => entry.id === modelId);
  return { images: Boolean(model?.supportsImages), pdf: Boolean(model?.supportsPdf) };
}

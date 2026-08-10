import { upload } from "@vercel/blob/client";
import {
  GOAT_CHAT_ATTACHMENT_ACCEPT,
  normalizedGoatChatAttachmentMediaType,
  validateGoatChatAttachmentCandidate,
} from "@/lib/chat-attachment-formats";

// Client-side half of the brain asset upload: the browser uploads directly to
// the private Blob store (token minted by /api/brain-assets/upload), then the
// caller registers the document via uploadGoatBrainAssetAction. Limits mirror
// the server-side checks in lib/brain-assets.ts; the accepted set is the same
// core set the chat composer takes.
export const BRAIN_ASSET_ACCEPT = GOAT_CHAT_ATTACHMENT_ACCEPT;
export const BRAIN_ASSET_MAX_BYTES = 20 * 1024 * 1024;

export function validateBrainAssetFile(file: File): string | null {
  if (file.size === 0) return "That file is empty.";
  const validation = validateGoatChatAttachmentCandidate({
    mediaType: file.type,
    filename: file.name,
    sizeBytes: file.size,
  });
  return validation.ok ? null : validation.message;
}

export async function uploadBrainAssetBlob(
  brainRef: string,
  file: File,
): Promise<{ blobUrl: string; contentSha256: string; mediaType: string }> {
  const mediaType = normalizedGoatChatAttachmentMediaType({
    mediaType: file.type,
    filename: file.name,
  });
  const [contentSha256, blob] = await Promise.all([
    sha256Hex(file),
    upload(`goat-brain/${brainRef}/assets/${file.name}`, file, {
      access: "private",
      handleUploadUrl: "/api/brain-assets/upload",
      contentType: mediaType,
    }),
  ]);
  return { blobUrl: blob.url, contentSha256, mediaType };
}

async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

import { upload } from "@vercel/blob/client";

// Client-side half of the brain asset upload: the browser uploads directly to
// the private Blob store (token minted by /api/brain-assets/upload), then the
// caller registers the document via uploadGoatBrainAssetAction. Limits mirror
// the server-side checks in lib/brain-assets.ts.
export const BRAIN_ASSET_ACCEPT = "application/pdf";
export const BRAIN_ASSET_MAX_BYTES = 20 * 1024 * 1024;

export function validateBrainAssetFile(file: File): string | null {
  if (file.type !== "application/pdf") return "Only PDF uploads are supported right now.";
  if (file.size > BRAIN_ASSET_MAX_BYTES) return "Uploads are limited to 20 MB.";
  if (file.size === 0) return "That file is empty.";
  return null;
}

export async function uploadBrainAssetBlob(
  brainRef: string,
  file: File,
): Promise<{ blobUrl: string; contentSha256: string }> {
  const [contentSha256, blob] = await Promise.all([
    sha256Hex(file),
    upload(`goat-brain/${brainRef}/assets/${file.name}`, file, {
      access: "private",
      handleUploadUrl: "/api/brain-assets/upload",
      contentType: file.type,
    }),
  ]);
  return { blobUrl: blob.url, contentSha256 };
}

async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

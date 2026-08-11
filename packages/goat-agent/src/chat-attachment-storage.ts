import { get, put } from "@vercel/blob";
import { goatBrainAssetUploadPrefix } from "./brain-assets";

export async function downloadGoatChatAttachment(blobUrl: string): Promise<Buffer> {
  const result = await get(blobUrl, { access: "private", useCache: false });
  if (!result || result.statusCode !== 200 || !result.stream) {
    throw new Error("Attachment blob is unavailable.");
  }
  const chunks: Uint8Array[] = [];
  const reader = result.stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export function copyGoatChatAttachmentToBrain(input: {
  brainRef: string;
  filename: string;
  bytes: Buffer;
  mediaType: string;
}) {
  return put(`${goatBrainAssetUploadPrefix(input.brainRef)}${input.filename}`, input.bytes, {
    access: "private",
    addRandomSuffix: true,
    contentType: input.mediaType,
  });
}

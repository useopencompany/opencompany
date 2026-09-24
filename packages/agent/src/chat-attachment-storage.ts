import { get } from "@vercel/blob";

export async function downloadChatAttachment(
  blobUrl: string,
  options: { signal?: AbortSignal } = {},
): Promise<Buffer> {
  const result = await get(blobUrl, {
    access: "private",
    useCache: false,
    ...(options.signal ? { abortSignal: options.signal } : {}),
  });
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

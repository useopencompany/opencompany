import { get } from "@vercel/blob";

// Downloads goat chat attachment bytes so a turn can materialize them inside the sandbox.
export async function downloadBlobBytes(
  blobUrl: string,
  blobToken: string | undefined,
): Promise<Buffer> {
  // The blobs are stored in a PRIVATE Vercel Blob store, so the bytes require authentication.
  // @vercel/blob@2.4.0 exposes get(urlOrPathname, { access: 'private', token }) which returns
  // a ReadableStream + metadata; the token defaults to BLOB_READ_WRITE_TOKEN but we pass it
  // explicitly so the runner env wins. useCache:false fetches straight from origin storage.
  const result = await get(blobUrl, {
    access: "private",
    useCache: false,
    // The token defaults to process.env.BLOB_READ_WRITE_TOKEN; only override when the runner
    // env actually carries one (exactOptionalPropertyTypes forbids passing `undefined`).
    ...(blobToken ? { token: blobToken } : {}),
  });
  if (!result || result.statusCode !== 200 || !result.stream) {
    throw new Error(`Failed to download private blob: ${blobUrl}`);
  }

  return readStreamToBuffer(result.stream);
}

async function readStreamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks);
}

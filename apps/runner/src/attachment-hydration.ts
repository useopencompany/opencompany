import type { PooledDb } from "@opencompany/db/pool";
import { agentSessionMessageAttachments } from "@opencompany/db/schema";
import { get } from "@vercel/blob";
import { inArray } from "drizzle-orm";
import type { ReplayAttachment, StoredSessionMessageForModelReplay } from "./model-messages";

// Hydrates user-message attachments by downloading their bytes from the (private) Vercel
// Blob store and base64-encoding them so buildModelMessages can inline image/file parts.
//
// Why this lives in the loader path and not in buildModelMessages: the model-message builder
// is pure (no I/O) and is unit-tested in isolation. Downloading blobs is the loader's job —
// it batches the attachment-row query and downloads each blob once per run, then attaches the
// bytes to the matching stored message before the (possibly repeated) replay.
export async function hydrateMessageAttachments(
  messages: StoredSessionMessageForModelReplay[],
  options: { db: PooledDb; blobToken: string | undefined },
): Promise<StoredSessionMessageForModelReplay[]> {
  const userMessageIds = messages
    .filter((message) => message.role === "user" && typeof message.id === "string")
    .map((message) => message.id as string);

  if (userMessageIds.length === 0) return messages;

  const rows = await options.db
    .select()
    .from(agentSessionMessageAttachments)
    .where(inArray(agentSessionMessageAttachments.messageId, userMessageIds));

  if (rows.length === 0) return messages;

  // Cache downloads by blobUrl so a message that is replayed across multiple turns (or two
  // attachments pointing at the same blob) only pulls the bytes from the store once per run.
  const base64ByBlobUrl = new Map<string, Promise<string>>();
  const downloadBase64 = (blobUrl: string): Promise<string> => {
    const cached = base64ByBlobUrl.get(blobUrl);
    if (cached) return cached;
    const pending = downloadBlobAsBase64(blobUrl, options.blobToken);
    base64ByBlobUrl.set(blobUrl, pending);
    return pending;
  };

  const attachmentsByMessageId = new Map<string, ReplayAttachment[]>();
  await Promise.all(
    rows.map(async (row) => {
      const base64 = await downloadBase64(row.blobUrl);
      const attachment: ReplayAttachment = {
        kind: row.kind,
        mediaType: row.mediaType,
        filename: row.filename,
        base64,
        blobPathname: row.blobPathname,
      };
      const existing = attachmentsByMessageId.get(row.messageId);
      if (existing) {
        existing.push(attachment);
      } else {
        attachmentsByMessageId.set(row.messageId, [attachment]);
      }
    }),
  );

  return messages.map((message) => {
    const attachments = message.id ? attachmentsByMessageId.get(message.id) : undefined;
    return attachments ? { ...message, attachments } : message;
  });
}

async function downloadBlobAsBase64(
  blobUrl: string,
  blobToken: string | undefined,
): Promise<string> {
  const bytes = await downloadBlobBytes(blobUrl, blobToken);
  return bytes.toString("base64");
}

// Also used by the sandbox materializer (attachment-materialize.ts) to write above-threshold
// text attachments into the workspace.
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

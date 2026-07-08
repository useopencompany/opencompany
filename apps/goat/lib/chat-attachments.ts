import {
  ATTACHMENT_TEXT_INLINE_MAX_BYTES,
  ATTACHMENT_TEXT_PREVIEW_CHARS,
  attachmentSandboxPath,
} from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import { goatMessageAttachments } from "@opencompany/db/goat-schema";
import { get } from "@vercel/blob";
import { and, eq, inArray } from "drizzle-orm";
import type { GoatChatUiMessage } from "@/lib/chat-ui";

type HydratedAttachment = {
  id: string;
  kind: "image" | "pdf" | "text";
  mediaType: string;
  filename: string;
  sizeBytes: number;
  blobPathname: string;
  base64: string;
};

export async function hydrateGoatChatAttachmentsForModel(input: {
  messages: readonly GoatChatUiMessage[];
  userWorkosId: string;
  blobToken?: string | undefined;
}): Promise<GoatChatUiMessage[]> {
  const attachmentIds = input.messages.flatMap((message) =>
    message.role === "user" ? (message.metadata?.attachments ?? []).map((att) => att.id) : [],
  );
  if (attachmentIds.length === 0) return [...input.messages];

  const rows = await getDb()
    .select({
      id: goatMessageAttachments.id,
      kind: goatMessageAttachments.kind,
      mediaType: goatMessageAttachments.mediaType,
      filename: goatMessageAttachments.filename,
      sizeBytes: goatMessageAttachments.sizeBytes,
      blobPathname: goatMessageAttachments.blobPathname,
      blobUrl: goatMessageAttachments.blobUrl,
    })
    .from(goatMessageAttachments)
    .where(
      and(
        eq(goatMessageAttachments.userWorkosId, input.userWorkosId),
        inArray(goatMessageAttachments.id, attachmentIds),
      ),
    );
  if (rows.length === 0) return [...input.messages];

  const base64ByBlobUrl = new Map<string, Promise<string>>();
  const downloadBase64 = (blobUrl: string) => {
    const cached = base64ByBlobUrl.get(blobUrl);
    if (cached) return cached;
    const pending = downloadBlobAsBase64(blobUrl, input.blobToken);
    base64ByBlobUrl.set(blobUrl, pending);
    return pending;
  };
  const hydratedById = new Map<string, HydratedAttachment>();
  await Promise.all(
    rows.map(async (row) => {
      hydratedById.set(row.id, {
        id: row.id,
        kind: row.kind,
        mediaType: row.mediaType,
        filename: row.filename,
        sizeBytes: row.sizeBytes,
        blobPathname: row.blobPathname,
        base64: await downloadBase64(row.blobUrl),
      });
    }),
  );

  return input.messages.map((message) => {
    if (message.role !== "user") return message;
    const attachments = message.metadata?.attachments ?? [];
    if (attachments.length === 0) return message;

    const parts = [...message.parts] as GoatChatUiMessage["parts"];
    for (const attachment of attachments) {
      const hydrated = hydratedById.get(attachment.id);
      if (!hydrated) continue;
      parts.push(...attachmentModelParts(hydrated));
    }
    return { ...message, parts };
  });
}

async function downloadBlobAsBase64(
  blobUrl: string,
  blobToken: string | undefined,
): Promise<string> {
  const result = await get(blobUrl, {
    access: "private",
    useCache: false,
    ...(blobToken ? { token: blobToken } : {}),
  });
  if (!result || result.statusCode !== 200 || !result.stream) {
    throw new Error("Could not read attachment bytes.");
  }
  const bytes = await readStreamToBuffer(result.stream);
  return bytes.toString("base64");
}

function attachmentModelParts(attachment: HydratedAttachment): GoatChatUiMessage["parts"] {
  if (attachment.kind === "text") {
    const bytes = Buffer.from(attachment.base64, "base64");
    if (bytes.byteLength <= ATTACHMENT_TEXT_INLINE_MAX_BYTES) {
      return [
        {
          type: "text",
          text: `\n\nAttached file "${attachment.filename}":\n\n${bytes.toString("utf8")}`,
        },
      ] as GoatChatUiMessage["parts"];
    }
    const text = bytes.toString("utf8");
    const preview = text.slice(0, ATTACHMENT_TEXT_PREVIEW_CHARS);
    return [
      {
        type: "text",
        text: [
          `\n\nAttached file "${attachment.filename}" (${Math.round(bytes.byteLength / 1024)} KB) is too large to inline.`,
          `If this becomes a task, the full content will be available at ${attachmentSandboxPath(attachment.blobPathname)} in the task sandbox.`,
          `Preview (first ${preview.length} characters):\n\n${preview}`,
        ].join("\n"),
      },
    ] as GoatChatUiMessage["parts"];
  }

  return [
    {
      type: "file",
      mediaType: attachment.mediaType,
      filename: attachment.filename,
      url: `data:${attachment.mediaType};base64,${attachment.base64}`,
    },
  ] as unknown as GoatChatUiMessage["parts"];
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

import { randomUUID } from "node:crypto";
import { modelSupportsAttachments } from "@opencompany/agent-runtime";
import type { ChatMessageAttachment } from "@opencompany/db/schema";
import { extractDocxText, extractUtf8Text, extractXlsxText } from "@opencompany/file-extract";
import { get } from "@vercel/blob";
import {
  GOAT_CHAT_ATTACHMENT_MAX_PER_MESSAGE,
  validateChatAttachmentCandidate,
} from "@/lib/chat-attachment-formats";
import type { ChatUiMessage, StoredChatMessage } from "@/lib/chat-ui";

// Extracted text shown to the chat model; matches the brain capture cap so a
// save_to_brain of the same content never silently exceeds it.
const CHAT_ATTACHMENT_TEXT_MAX_BYTES = 64_000;
const MAX_FILENAME_LENGTH = 200;

export function chatAttachmentBlobPrefix(userWorkosId: string): string {
  return `goat-chat/${userWorkosId}/`;
}

// Server-side re-validation of client-submitted attachment metadata. The blob
// pathname prefix check is the forged-ref guard: the upload route only mints
// tokens under the caller's own prefix, so re-checking here stops a crafted
// request from attaching someone else's blob. Ids are re-minted server-side.
export function parseChatAttachmentsInput(
  value: unknown,
  userWorkosId: string,
): { ok: true; attachments: ChatMessageAttachment[] } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, attachments: [] };
  if (!Array.isArray(value)) return { ok: false, error: "Invalid attachments." };
  if (value.length > GOAT_CHAT_ATTACHMENT_MAX_PER_MESSAGE) {
    return {
      ok: false,
      error: `Messages can include at most ${GOAT_CHAT_ATTACHMENT_MAX_PER_MESSAGE} attachments.`,
    };
  }

  const prefix = chatAttachmentBlobPrefix(userWorkosId);
  const attachments: ChatMessageAttachment[] = [];
  const seenBlobUrls = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return { ok: false, error: "Invalid attachment." };
    const record = entry as Record<string, unknown>;
    const mediaType = typeof record.mediaType === "string" ? record.mediaType : "";
    const sizeBytes = typeof record.sizeBytes === "number" ? record.sizeBytes : Number.NaN;
    const blobUrl = typeof record.blobUrl === "string" ? record.blobUrl : "";
    const filenameRaw = typeof record.filename === "string" ? record.filename.trim() : "";
    const filename = (filenameRaw || "upload").slice(0, MAX_FILENAME_LENGTH);

    const validation = validateChatAttachmentCandidate({ mediaType, filename, sizeBytes });
    if (!validation.ok) return { ok: false, error: validation.message };

    let pathname: string;
    try {
      pathname = new URL(blobUrl).pathname.replace(/^\/+/, "");
    } catch {
      return { ok: false, error: "Attachment upload URL is invalid." };
    }
    if (!pathname.startsWith(prefix)) {
      return { ok: false, error: "Attachment does not belong to this account." };
    }
    if (seenBlobUrls.has(blobUrl)) continue;
    seenBlobUrls.add(blobUrl);

    attachments.push({
      id: `goat_chat_att_${randomUUID()}`,
      kind: validation.kind,
      mediaType: validation.mediaType,
      filename,
      sizeBytes,
      blobPathname: pathname,
      blobUrl,
    });
  }
  return { ok: true, attachments };
}

// Runs at submit time so extractable file content is visible to the model on this
// and every later turn without re-extraction. Failures degrade to "no text"
// (the model still sees the filename) rather than blocking the send.
export async function extractChatAttachmentTexts(
  attachments: readonly ChatMessageAttachment[],
): Promise<Record<string, string> | null> {
  const texts: Record<string, string> = {};
  for (const attachment of attachments) {
    if (!isTextExtractableChatAttachment(attachment)) continue;
    try {
      const bytes = await downloadChatAttachment(attachment.blobUrl);
      const text =
        attachment.kind === "docx"
          ? await extractDocxText(bytes, { maxBytes: CHAT_ATTACHMENT_TEXT_MAX_BYTES })
          : attachment.kind === "xlsx"
            ? await extractXlsxText(bytes, { maxBytes: CHAT_ATTACHMENT_TEXT_MAX_BYTES })
            : extractUtf8Text(bytes, { maxBytes: CHAT_ATTACHMENT_TEXT_MAX_BYTES });
      if (text) texts[attachment.id] = text;
    } catch (error) {
      console.warn("Goat chat attachment text extraction failed.", {
        event: "goat.chat_attachment_extraction_failed",
        kind: attachment.kind,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return Object.keys(texts).length > 0 ? texts : null;
}

export async function downloadChatAttachment(blobUrl: string): Promise<Buffer> {
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

// Appends attachment parts to every user message before convertToModelMessages:
// pdf/images as data-URL file parts (the blob store is private, so provider-
// fetchable URLs don't exist), extractable files as extracted-text parts. Replayed on
// every turn — follow-up questions about a file are the core use case; caps
// bound the cost. Each part carries the attachment id so the model can pass it
// to save_to_brain.
export async function hydrateChatAttachmentParts(input: {
  uiMessages: ChatUiMessage[];
  storedMessages: readonly Pick<
    StoredChatMessage,
    "id" | "role" | "attachments" | "attachmentTexts"
  >[];
  modelId: string;
}): Promise<ChatUiMessage[]> {
  const storedById = new Map(
    input.storedMessages
      .filter((message) => message.role === "user" && (message.attachments?.length ?? 0) > 0)
      .map((message) => [message.id, message]),
  );
  if (storedById.size === 0) return input.uiMessages;

  const capabilities = modelSupportsAttachments(input.modelId);
  return Promise.all(
    input.uiMessages.map(async (message) => {
      const stored = message.role === "user" ? storedById.get(message.id) : undefined;
      if (!stored?.attachments?.length) return message;

      const parts: ChatUiMessage["parts"] = [...message.parts];
      for (const attachment of stored.attachments) {
        parts.push(...(await attachmentToParts(attachment, stored, capabilities)));
      }
      return { ...message, parts };
    }),
  );
}

async function attachmentToParts(
  attachment: ChatMessageAttachment,
  stored: Pick<StoredChatMessage, "attachmentTexts">,
  capabilities: { images: boolean; pdf: boolean },
): Promise<ChatUiMessage["parts"]> {
  const label = attachmentLabel(attachment);

  if (isTextExtractableChatAttachment(attachment)) {
    const text = stored.attachmentTexts?.[attachment.id];
    return [
      {
        type: "text",
        text: text
          ? `${label}\n\n${text}`
          : `${label} — no text could be extracted from this file.`,
      },
    ];
  }

  const supported = attachment.kind === "image" ? capabilities.images : capabilities.pdf;
  if (!supported) {
    return [{ type: "text", text: `${label} — not viewable with the current model.` }];
  }

  try {
    const bytes = await downloadChatAttachment(attachment.blobUrl);
    return [
      { type: "text", text: label },
      {
        type: "file",
        mediaType: attachment.mediaType,
        filename: attachment.filename,
        url: `data:${attachment.mediaType};base64,${bytes.toString("base64")}`,
      },
    ];
  } catch (error) {
    console.warn("Goat chat attachment hydration failed.", {
      event: "goat.chat_attachment_hydration_failed",
      kind: attachment.kind,
      error: error instanceof Error ? error.message : String(error),
    });
    return [{ type: "text", text: `${label} — the file could not be loaded.` }];
  }
}

function attachmentLabel(attachment: ChatMessageAttachment): string {
  return `[Attached file "${attachment.filename}" (${attachment.kind}) — attachment id: ${attachment.id}]`;
}

export function isTextExtractableChatAttachment(
  attachment: Pick<ChatMessageAttachment, "kind">,
): boolean {
  return (
    attachment.kind === "docx" ||
    attachment.kind === "xlsx" ||
    attachment.kind === "srt" ||
    attachment.kind === "csv" ||
    attachment.kind === "tsv" ||
    attachment.kind === "json" ||
    attachment.kind === "text"
  );
}

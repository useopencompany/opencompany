import { newPastedAttachmentId } from "@opencompany/agent-runtime";
import type {
  MessagePastedAttachment,
  MessagePastedAttachmentMeta,
} from "@opencompany/db/schema";

// A large paste from the composer, sent alongside the message text. The client captures
// the raw text; the server turns it into a durable attachment written to a file in the
// session workspace by the runner.
export type PromptAttachmentInput = {
  label: string;
  content: string;
};

// Caps mirror the brain-file ethos (bounded blobs in Postgres). Enforced server-side —
// client limits are advisory.
export const MAX_ATTACHMENT_BYTES = 256 * 1024; // 256 KB per file
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
export const MAX_ATTACHMENTS_TOTAL_BYTES = 1024 * 1024; // 1 MB across one message

function byteLength(value: string) {
  return Buffer.byteLength(value, "utf8");
}

function lineCount(value: string) {
  if (value.length === 0) return 0;
  return value.split("\n").length;
}

// Filenames are deterministic per (message, index) so the runner can re-materialize them
// idempotently across sandbox recycles. They live under `pasted/` so they stay out of the
// repo working tree (the runner adds `pasted/` to work/.gitignore).
function attachmentFilename(messageId: string, index: number) {
  return `pasted/${messageId}-${index}.txt`;
}

export function normalizePromptAttachments(
  attachments: PromptAttachmentInput[] | undefined,
): PromptAttachmentInput[] {
  if (!attachments) return [];
  return attachments
    .map((attachment) => ({
      label: typeof attachment.label === "string" ? attachment.label : "",
      content: typeof attachment.content === "string" ? attachment.content : "",
    }))
    .filter((attachment) => attachment.content.length > 0);
}

export function validatePromptAttachments(
  attachments: PromptAttachmentInput[],
): { ok: true } | { ok: false; error: string } {
  if (attachments.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    return {
      ok: false,
      error: `Too many attachments — up to ${MAX_ATTACHMENTS_PER_MESSAGE} per message.`,
    } as const;
  }
  let total = 0;
  for (const attachment of attachments) {
    const bytes = byteLength(attachment.content);
    if (bytes > MAX_ATTACHMENT_BYTES) {
      return {
        ok: false,
        error: `An attachment is too large — the limit is ${Math.floor(MAX_ATTACHMENT_BYTES / 1024)} KB.`,
      } as const;
    }
    total += bytes;
  }
  if (total > MAX_ATTACHMENTS_TOTAL_BYTES) {
    return {
      ok: false,
      error: `Attachments are too large — the combined limit is ${Math.floor(MAX_ATTACHMENTS_TOTAL_BYTES / 1024)} KB.`,
    } as const;
  }
  return { ok: true } as const;
}

// Assign each attachment its durable identity (deterministic filename + measured size).
export function buildMessageAttachments(
  messageId: string,
  attachments: PromptAttachmentInput[],
): MessagePastedAttachment[] {
  return attachments.map((attachment, index) => ({
    id: newPastedAttachmentId(),
    filename: attachmentFilename(messageId, index),
    label: attachment.label || `pasted-${index + 1}.txt`,
    bytes: byteLength(attachment.content),
    lineCount: lineCount(attachment.content),
    content: attachment.content,
  }));
}

// The plain-text block appended to the model message. Path-only by design: the agent
// reads the file rather than receiving the blob inline. Sizes give a chat-only agent
// (no sandbox) a minimal floor of signal.
export function buildAttachmentReferenceBlock(attachments: MessagePastedAttachment[]): string {
  if (attachments.length === 0) return "";
  const lines = attachments.map(
    (attachment) =>
      `- work/${attachment.filename} (${attachment.lineCount.toLocaleString()} lines, ${attachment.bytes.toLocaleString()} bytes)`,
  );
  return `[The user attached pasted text as files in the working directory. Read them as needed:\n${lines.join("\n")}]`;
}

// What the model replays for a user message: the typed text plus the reference block.
export function buildModelMessageContent(
  text: string,
  attachments: MessagePastedAttachment[],
): string {
  const block = buildAttachmentReferenceBlock(attachments);
  if (!block) return text;
  return text ? `${text}\n\n${block}` : block;
}

// Strip the (potentially large) content before exposing attachments to the client / stream.
export function toAttachmentMeta(
  attachments: MessagePastedAttachment[] | null | undefined,
): MessagePastedAttachmentMeta[] {
  return (attachments ?? []).map((attachment) => ({
    id: attachment.id,
    filename: attachment.filename,
    label: attachment.label,
    bytes: attachment.bytes,
    lineCount: attachment.lineCount,
  }));
}

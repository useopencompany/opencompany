import {
  ATTACHMENT_SANDBOX_DIR,
  ATTACHMENT_TEXT_INLINE_MAX_BYTES,
  ATTACHMENT_TEXT_PREVIEW_CHARS,
  attachmentSandboxFilename,
  attachmentSandboxPath,
  shellQuote,
} from "@opencompany/agent-runtime";
import { goatMessageAttachments } from "@opencompany/db/goat-schema";
import type { UserModelMessage } from "ai";
import { and, asc, eq } from "drizzle-orm";
import { downloadBlobBytes } from "./attachment-hydration";
import { getDb } from "./db";
import { type SandboxHandle } from "./sandbox";

type GoatTaskAttachmentRow = {
  id: string;
  kind: "image" | "pdf" | "text";
  mediaType: string;
  filename: string;
  sizeBytes: number;
  blobPathname: string;
  blobUrl: string;
};
type GoatUserContentPart = Extract<UserModelMessage["content"], unknown[]>[number];

export type GoatMaterializedAttachment = {
  id: string;
  kind: "image" | "pdf" | "text";
  mediaType: string;
  filename: string;
  sizeBytes: number;
  relativePath: string;
};

export async function buildGoatTaskUserModelMessage(input: {
  taskId: string;
  userWorkosId: string;
  prompt: string;
  blobToken: string | undefined;
}): Promise<UserModelMessage> {
  const rows = await loadGoatTaskAttachments({
    taskId: input.taskId,
    userWorkosId: input.userWorkosId,
  });
  if (rows.length === 0) return { role: "user", content: input.prompt };

  const parts: GoatUserContentPart[] = [];
  if (input.prompt.trim()) parts.push({ type: "text", text: input.prompt });
  for (const row of rows) {
    const bytes = await downloadBlobBytes(row.blobUrl, input.blobToken);
    const base64 = bytes.toString("base64");
    if (row.kind === "image") {
      parts.push({ type: "image", image: base64, mediaType: row.mediaType });
    } else if (row.kind === "pdf") {
      parts.push({
        type: "file",
        data: base64,
        mediaType: row.mediaType,
        filename: row.filename,
      });
    } else if (bytes.byteLength <= ATTACHMENT_TEXT_INLINE_MAX_BYTES) {
      parts.push({
        type: "text",
        text: `\n\nAttached file "${row.filename}":\n\n${bytes.toString("utf8")}`,
      });
    } else {
      parts.push({
        type: "text",
        text: largeTextAttachmentPreview(row, bytes),
      });
    }
  }

  return { role: "user", content: parts as UserModelMessage["content"] };
}

export async function materializeGoatTaskAttachmentsForCodex(input: {
  sandbox: SandboxHandle;
  taskId: string;
  userWorkosId: string;
  workdir: string;
  blobToken: string | undefined;
}): Promise<GoatMaterializedAttachment[]> {
  const rows = await loadGoatTaskAttachments({
    taskId: input.taskId,
    userWorkosId: input.userWorkosId,
  });
  if (rows.length === 0) return [];

  const dir = `${input.workdir}/${ATTACHMENT_SANDBOX_DIR}`;
  await input.sandbox.commands.run(
    `mkdir -p ${shellQuote(dir)} && printf '*\\n' > ${shellQuote(`${dir}/.gitignore`)}`,
    { timeoutMs: 30_000 },
  );

  const materialized: GoatMaterializedAttachment[] = [];
  for (const row of rows) {
    const filename = attachmentSandboxFilename(row.blobPathname);
    const relativePath = `${ATTACHMENT_SANDBOX_DIR}/${filename}`;
    const bytes = await downloadBlobBytes(row.blobUrl, input.blobToken);
    const data = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(data).set(bytes);
    await input.sandbox.files.write(`${input.workdir}/${relativePath}`, data);
    materialized.push({
      id: row.id,
      kind: row.kind,
      mediaType: row.mediaType,
      filename: row.filename,
      sizeBytes: row.sizeBytes,
      relativePath,
    });
  }

  return materialized;
}

export function formatGoatTaskAttachmentManifest(
  attachments: readonly GoatMaterializedAttachment[],
) {
  if (attachments.length === 0) return null;
  return [
    "<attachments>",
    "The user attached these files. They have already been copied into the sandbox workspace. Inspect them from disk when relevant; do not commit them.",
    ...attachments.map(
      (attachment, index) =>
        `${index + 1}. ${attachment.filename} (${attachment.mediaType}, ${formatBytes(attachment.sizeBytes)}, ${attachment.kind}) -> ${attachment.relativePath}`,
    ),
    "</attachments>",
  ].join("\n");
}

async function loadGoatTaskAttachments(input: {
  taskId: string;
  userWorkosId: string;
}): Promise<GoatTaskAttachmentRow[]> {
  return getDb()
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
        eq(goatMessageAttachments.taskId, input.taskId),
        eq(goatMessageAttachments.userWorkosId, input.userWorkosId),
      ),
    )
    .orderBy(asc(goatMessageAttachments.createdAt));
}

function largeTextAttachmentPreview(row: GoatTaskAttachmentRow, bytes: Buffer) {
  const text = bytes.toString("utf8");
  const preview = text.slice(0, ATTACHMENT_TEXT_PREVIEW_CHARS);
  return [
    `\n\nAttached file "${row.filename}" (${Math.round(bytes.byteLength / 1024)} KB) is too large to inline.`,
    `If a sandbox file tool is available, the full content is at ${attachmentSandboxPath(row.blobPathname)}.`,
    `Preview (first ${preview.length} characters):\n\n${preview}`,
  ].join("\n");
}

function formatBytes(sizeBytes: number) {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${Math.round(sizeBytes / 1024)} KB`;
  return `${(sizeBytes / 1024 / 1024).toFixed(1)} MB`;
}

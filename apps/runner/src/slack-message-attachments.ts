import { createHash } from "node:crypto";
import type { SlackAgentFile } from "@opencompany/agent/integrations/slack-agent";
import {
  type Actor,
  CHAT_ATTACHMENT_UPLOAD_TTL_MS,
  CHAT_ATTACHMENTS_PER_MESSAGE,
  CHAT_IMAGE_MAX_BYTES,
  validateChatAttachment,
} from "@opencompany/core";
import {
  type ChatSqlExecute,
  PostgresChatAttachmentRepository,
} from "@opencompany/db/chat-repository";
import { put } from "@vercel/blob";

type AttachmentRepository = Pick<PostgresChatAttachmentRepository, "create">;

type Dependencies = {
  fetch: typeof fetch;
  repository: (execute: ChatSqlExecute) => AttachmentRepository;
  store: (input: {
    pathname: string;
    bytes: Buffer;
    mediaType: string;
  }) => Promise<{ pathname: string; url: string }>;
};

const defaults: Dependencies = {
  fetch,
  repository: (execute) => new PostgresChatAttachmentRepository(execute),
  async store(input) {
    const stored = await put(input.pathname, input.bytes, {
      access: "private",
      allowOverwrite: true,
      contentType: input.mediaType,
    });
    return { pathname: stored.pathname, url: stored.url };
  },
};

export type SlackImageAttachmentMaterializer = typeof materializeSlackImageAttachments;

export async function materializeSlackImageAttachments(
  input: {
    execute: ChatSqlExecute;
    actor: Actor;
    token: string;
    messageKey: string;
    files: readonly SlackAgentFile[];
  },
  dependencies: Dependencies = defaults,
): Promise<string[]> {
  const attachmentIds: string[] = [];
  const repository = dependencies.repository(input.execute);
  for (const file of input.files.slice(0, CHAT_ATTACHMENTS_PER_MESSAGE)) {
    const validation = validateChatAttachment({
      filename: file.name,
      mediaType: file.mediaType,
      sizeBytes: file.sizeBytes,
    });
    if (!validation.ok || validation.format !== "image") continue;
    const url = trustedSlackFileUrl(file.urlPrivateDownload);
    const response = await dependencies.fetch(url, {
      headers: { Authorization: `Bearer ${input.token}` },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Slack image download failed with HTTP ${response.status}.`);
    const bytes = await readBoundedBody(response, CHAT_IMAGE_MAX_BYTES);
    if (bytes.byteLength !== file.sizeBytes) {
      throw new Error("Slack image size did not match its signed event metadata.");
    }
    const digest = createHash("sha256")
      .update(`${input.messageKey}\0${file.id}`)
      .digest("hex")
      .slice(0, 32);
    const attachmentId = `attachment_slack_${digest}`;
    const stored = await dependencies.store({
      pathname: `goat-chat-v1/${input.actor.userId}/${attachmentId}/content`,
      bytes,
      mediaType: validation.mediaType,
    });
    const created = await repository.create({
      actor: input.actor,
      id: attachmentId,
      format: "image",
      mediaType: validation.mediaType,
      filename: file.name,
      sizeBytes: bytes.byteLength,
      blobPathname: stored.pathname,
      blobUrl: stored.url,
      extractedText: null,
      expiresAt: new Date(Date.now() + CHAT_ATTACHMENT_UPLOAD_TTL_MS),
    });
    if (!created) throw new Error("Slack image could not be attached to this workspace.");
    attachmentIds.push(attachmentId);
  }
  return attachmentIds;
}

function trustedSlackFileUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "files.slack.com") {
    throw new Error("Slack returned an invalid private file URL.");
  }
  return url;
}

async function readBoundedBody(response: Response, maxBytes: number) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("Slack image exceeded the attachment size limit.");
  }
  if (!response.body) throw new Error("Slack image download returned no content.");
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Slack image exceeded the attachment size limit.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

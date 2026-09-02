"use client";

import { createApiClient } from "@opencompany/protocol";
import { createHeadlessChatApiFetch, headlessChatApiBaseUrl } from "./headless-chat-api";

export async function uploadHeadlessChatAttachment(
  input: { file: File; pendingId: string },
  options: { baseUrl?: string; fetch?: typeof globalThis.fetch } = {},
) {
  const baseUrl = options.baseUrl ?? headlessChatApiBaseUrl();
  const client = createApiClient(baseUrl, {
    fetch: createHeadlessChatApiFetch({
      baseUrl,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }),
  });
  const response = await client.v1.attachments.$post({
    header: { "idempotency-key": `web-chat-attachment:${input.pendingId}` },
    form: { file: input.file },
  });
  if (!response.ok) throw await headlessChatResponseError(response);
  const envelope = await response.json();
  return { id: envelope.data.attachment.id };
}

async function headlessChatResponseError(response: Response) {
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: unknown; requestId?: unknown };
  } | null;
  const message = typeof body?.error?.message === "string" ? body.error.message : null;
  const requestId = typeof body?.error?.requestId === "string" ? body.error.requestId : null;
  return new Error(
    `${message ?? `The attachment upload failed with HTTP ${response.status}.`}${
      requestId ? ` (request ${requestId})` : ""
    }`,
  );
}

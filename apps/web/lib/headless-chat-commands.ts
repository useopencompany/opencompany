"use client";

import { createOpenCompanyClient, type UpdateConversationBody } from "@opencompany/protocol";
import { createHeadlessChatApiFetch, headlessChatApiBaseUrl } from "./headless-chat-api";
import { awaitHeadlessConversationTransaction } from "./headless-chat-collections";

export async function updateHeadlessChatConversation(
  conversationId: string,
  command: UpdateConversationBody,
  options: { baseUrl?: string; fetch?: typeof globalThis.fetch } = {},
) {
  const baseUrl = options.baseUrl ?? headlessChatApiBaseUrl();
  const client = createOpenCompanyClient(baseUrl, {
    fetch: createHeadlessChatApiFetch({
      baseUrl,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }),
  });
  const response = await client.v1.conversations[":conversationId"].$patch({
    param: { conversationId },
    json: command,
  });
  if (!response.ok) throw await responseError(response);
  const data = (await response.json()).data;
  await awaitHeadlessConversationTransaction(data.transactionId);
  return data;
}

async function responseError(response: Response) {
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: unknown; requestId?: unknown };
  } | null;
  const message = typeof body?.error?.message === "string" ? body.error.message : null;
  const requestId = typeof body?.error?.requestId === "string" ? body.error.requestId : null;
  return new Error(
    `${message ?? `The Conversation update failed with HTTP ${response.status}.`}${
      requestId ? ` (request ${requestId})` : ""
    }`,
  );
}

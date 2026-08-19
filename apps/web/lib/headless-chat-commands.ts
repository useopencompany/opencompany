"use client";

import {
  createApiClient,
  type EngineRuntimeAccess,
  type EngineRuntimeStatus,
  type UpdateConversationBody,
} from "@opencompany/protocol";
import { createHeadlessChatApiFetch, headlessChatApiBaseUrl } from "./headless-chat-api";
import { awaitHeadlessConversationTransaction } from "./headless-chat-collections";
import { reconcileCommittedProjection } from "./headless-collection-reconciliation";

export async function updateHeadlessChatConversation(
  conversationId: string,
  command: UpdateConversationBody,
  options: { baseUrl?: string; fetch?: typeof globalThis.fetch } = {},
) {
  const baseUrl = options.baseUrl ?? headlessChatApiBaseUrl();
  const client = createApiClient(baseUrl, {
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
  await reconcileCommittedProjection(awaitHeadlessConversationTransaction(data.transactionId));
  return data;
}

export async function resolveEngineQuestions(
  runId: string,
  approvalId: string,
  answers: Record<string, { answers: string[] }>,
  options: { baseUrl?: string; fetch?: typeof globalThis.fetch } = {},
) {
  const client = clientFor(options);
  const response = await client.v1.runs[":runId"].approvals[":approvalId"].$post({
    param: { runId, approvalId },
    json: {
      resolution: "answered",
      answer: { type: "engine_questions", schemaVersion: 1, answers },
    },
  });
  if (!response.ok) throw await responseError(response);
  return (await response.json()).data;
}

export async function cancelHeadlessChatRun(
  runId: string,
  options: { baseUrl?: string; fetch?: typeof globalThis.fetch } = {},
) {
  const response = await clientFor(options).v1.runs[":runId"].cancel.$post({ param: { runId } });
  if (!response.ok) throw await responseError(response);
  return (await response.json()).data;
}

export async function getEngineRuntimeStatus(
  conversationId: string,
  options: { baseUrl?: string; fetch?: typeof globalThis.fetch } = {},
): Promise<EngineRuntimeStatus | null> {
  const client = clientFor(options);
  const response = await client.v1.conversations[":conversationId"]["engine-session"].runtime.$get({
    param: { conversationId },
  });
  if (!response.ok) throw await responseError(response);
  return (await response.json()).data.status;
}

export async function createEngineRuntimeAccess(
  conversationId: string,
  options: { baseUrl?: string; fetch?: typeof globalThis.fetch } = {},
): Promise<EngineRuntimeAccess> {
  const client = clientFor(options);
  const response = await client.v1.conversations[":conversationId"]["engine-session"][
    "runtime-access"
  ].$post({ param: { conversationId } });
  if (!response.ok) throw await responseError(response);
  return (await response.json()).data;
}

function clientFor(options: { baseUrl?: string; fetch?: typeof globalThis.fetch }) {
  const baseUrl = options.baseUrl ?? headlessChatApiBaseUrl();
  return createApiClient(baseUrl, {
    fetch: createHeadlessChatApiFetch({
      baseUrl,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }),
  });
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

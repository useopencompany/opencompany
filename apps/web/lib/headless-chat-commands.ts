"use client";

import {
  createApiClient,
  type EngineRuntimeAccess,
  type EngineRuntimeStatus,
  type RunDto,
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
  if (command.archived !== undefined && typeof window !== "undefined") {
    window.dispatchEvent(new Event("bots-changed"));
  }
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

export async function getHeadlessChatRun(
  runId: string,
  options: { baseUrl?: string; fetch?: typeof globalThis.fetch } = {},
): Promise<RunDto> {
  const response = await clientFor(options).v1.runs[":runId"].$get({ param: { runId } });
  if (!response.ok) throw await responseError(response);
  return (await response.json()).data;
}

// A running cancellation is acknowledged before the worker reaches an interrupt boundary. Electric
// remains the normal live projection, but Stop must still converge when that separate stream fails.
export async function waitForHeadlessChatRunSettlement(
  runId: string,
  options: {
    baseUrl?: string;
    fetch?: typeof globalThis.fetch;
    signal?: AbortSignal;
    initialDelayMs?: number;
    maxDelayMs?: number;
  } = {},
): Promise<RunDto> {
  let delayMs = options.initialDelayMs ?? 250;
  const maxDelayMs = options.maxDelayMs ?? 2_000;
  while (true) {
    options.signal?.throwIfAborted();
    try {
      const run = await getHeadlessChatRun(runId, options);
      if (run.status === "completed" || run.status === "failed" || run.status === "canceled") {
        return run;
      }
    } catch (error) {
      options.signal?.throwIfAborted();
      // Cancellation was accepted. A transient read failure must not resume the stopped stream.
      if (error instanceof DOMException && error.name === "AbortError") throw error;
    }
    await abortableDelay(delayMs, options.signal);
    delayMs = Math.min(maxDelayMs, Math.max(delayMs + 1, delayMs * 2));
  }
}

export async function steerHeadlessChatRun(
  runId: string,
  options: { baseUrl?: string; fetch?: typeof globalThis.fetch } = {},
) {
  const response = await clientFor(options).v1.runs[":runId"].steer.$post({ param: { runId } });
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
  // A Conversation that never opened an engine session has no sandbox to report on. That is a
  // settled answer, not a failed lifecycle check, so callers must not show it as "unknown".
  if (response.status === 404) return null;
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

function abortableDelay(delayMs: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted();
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason);
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
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

"use client";

import {
  type CreateTaskBody,
  type CreateTaskCommentBody,
  type CreateTaskCommentResult,
  createApiClient,
  type LegacyTaskDto,
  type LegacyTaskHistoryDto,
  type TaskDto,
  type TaskSummaryDto,
} from "@opencompany/protocol";
import { createHeadlessChatApiFetch, headlessChatApiBaseUrl } from "./headless-chat-api";
import { reconcileCommittedProjection } from "./headless-collection-reconciliation";
import {
  awaitHeadlessTaskCommentTransaction,
  awaitHeadlessTaskTransaction,
} from "./headless-task-collections";

type ClientOptions = { baseUrl?: string; fetch?: typeof globalThis.fetch };
type ScopedClientOptions = ClientOptions & { scopeKey: string };

export async function createHeadlessTask(command: CreateTaskBody, options: ScopedClientOptions) {
  const client = taskClient(options);
  const response = await client.v1.tasks.$post({
    header: { "idempotency-key": `web-task:${crypto.randomUUID()}` },
    json: command,
  });
  if (!response.ok) throw await taskResponseError(response, "Task creation failed");
  const data = (await response.json()).data;
  await reconcileCommittedProjection(
    awaitHeadlessTaskTransaction(data.transactionId, { scopeKey: options.scopeKey }),
  );
  return data;
}

export function newHeadlessTaskCommentId() {
  return `task_activity_${crypto.randomUUID()}`;
}

export async function createHeadlessTaskComment(
  taskId: string,
  command: CreateTaskCommentBody,
  options: ScopedClientOptions,
): Promise<CreateTaskCommentResult> {
  const response = await taskClient(options).v1.tasks[":taskId"].comments.$post({
    param: { taskId },
    json: command,
  });
  if (!response.ok) throw await taskResponseError(response, "Task comment failed");
  const data = (await response.json()).data;
  await reconcileCommittedProjection(
    awaitHeadlessTaskCommentTransaction(taskId, data.transactionId, {
      scopeKey: options.scopeKey,
    }),
  );
  return data;
}

export async function getHeadlessTask(taskId: string, options: ClientOptions = {}) {
  const response = await taskClient(options).v1.tasks[":taskId"].$get({ param: { taskId } });
  if (response.status === 404) return null;
  if (!response.ok) throw await taskResponseError(response, "Task loading failed");
  return (await response.json()).data as TaskDto;
}

export async function getHeadlessTaskSummary(
  taskId: string,
  options: ClientOptions = {},
): Promise<TaskSummaryDto | null> {
  const response = await taskClient(options).v1.tasks[":taskId"].summary.$get({
    param: { taskId },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw await taskResponseError(response, "Task summary loading failed");
  return (await response.json()).data;
}

export async function listLegacyTaskCompatibility(
  options: ClientOptions = {},
): Promise<LegacyTaskDto[]> {
  const response = await taskClient(options).v1.compatibility.tasks.$get();
  if (!response.ok) throw await taskResponseError(response, "Legacy Task history loading failed");
  return (await response.json()).data;
}

export async function getLegacyTaskCompatibilityHistory(
  taskId: string,
  options: ClientOptions = {},
): Promise<LegacyTaskHistoryDto | null> {
  const response = await taskClient(options).v1.compatibility.tasks[":taskId"].history.$get({
    param: { taskId },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw await taskResponseError(response, "Legacy Task history loading failed");
  return (await response.json()).data;
}

export async function archiveHeadlessTask(taskId: string, options: ScopedClientOptions) {
  const response = await taskClient(options).v1.tasks[":taskId"].$patch({
    param: { taskId },
    json: { archived: true },
  });
  if (!response.ok) throw await taskResponseError(response, "Task archive failed");
  const data = (await response.json()).data;
  await reconcileCommittedProjection(
    awaitHeadlessTaskTransaction(data.transactionId, { scopeKey: options.scopeKey }),
  );
  return data.task;
}

export async function cancelHeadlessTaskRun(runId: string, options: ClientOptions = {}) {
  const response = await taskClient(options).v1.runs[":runId"].cancel.$post({ param: { runId } });
  if (!response.ok) throw await taskResponseError(response, "Task cancellation failed");
  return (await response.json()).data;
}

function taskClient(options: ClientOptions) {
  const baseUrl = options.baseUrl ?? headlessChatApiBaseUrl();
  return createApiClient(baseUrl, {
    fetch: createHeadlessChatApiFetch({
      baseUrl,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }),
  });
}

async function taskResponseError(response: Response, fallback: string) {
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: unknown; requestId?: unknown };
  } | null;
  const message = typeof body?.error?.message === "string" ? body.error.message : null;
  const requestId = typeof body?.error?.requestId === "string" ? body.error.requestId : null;
  return new Error(
    `${message ?? `${fallback} with HTTP ${response.status}.`}${requestId ? ` (request ${requestId})` : ""}`,
  );
}

"use client";

import {
  type ArchiveVersionBody,
  type CreateTaskScheduleBody,
  type CreateWorkflowBody,
  createApiClient,
  type InvokeWorkflowBody,
  type SetTaskScheduleEnabledBody,
  type UpdateTaskScheduleBody,
  type UpdateWorkflowBody,
} from "@opencompany/protocol";
import { awaitHeadlessTaskScheduleTransaction } from "./headless-automation-collections";
import { workflowDtoToCatalogItem } from "./headless-automation-types";
import { createHeadlessChatApiFetch, headlessChatApiBaseUrl } from "./headless-chat-api";
import { reconcileCommittedProjection } from "./headless-collection-reconciliation";
import { awaitHeadlessTaskTransaction } from "./headless-task-collections";

type ClientOptions = {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
};
type ScopedClientOptions = ClientOptions & { scopeKey: string };

export async function listHeadlessWorkflowCatalog(options: ClientOptions = {}) {
  const workflows = await listAllWorkflows(options);
  return workflows.flatMap((workflow) => {
    const item = workflowDtoToCatalogItem(workflow);
    return item ? [item] : [];
  });
}

// Workflow CRUD callers use the committed API response or navigate to a server-rendered route.
// Electric reconciles live lists independently; awaiting it here can stall an already-saved command.
export async function createHeadlessWorkflow(
  command: CreateWorkflowBody,
  options: ClientOptions = {},
) {
  const response = await automationClient(options).v1.workflows.$post({
    header: { "idempotency-key": `web-workflow:${crypto.randomUUID()}` },
    json: command,
  });
  if (!response.ok) throw await automationResponseError(response, "Workflow creation failed");
  return (await response.json()).data.workflow;
}

export async function updateHeadlessWorkflow(
  workflowId: string,
  command: UpdateWorkflowBody,
  options: ClientOptions = {},
) {
  const response = await automationClient(options).v1.workflows[":workflowId"].$patch({
    param: { workflowId },
    json: command,
  });
  if (!response.ok) throw await automationResponseError(response, "Workflow update failed");
  return (await response.json()).data.workflow;
}

export async function archiveHeadlessWorkflow(
  workflowId: string,
  command: ArchiveVersionBody,
  options: ClientOptions = {},
) {
  const response = await automationClient(options).v1.workflows[":workflowId"].archive.$post({
    param: { workflowId },
    json: command,
  });
  if (!response.ok) throw await automationResponseError(response, "Workflow archive failed");
  return (await response.json()).data;
}

export async function invokeHeadlessWorkflow(
  workflowId: string,
  command: InvokeWorkflowBody,
  options: ScopedClientOptions,
) {
  const response = await automationClient(options).v1.workflows[":workflowId"].invoke.$post({
    param: { workflowId },
    header: { "idempotency-key": `web-workflow-invoke:${crypto.randomUUID()}` },
    json: command,
  });
  if (!response.ok) throw await automationResponseError(response, "Workflow invocation failed");
  return reconcileCreatedTask((await response.json()).data, options);
}

export async function runHeadlessWorkflowNow(workflowId: string, options: ScopedClientOptions) {
  const response = await automationClient(options).v1.workflows[":workflowId"]["run-now"].$post({
    param: { workflowId },
    header: { "idempotency-key": `web-workflow-run:${crypto.randomUUID()}` },
  });
  if (!response.ok) throw await automationResponseError(response, "Workflow run failed");
  return reconcileCreatedTask((await response.json()).data, options);
}

export async function createHeadlessTaskSchedule(
  command: CreateTaskScheduleBody,
  options: ScopedClientOptions,
) {
  const response = await automationClient(options).v1.schedules.$post({
    header: { "idempotency-key": `web-task-schedule:${crypto.randomUUID()}` },
    json: command,
  });
  if (!response.ok) {
    throw await automationResponseError(response, "Recurring Task creation failed");
  }
  const data = (await response.json()).data;
  await reconcileCommittedProjection(
    awaitHeadlessTaskScheduleTransaction(data.transactionId, collectionOptions(options)),
  );
  return data.schedule;
}

export async function updateHeadlessTaskSchedule(
  scheduleId: string,
  command: UpdateTaskScheduleBody | SetTaskScheduleEnabledBody,
  options: ScopedClientOptions,
) {
  const response = await automationClient(options).v1.schedules[":scheduleId"].$patch({
    param: { scheduleId },
    json: command,
  });
  if (!response.ok) {
    throw await automationResponseError(response, "Recurring Task update failed");
  }
  const data = (await response.json()).data;
  await reconcileCommittedProjection(
    awaitHeadlessTaskScheduleTransaction(data.transactionId, collectionOptions(options)),
  );
  return data.schedule;
}

export async function archiveHeadlessTaskSchedule(
  scheduleId: string,
  command: ArchiveVersionBody,
  options: ScopedClientOptions,
) {
  const response = await automationClient(options).v1.schedules[":scheduleId"].archive.$post({
    param: { scheduleId },
    json: command,
  });
  if (!response.ok) {
    throw await automationResponseError(response, "Recurring Task archive failed");
  }
  const data = (await response.json()).data;
  await reconcileCommittedProjection(
    awaitHeadlessTaskScheduleTransaction(data.transactionId, collectionOptions(options)),
  );
  return data;
}

export async function runHeadlessTaskScheduleNow(scheduleId: string, options: ScopedClientOptions) {
  const response = await automationClient(options).v1.schedules[":scheduleId"]["run-now"].$post({
    param: { scheduleId },
    header: { "idempotency-key": `web-task-schedule-run:${crypto.randomUUID()}` },
  });
  if (!response.ok) throw await automationResponseError(response, "Recurring Task run failed");
  return reconcileCreatedTask((await response.json()).data, options);
}

async function listAllWorkflows(options: ClientOptions) {
  const client = automationClient(options);
  const workflows = [];
  let cursor: string | undefined;
  do {
    const response = await client.v1.workflows.$get({
      query: { limit: "100", ...(cursor ? { cursor } : {}) },
    });
    if (!response.ok) throw await automationResponseError(response, "Workflow loading failed");
    const page = await response.json();
    workflows.push(...page.data);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return workflows;
}

async function reconcileCreatedTask(
  data: {
    task: { id: string; displayId: string; name: string; conversationId: string };
    runId: string;
    transactionId: string;
  },
  options: ScopedClientOptions,
) {
  await reconcileCommittedProjection(
    awaitHeadlessTaskTransaction(data.transactionId, collectionOptions(options)),
  );
  return data;
}

function automationClient(options: ClientOptions) {
  const baseUrl = options.baseUrl ?? headlessChatApiBaseUrl();
  return createApiClient(baseUrl, {
    fetch: createHeadlessChatApiFetch({
      baseUrl,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }),
  });
}

function collectionOptions(options: ScopedClientOptions) {
  return { scopeKey: options.scopeKey };
}

async function automationResponseError(response: Response, fallback: string) {
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: unknown; requestId?: unknown };
  } | null;
  const message = typeof body?.error?.message === "string" ? body.error.message : null;
  const requestId = typeof body?.error?.requestId === "string" ? body.error.requestId : null;
  return new Error(
    `${message ?? `${fallback} with HTTP ${response.status}.`}${requestId ? ` (request ${requestId})` : ""}`,
  );
}

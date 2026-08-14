import "server-only";

import { createApiClient, type TaskScheduleDto, type WorkflowDto } from "@opencompany/protocol";
import { headers } from "next/headers";

export async function listHeadlessWorkflows(): Promise<WorkflowDto[]> {
  const client = await serverAutomationClient();
  const workflows: WorkflowDto[] = [];
  let cursor: string | undefined;
  do {
    const response = await client.v1.workflows.$get({
      query: { limit: "100", ...(cursor ? { cursor } : {}) },
    });
    if (!response.ok) throw await serverResponseError(response, "Workflow loading failed");
    const page = await response.json();
    workflows.push(...page.data);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return workflows;
}

export async function getHeadlessWorkflow(workflowId: string): Promise<WorkflowDto | null> {
  const response = await (await serverAutomationClient()).v1.workflows[":workflowId"].$get({
    param: { workflowId },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw await serverResponseError(response, "Workflow loading failed");
  return (await response.json()).data;
}

export async function listHeadlessTaskSchedules(): Promise<TaskScheduleDto[]> {
  const client = await serverAutomationClient();
  const schedules: TaskScheduleDto[] = [];
  let cursor: string | undefined;
  do {
    const response = await client.v1.schedules.$get({
      query: { limit: "100", ...(cursor ? { cursor } : {}) },
    });
    if (!response.ok) throw await serverResponseError(response, "Recurring Task loading failed");
    const page = await response.json();
    schedules.push(...page.data);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return schedules;
}

async function serverAutomationClient() {
  const origin = serverApiOrigin(process.env.GOAT_API_ORIGIN);
  const incoming = await headers();
  const cookie = incoming.get("cookie");
  const authorization = incoming.get("authorization");
  const fetchWithActor: typeof globalThis.fetch = async (input, init) => {
    const forwarded = new Headers(init?.headers);
    if (cookie) forwarded.set("Cookie", cookie);
    if (authorization) forwarded.set("Authorization", authorization);
    return globalThis.fetch(input, {
      ...init,
      headers: forwarded,
      cache: "no-store",
    });
  };
  return createApiClient(origin, { fetch: fetchWithActor });
}

function serverApiOrigin(value: string | undefined) {
  if (!value?.trim()) throw new Error("The canonical API origin is unavailable.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The canonical API origin is invalid.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("The canonical API origin is invalid.");
  }
  return url.origin;
}

async function serverResponseError(response: Response, fallback: string) {
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: unknown; requestId?: unknown };
  } | null;
  const message = typeof body?.error?.message === "string" ? body.error.message : null;
  const requestId = typeof body?.error?.requestId === "string" ? body.error.requestId : null;
  return new Error(
    `${message ?? `${fallback} with HTTP ${response.status}.`}${requestId ? ` (request ${requestId})` : ""}`,
  );
}

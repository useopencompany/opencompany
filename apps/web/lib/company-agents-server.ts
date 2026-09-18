import "server-only";

import {
  type CompanyAgentDto,
  type CompanyAgentRunDto,
  createApiClient,
} from "@opencompany/protocol";
import { headers } from "next/headers";

export async function listCompanyAgents(): Promise<CompanyAgentDto[]> {
  const client = await serverAgentClient();
  const agents: CompanyAgentDto[] = [];
  let cursor: string | undefined;
  do {
    const response = await client.v1.agents.$get({
      query: { limit: "100", ...(cursor ? { cursor } : {}) },
    });
    if (!response.ok) throw await serverResponseError(response, "Company agent loading failed");
    const page = await response.json();
    agents.push(...page.data);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return agents;
}

export async function getCompanyAgent(agentId: string): Promise<CompanyAgentDto | null> {
  const response = await (await serverAgentClient()).v1.agents[":agentId"].$get({
    param: { agentId },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw await serverResponseError(response, "Company agent loading failed");
  return (await response.json()).data;
}

export async function listCompanyAgentRuns(agentId: string): Promise<CompanyAgentRunDto[]> {
  const response = await (await serverAgentClient()).v1.agents[":agentId"].runs.$get({
    param: { agentId },
    query: { limit: "50" },
  });
  if (response.status === 404) return [];
  if (!response.ok) throw await serverResponseError(response, "Agent run history loading failed");
  return (await response.json()).data;
}

async function serverAgentClient() {
  const origin = serverApiOrigin(process.env.OPENCOMPANY_API_ORIGIN);
  const incoming = await headers();
  const cookie = incoming.get("cookie");
  const authorization = incoming.get("authorization");
  const fetchWithActor: typeof globalThis.fetch = async (input, init) => {
    const forwarded = new Headers(init?.headers);
    if (cookie) forwarded.set("Cookie", cookie);
    if (authorization) forwarded.set("Authorization", authorization);
    return globalThis.fetch(input, { ...init, headers: forwarded, cache: "no-store" });
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

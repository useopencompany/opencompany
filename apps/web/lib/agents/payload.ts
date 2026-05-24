import type { Agent } from "@opencompany/db/schema";
import type { AgentConfig } from "@/lib/agents/types";

export const AGENTS_QUERY_STALE_TIME_MS = 30_000;

export type AgentPayload = {
  id: string;
  workspaceId: string;
  path: string | null;
  name: string;
  body: string;
  config: AgentConfig;
  githubCommitSha: string | null;
  githubSyncedAt: string | null;
  githubSyncStatus: string;
  githubSyncError: string | null;
  createdAt: string;
  updatedAt: string;
};

export function serializeAgent(agent: Agent): AgentPayload {
  return {
    id: agent.id,
    workspaceId: agent.workspaceId,
    path: agent.path,
    name: agent.name,
    body: agent.body || agent.config.instructions,
    config: agent.config,
    githubCommitSha: agent.githubCommitSha,
    githubSyncedAt: agent.githubSyncedAt?.toISOString() ?? null,
    githubSyncStatus: agent.githubSyncStatus,
    githubSyncError: agent.githubSyncError,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
  };
}

export function agentHref(agent: Pick<AgentPayload, "id" | "path">) {
  return `/agents/${agent.path ?? agent.id}`;
}

export const agentQueryKeys = {
  list: (workspaceId: string) => ["agents", workspaceId] as const,
  detail: (workspaceId: string, idOrPath: string) => ["agent", workspaceId, idOrPath] as const,
};

function agentApiPath(idOrPath: string) {
  return idOrPath.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

async function readJson<T>(response: Response): Promise<T> {
  if (response.ok) return response.json() as Promise<T>;

  let message = `Request failed with ${response.status}`;
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string") message = body.error;
  } catch {
    // Ignore parse failures and use the status-based message.
  }
  throw new Error(message);
}

export async function fetchAgents(): Promise<AgentPayload[]> {
  const response = await fetch("/api/agents", { credentials: "same-origin" });
  const body = await readJson<{ agents: AgentPayload[] }>(response);
  return body.agents;
}

export async function fetchAgent(idOrPath: string): Promise<AgentPayload> {
  const response = await fetch(`/api/agents/${agentApiPath(idOrPath)}`, {
    credentials: "same-origin",
  });
  const body = await readJson<{ agent: AgentPayload }>(response);
  return body.agent;
}

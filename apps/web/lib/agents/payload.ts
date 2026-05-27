import type { AgentConfig, TiptapDoc } from "@opencompany/agent-runtime/types";
import type { Agent } from "@opencompany/db/schema";

export const AGENTS_QUERY_STALE_TIME_MS = 30_000;

export type AgentListItemPayload = {
  id: string;
  workspaceId: string;
  path: string | null;
  name: string;
  config: AgentConfig;
  githubSyncStatus: string;
  githubSyncError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AgentDetailPayload = AgentListItemPayload & {
  body: string;
  content: TiptapDoc;
  githubCommitSha: string | null;
  githubSyncedAt: string | null;
  brainPaths: string[];
  githubIntegrationRepositories: Array<{ fullName: string; defaultBranch: string }>;
};

export function serializeAgentListItem(agent: Agent): AgentListItemPayload {
  return {
    id: agent.id,
    workspaceId: agent.workspaceId,
    path: agent.path,
    name: agent.name,
    config: agent.config,
    githubSyncStatus: agent.githubSyncStatus,
    githubSyncError: agent.githubSyncError,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
  };
}

export function serializeAgentDetail(
  agent: Agent,
  brainPaths: string[] = [],
  githubIntegrationRepositories: Array<{ fullName: string; defaultBranch: string }> = [],
): AgentDetailPayload {
  return {
    ...serializeAgentListItem(agent),
    body: agent.body || agent.config.instructions,
    content: agent.content,
    githubCommitSha: agent.githubCommitSha,
    githubSyncedAt: agent.githubSyncedAt?.toISOString() ?? null,
    brainPaths,
    githubIntegrationRepositories,
  };
}

export function agentDetailToListItem(agent: AgentDetailPayload): AgentListItemPayload {
  return {
    id: agent.id,
    workspaceId: agent.workspaceId,
    path: agent.path,
    name: agent.name,
    config: agent.config,
    githubSyncStatus: agent.githubSyncStatus,
    githubSyncError: agent.githubSyncError,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
}

export function agentHref(agent: Pick<AgentListItemPayload, "id" | "path">) {
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

export async function fetchAgents(): Promise<AgentListItemPayload[]> {
  const response = await fetch("/api/agents", { cache: "no-store", credentials: "same-origin" });
  const body = await readJson<{ agents: AgentListItemPayload[] }>(response);
  return body.agents;
}

export async function fetchAgent(idOrPath: string): Promise<AgentDetailPayload> {
  const response = await fetch(`/api/agents/${agentApiPath(idOrPath)}`, {
    cache: "no-store",
    credentials: "same-origin",
  });
  const body = await readJson<{ agent: AgentDetailPayload }>(response);
  return body.agent;
}

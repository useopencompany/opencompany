import { captureServerEvent } from "@opencompany/analytics/server";
import { getDb } from "@opencompany/db/client";
import { agents } from "@opencompany/db/schema";
import { and, eq } from "drizzle-orm";
import { agentPathForSlug } from "@/lib/agents/agent-file";
import {
  agentSyncJobUpsert,
  buildPendingAgent,
  scheduleAgentSyncDispatch,
} from "@/lib/agents/create";

const DEFAULT_USER_AGENT_TITLE = "leo";
const DEFAULT_USER_AGENT_PATH = agentPathForSlug(DEFAULT_USER_AGENT_TITLE);

export async function ensureUserOnboardingScaffold(input: { userId: string; workspaceId: string }) {
  const db = getDb();
  const [existingAgent] = await db
    .select({ id: agents.id, path: agents.path })
    .from(agents)
    .where(and(eq(agents.workspaceId, input.workspaceId), eq(agents.path, DEFAULT_USER_AGENT_PATH)))
    .limit(1);

  if (existingAgent) {
    return {
      created: false as const,
      agentId: existingAgent.id,
      path: existingAgent.path ?? DEFAULT_USER_AGENT_PATH,
    };
  }

  const pending = buildPendingAgent({
    workspaceId: input.workspaceId,
    title: DEFAULT_USER_AGENT_TITLE,
    body: "",
    path: DEFAULT_USER_AGENT_PATH,
  });

  await db.batch([
    db.insert(agents).values(pending.agent),
    agentSyncJobUpsert(db, pending.syncJob),
  ]);

  await captureServerEvent("agent_created", input.userId, {
    user_id: input.userId,
    workspace_id: input.workspaceId,
    agent_id: pending.id,
  });

  scheduleAgentSyncDispatch({ id: pending.id, workspaceId: input.workspaceId });

  return {
    created: true as const,
    agentId: pending.id,
    path: DEFAULT_USER_AGENT_PATH,
  };
}

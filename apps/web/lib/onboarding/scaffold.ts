import { agentPathForSlug } from "@opencompany/agent-runtime";
import { captureServerEvent } from "@opencompany/analytics/server";
import { getDb } from "@opencompany/db/client";
import { agents } from "@opencompany/db/schema";
import { and, eq } from "drizzle-orm";
import {
  buildPendingAgent,
  logAgentSyncJobQueued,
  prepareAgentSyncJobUpsert,
  scheduleAgentSyncDispatch,
} from "@/lib/agents/create";

const DEFAULT_USER_AGENT_TITLE = "leo";
const DEFAULT_USER_AGENT_PATH = agentPathForSlug(DEFAULT_USER_AGENT_TITLE);

// Starter instructions for a brand-new user's first agent. The `@brain/` mention mounts the
// whole Brain, which (a) gives leo workspace context going forward and (b) is what lets the
// first onboarding session create and persist Brain files — a session with no Brain mount
// silently discards anything written under brain/. Keep this short; leo refines it via the
// agent-self-edit skill during onboarding.
export const DEFAULT_USER_AGENT_BODY = `You are leo, the user's OpenCompany agent. You help them get work done and you keep the company's shared knowledge in the Brain up to date.

Your shared knowledge lives in @brain/ — read it for context and keep it current as you learn about the company and its goals.

Research the live web with @exa before answering factual or time-sensitive questions, and cite what you find. Use @x to see what people are saying on X about a company, product, or topic when real-time or social signal is useful.

When the workspace is fresh or the user asks you to get set up, follow the opencompany-setup skill: ask a couple of clarifying questions, scaffold a tidy starter Brain, and tune your own definition so you're genuinely useful for this user.`;

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
    body: DEFAULT_USER_AGENT_BODY,
    path: DEFAULT_USER_AGENT_PATH,
  });
  const syncJob = prepareAgentSyncJobUpsert(db, pending.syncJob);

  await db.batch([db.insert(agents).values(pending.agent), syncJob.query]);
  logAgentSyncJobQueued(syncJob.metadata);

  await captureServerEvent("agent_created", input.userId, {
    user_id: input.userId,
    workspace_id: input.workspaceId,
    agent_id: pending.id,
  });

  scheduleAgentSyncDispatch({
    id: pending.id,
    workspaceId: input.workspaceId,
    path: DEFAULT_USER_AGENT_PATH,
  });

  return {
    created: true as const,
    agentId: pending.id,
    path: DEFAULT_USER_AGENT_PATH,
  };
}

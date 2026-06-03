import { agentBundleDir, agentPathForSlug } from "@opencompany/agent-runtime";
import type { AgentModelId } from "@opencompany/agent-runtime/types";
import { captureServerEvent } from "@opencompany/analytics/server";
import { getDb } from "@opencompany/db/client";
import { agentFiles, agents } from "@opencompany/db/schema";
import { and, eq } from "drizzle-orm";
import { buildPendingAgent } from "@/lib/agents/create";
import { brainContentSize, hashBrainContent } from "@/lib/brain/hash";
import { scheduleWorkspaceSyncDispatch } from "@/lib/workspace-sync/dispatch";
import { markWorkspaceDirty } from "@/lib/workspace-sync/jobs";

const DEFAULT_USER_AGENT_TITLE = "leo";
const DEFAULT_USER_AGENT_PATH = agentPathForSlug(DEFAULT_USER_AGENT_TITLE);

// Throughput-optimized MiniMax M2.7 is a capable, low-latency default for leo. Other agents
// keep the global default.
const DEFAULT_USER_AGENT_MODEL: AgentModelId = "minimax/minimax-m2.7-highspeed";

// Starter instructions for a brand-new user's first agent. Deliberately minimal — leo's
// richer operating guidance lives in agent/soul.md (read first, see DEFAULT_SOUL_MD), and it
// sharpens this body via the agent-self-edit skill during onboarding. The `@brain/` mention
// mounts the whole Brain, which (a) gives leo workspace context going forward and (b) is what
// lets the first onboarding session create and persist Brain files — a session with no Brain
// mount silently discards anything written under brain/.
export const DEFAULT_USER_AGENT_BODY = `You are leo, the user's OpenCompany agent.

Before doing any work, read agent/soul.md — it's how you operate and who you serve. Keep it current as you learn.

Shared company knowledge lives in @brain/. Read it for context and keep it current.

Research with @exa (live web, cited) and @x (social signal) before answering factual or time-sensitive questions.

If the workspace is fresh or the user asks to get set up, follow the opencompany-setup skill.`;

// Default operating doc seeded into leo's private agent folder (agent/soul.md). The angle-bracket
// placeholders are personalized to the user's role and focus during onboarding (the
// opencompany-setup skill drives this). Keep it short; it's leo's to evolve.
export const DEFAULT_SOUL_MD = `# leo's soul

This is how I operate. I read it before any work and keep it current as I learn.

## Who I serve

<personalized to the user's role and what they care about during setup>

## How I work

- I keep shared knowledge current in the Brain (brain/wiki/).
- I research before I assert — live web via exa, social signal via x — and cite what I find.
- I'm concise and bias to action; I confirm before anything destructive or outward-facing.

## What good looks like

<tuned to the user's focus areas during setup>
`;

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
    model: DEFAULT_USER_AGENT_MODEL,
  });

  // Seed leo's private operating doc (agent/soul.md). The runner mounts it into ./agent on
  // the first session; the insert commits here before the seeded session starts.
  const soulPath = `${agentBundleDir(DEFAULT_USER_AGENT_PATH)}/soul.md`;
  const soulHash = hashBrainContent(DEFAULT_SOUL_MD);

  await db.batch([
    db.insert(agents).values(pending.agent),
    db.insert(agentFiles).values({
      workspaceId: input.workspaceId,
      agentId: pending.id,
      path: soulPath,
      content: DEFAULT_SOUL_MD,
      contentHash: soulHash,
      sizeBytes: brainContentSize(DEFAULT_SOUL_MD),
      githubSyncStatus: "pending",
    }),
    markWorkspaceDirty(db, input.workspaceId),
  ]);

  await captureServerEvent("agent_created", input.userId, {
    user_id: input.userId,
    workspace_id: input.workspaceId,
    agent_id: pending.id,
  });

  scheduleWorkspaceSyncDispatch({ workspaceId: input.workspaceId });

  return {
    created: true as const,
    agentId: pending.id,
    path: DEFAULT_USER_AGENT_PATH,
  };
}

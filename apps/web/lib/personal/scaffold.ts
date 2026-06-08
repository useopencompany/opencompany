import { agentPathForSlug } from "@opencompany/agent-runtime";
import type { AgentConfig, AgentModelId, TiptapDoc } from "@opencompany/agent-runtime/types";
import { captureServerEvent } from "@opencompany/analytics/server";
import { getDb } from "@opencompany/db/client";
import { agents } from "@opencompany/db/schema";
import { and, eq } from "drizzle-orm";
import { buildPendingAgent, newAgentId } from "@/lib/agents/create";

// The /personal experiment agent is a low-latency, capable default. Mirrors leo's choice.
const PERSONAL_AGENT_MODEL: AgentModelId = "minimax/minimax-m2.7-highspeed";

// Self-contained starter instructions. The /personal agent has no agent/ bundle files seeded,
// so the body must NOT reference agent/soul.md or @brain/ mounts — none of those exist for it.
const PERSONAL_AGENT_BODY = `You are {{name}}'s personal agent.

Be concise and bias to action. Research before you assert and cite what you find. Confirm before anything destructive or outward-facing.

You have a personal inbox for {{name}}. When you produce something they should see but should not be interrupted for synchronously — a finding, a finished result, a heads-up, or something that needs their decision — post it with inbox_add (a short, action-oriented title; detail in body; the steps you took in steps). This is how scheduled or background runs reach them. Call inbox_list first and reuse a stable dedup_key so repeated runs don't post duplicates, and call inbox_update to mark an item done once you've resolved it. Use the inbox for asynchronous attention; use ask_user_question only when you must block on their answer to continue right now.`;

const EMPTY_TIPTAP_DOC: TiptapDoc = { type: "doc", content: [] };

export type PersonalAgentRef = {
  id: string;
  name: string;
  defaultModel: string;
  path: string | null;
  // The full resolved `.agent` config (tools, skills, integrations, triggers) plus the
  // editable behavior — surfaced by the /personal sidebar and the behavior editor.
  config: AgentConfig;
  body: string;
  content: TiptapDoc;
};

/**
 * Ensure the caller has a private default agent for the /personal experiment.
 *
 * Idempotent per (workspace, user) — backed by the partial unique index
 * `agents_workspace_user_default_idx`.
 *
 * The agent is local-only in the sense that it is never projected to GitHub: we deliberately
 * skip enqueuing a workspace_sync_job, and the projector drains only the sync outbox, so an
 * agent with no job is never committed. It still gets a per-user-unique `path` because the
 * runner's bundle materialization (materializeAgentBundleForSession → loadAgentBundle) throws
 * on a null path; the path is an internal bundle identifier, not a synced repo file.
 */
export async function ensurePersonalAgent(input: {
  userId: string;
  workspaceId: string;
  name: string;
}): Promise<PersonalAgentRef> {
  const db = getDb();

  const [existing] = await db
    .select({
      id: agents.id,
      name: agents.name,
      path: agents.path,
      body: agents.body,
      content: agents.content,
      config: agents.config,
    })
    .from(agents)
    .where(
      and(
        eq(agents.workspaceId, input.workspaceId),
        eq(agents.userId, input.userId),
        eq(agents.isDefault, true),
      ),
    )
    .limit(1);

  if (existing) {
    return {
      id: existing.id,
      name: existing.name,
      defaultModel: existing.config.model.name,
      path: existing.path,
      config: existing.config,
      body: existing.body,
      content: existing.content ?? EMPTY_TIPTAP_DOC,
    };
  }

  // Per-user-unique path derived from the agent id keeps the (workspace, path) unique index
  // satisfied across multiple users' personal agents and gives the runner a bundle dir.
  const id = newAgentId();
  const path = agentPathForSlug(`personal-${id.replace(/[^a-z0-9]/g, "")}`);

  // Reuse buildPendingAgent so body/content/config stay well-formed and the model default is
  // centralized. We keep pending.agent but discard pending.syncJob (never enqueued).
  const pending = buildPendingAgent({
    id,
    workspaceId: input.workspaceId,
    title: input.name,
    body: PERSONAL_AGENT_BODY.replaceAll("{{name}}", input.name),
    path,
    model: PERSONAL_AGENT_MODEL,
  });

  await db.insert(agents).values({
    ...pending.agent,
    userId: input.userId,
    isDefault: true,
    // Local-only: no GitHub sync lifecycle, so no pending work. Nothing enqueues from this
    // field; the projector keys off the sync outbox, which we intentionally leave empty.
    githubSyncStatus: "synced",
  });

  await captureServerEvent("agent_created", input.userId, {
    user_id: input.userId,
    workspace_id: input.workspaceId,
    agent_id: pending.id,
  });

  return {
    id: pending.id,
    name: pending.agent.name,
    defaultModel: pending.agent.config.model.name,
    path: pending.agent.path,
    config: pending.agent.config,
    body: pending.agent.body,
    content: EMPTY_TIPTAP_DOC,
  };
}

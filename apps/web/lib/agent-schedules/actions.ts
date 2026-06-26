"use server";

import { AGENT_SCHEDULE_TRIGGER_TYPE, normalizeAgentConfig } from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import { agents } from "@opencompany/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { loadAgentSessionDetailForWorkspace } from "@/lib/agent-sessions/data";
import { sidebarSessionFromDetail } from "@/lib/agent-sessions/payload";
import { updateAgent } from "@/lib/agents/actions";
import { currentWorkspace } from "@/lib/auth";
import { parseScheduleTriggers } from "./parse";
import { runScheduledAgent } from "./runner";

export async function runAgentScheduleNow(agentId: string, triggerId: string) {
  const { user, workspace } = await currentWorkspace();
  const db = getDb();
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspace.id)))
    .limit(1);

  if (!agent) {
    return { ok: false, error: "Agent not found." } as const;
  }

  const config = normalizeAgentConfig(agent.config);
  const trigger = config.triggers.find(
    (item) => item.type === "agent.schedule" && item.id === triggerId,
  );

  if (!trigger || trigger.type !== "agent.schedule") {
    return { ok: false, error: "Schedule not found." } as const;
  }

  const result = await runScheduledAgent({
    agent,
    trigger,
    scheduledFor: new Date(),
    userId: user.id,
  });

  if (result.status === "failed") {
    if (result.reason === "insufficient_credits") {
      return {
        ok: false,
        error: "Add workspace credits to run this schedule.",
        redirectTo: "/company/settings?billing=insufficient",
      } as const;
    }
    return { ok: false, error: result.reason || "Could not run schedule." } as const;
  }

  if (result.status === "duplicate") {
    return { ok: false, error: "This schedule run already exists." } as const;
  }

  const detail = await loadAgentSessionDetailForWorkspace(result.sessionId, user.id, workspace.id);
  if (!detail) {
    return { ok: false, error: "Schedule ran but the session could not be loaded." } as const;
  }

  return { ok: true, session: sidebarSessionFromDetail(detail), detail } as const;
}

/**
 * Replace the schedule (routine) triggers on a workspace agent, used by the company Routines tab.
 *
 * This is the workspace counterpart to `updatePersonalAgentSchedules`: it scopes to a company
 * agent (`workspace_id` + `user_id IS NULL`), validates the incoming triggers, and merges them
 * with the agent's existing non-schedule triggers (GitHub PR triggers, etc.) so those survive.
 * The actual write is delegated to `updateAgent`, which owns versioning, normalization, and the
 * GitHub sync that workspace agents (unlike local-only personal agents) require — so routines
 * stay consistent with edits made in the agent editor.
 */
export async function updateWorkspaceAgentSchedules(
  agentId: string,
  schedules: readonly unknown[],
) {
  const { workspace } = await currentWorkspace();
  const db = getDb();

  const [agent] = await db
    .select({ id: agents.id, config: agents.config })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspace.id), isNull(agents.userId)))
    .limit(1);

  if (!agent) {
    return { ok: false, error: "Agent not found." } as const;
  }

  const parsed = parseScheduleTriggers(schedules);
  if (!parsed.ok) return { ok: false, error: parsed.error } as const;

  const currentConfig = normalizeAgentConfig(agent.config);
  const mergedTriggers = [
    ...parsed.value,
    ...currentConfig.triggers.filter((trigger) => trigger.type !== AGENT_SCHEDULE_TRIGGER_TYPE),
  ];

  // Delegate the actual write to `updateAgent` (the canonical workspace-agent path) so versioning,
  // config normalization, and GitHub sync stay consistent with edits made in the agent editor.
  const result = await updateAgent(agentId, { config: { triggers: mergedTriggers } });
  if (!result?.agent) {
    return { ok: false, error: "Could not save routine." } as const;
  }

  return { ok: true } as const;
}

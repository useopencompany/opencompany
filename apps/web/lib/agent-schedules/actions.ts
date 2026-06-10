"use server";

import { normalizeAgentConfig } from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import { agents } from "@opencompany/db/schema";
import { and, eq } from "drizzle-orm";
import { loadAgentSessionDetailForWorkspace } from "@/lib/agent-sessions/data";
import { sidebarSessionFromDetail } from "@/lib/agent-sessions/payload";
import { currentWorkspace } from "@/lib/auth";
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

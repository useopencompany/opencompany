import {
  newAgentSessionId,
  newAgentSessionMessageId,
  normalizeAgentConfig,
  scheduleTriggerDueAt,
} from "@opencompany/agent-runtime";
import type { AgentScheduleTriggerConfig } from "@opencompany/agent-runtime/types";
import { captureServerEvent } from "@opencompany/analytics/server";
import { hasPositiveWorkspaceBalance } from "@opencompany/billing";
import { getDb } from "@opencompany/db/client";
import type { Agent, AgentScheduleRun } from "@opencompany/db/schema";
import {
  agentScheduleRuns,
  agentSessionEvents,
  agentSessionMessages,
  agentSessions,
  agents,
  workspaces,
} from "@opencompany/db/schema";
import { eq } from "drizzle-orm";
import { dispatchAgentAfterSessionCheck } from "@/lib/agent-sessions/events";
import { triggerAgentMessageRun } from "@/lib/agent-sessions/message-runner";

export const AGENT_SCHEDULE_SWEEP_CRON = "* * * * *";

export async function sweepAgentSchedules(now = new Date()) {
  const db = getDb();
  const rows = await db
    .select({
      agent: agents,
      workspace: workspaces,
    })
    .from(agents)
    .innerJoin(workspaces, eq(agents.workspaceId, workspaces.id));

  const results = [];
  for (const row of rows) {
    const config = normalizeAgentConfig(row.agent.config);
    for (const trigger of config.triggers) {
      if (trigger.type !== "agent.schedule") continue;
      const scheduledFor = scheduleTriggerDueAt(trigger, now);
      if (!scheduledFor) continue;

      results.push(
        await runScheduledAgent({
          agent: row.agent,
          trigger,
          scheduledFor,
          userId: row.workspace.createdByUserId,
        }),
      );
    }
  }

  return {
    checkedAgents: rows.length,
    dueRuns: results.length,
    startedRuns: results.filter((result) => result.status === "started").length,
    skippedRuns: results.filter((result) => result.status === "duplicate").length,
    failedRuns: results.filter((result) => result.status === "failed").length,
  };
}

async function runScheduledAgent(input: {
  agent: Agent;
  trigger: AgentScheduleTriggerConfig;
  scheduledFor: Date;
  userId: string;
}) {
  const db = getDb();
  const reserved = await reserveScheduleRun(input);
  if (!reserved) return { status: "duplicate" as const };

  try {
    if (!(await hasPositiveWorkspaceBalance({ db, workspaceId: input.agent.workspaceId }))) {
      await failScheduleRun(reserved.id, "Workspace has no credits.");
      return { status: "failed" as const, reason: "insufficient_credits" };
    }

    const sessionId = newAgentSessionId();
    const messageId = newAgentSessionMessageId();
    const now = new Date();
    const title = titleFromPrompt(input.trigger.prompt);

    await db.batch([
      db.insert(agentSessions).values({
        id: sessionId,
        workspaceId: input.agent.workspaceId,
        userId: input.userId,
        agentId: input.agent.id,
        title,
        modelProvider: input.agent.config.model.provider,
        modelName: input.agent.config.model.name,
      }),
      db.insert(agentSessionEvents).values({
        sessionId,
        type: "session.status",
        payload: { status: "created", message: "Session created" },
      }),
      db.insert(agentSessionEvents).values({
        sessionId,
        type: "session.scheduled",
        payload: {
          triggerId: input.trigger.id,
          scheduledFor: input.scheduledFor.toISOString(),
          cron: input.trigger.cron,
          timezone: input.trigger.timezone,
        },
      }),
      db.insert(agentSessionMessages).values({
        id: messageId,
        sessionId,
        role: "user",
        status: "completed",
        content: input.trigger.prompt,
        modelMessage: { role: "user", content: input.trigger.prompt },
        completedAt: now,
      }),
      db.insert(agentSessionEvents).values({
        sessionId,
        messageId,
        type: "message.created",
        payload: {
          messageId,
          role: "user",
          content: input.trigger.prompt,
          status: "completed",
        },
      }),
      db
        .update(agentScheduleRuns)
        .set({ status: "started", sessionId, updatedAt: now })
        .where(eq(agentScheduleRuns.id, reserved.id)),
    ]);

    await Promise.all([
      triggerAgentMessageRun({ sessionId, messageId, workspaceId: input.agent.workspaceId }),
      dispatchAgentAfterSessionCheck({
        sessionId,
        messageId,
        workspaceId: input.agent.workspaceId,
      }),
      captureServerEvent("session_started", input.userId, {
        user_id: input.userId,
        workspace_id: input.agent.workspaceId,
        agent_id: input.agent.id,
        session_id: sessionId,
        model_provider: input.agent.config.model.provider,
        model_name: input.agent.config.model.name,
        source: "schedule",
        trigger_id: input.trigger.id,
      }),
    ]);

    return { status: "started" as const, sessionId };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Scheduled run failed.";
    await failScheduleRun(reserved.id, message);
    return { status: "failed" as const, reason: message };
  }
}

async function reserveScheduleRun(input: {
  agent: Agent;
  trigger: AgentScheduleTriggerConfig;
  scheduledFor: Date;
}): Promise<Pick<AgentScheduleRun, "id"> | null> {
  const [run] = await getDb()
    .insert(agentScheduleRuns)
    .values({
      workspaceId: input.agent.workspaceId,
      agentId: input.agent.id,
      triggerId: input.trigger.id,
      scheduledFor: input.scheduledFor,
      status: "pending",
    })
    .onConflictDoNothing({
      target: [
        agentScheduleRuns.agentId,
        agentScheduleRuns.triggerId,
        agentScheduleRuns.scheduledFor,
      ],
    })
    .returning({ id: agentScheduleRuns.id });

  return run ?? null;
}

async function failScheduleRun(id: number, error: string) {
  await getDb()
    .update(agentScheduleRuns)
    .set({ status: "failed", error, updatedAt: new Date() })
    .where(eq(agentScheduleRuns.id, id));
}

function titleFromPrompt(content: string) {
  const firstLine = content
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  const title = firstLine ? `Scheduled: ${firstLine}` : "Scheduled agent run";
  return title.length > 80 ? `${title.slice(0, 77)}...` : title;
}

import { newAgentSessionId, newAgentSessionMessageId } from "@opencompany/agent-runtime";
import { captureServerEvent } from "@opencompany/analytics/server";
import { getDb } from "@opencompany/db/client";
import {
  type Agent,
  agentSessionEvents,
  agentSessionMessages,
  agentSessions,
  agents,
} from "@opencompany/db/schema";
import { captureException, createLogger } from "@opencompany/observability";
import { and, eq, or } from "drizzle-orm";
import { after } from "next/server";
import { dispatchAgentAfterSessionCheck } from "@/lib/agent-sessions/events";
import { triggerAgentMessageRun } from "@/lib/agent-sessions/message-runner";

const logger = createLogger({ service: "opencompany-web", runtime: "server" });

function titleFromPrompt(content: string) {
  const firstLine = content
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  const title = firstLine ?? "Untitled session";
  return title.length > 80 ? `${title.slice(0, 77)}...` : title;
}

async function loadAgent(idOrPath: string, workspaceId: string): Promise<Agent | null> {
  const db = getDb();
  const [agent] = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.workspaceId, workspaceId),
        or(eq(agents.id, idOrPath), eq(agents.path, idOrPath)),
      ),
    )
    .limit(1);
  return agent ?? null;
}

function errorLogFields(error: unknown) {
  if (error instanceof Error) {
    return {
      error_name: error.name,
      error_message: error.message,
    };
  }

  return {
    error_name: typeof error,
    error_message: typeof error === "string" ? error : "Unknown error",
  };
}

/**
 * Creates a session for the given agent seeded with a single visible user message and
 * dispatches the run. This is a server-only helper (NOT a "use server" action): callers must
 * have already authenticated the user/workspace. We pass ids explicitly because the only
 * caller is the post-onboarding flow, which already resolved the current workspace.
 *
 * Returns the new session id, or null if the agent could not be found.
 */
export async function startSeededAgentSession(input: {
  agentId: string;
  userId: string;
  workspaceId: string;
  prompt: string;
  source: "agent" | "prompt" | "schedule" | "onboarding";
}): Promise<string | null> {
  const agent = await loadAgent(input.agentId, input.workspaceId);
  if (!agent) return null;

  const db = getDb();
  const sessionId = newAgentSessionId();
  const messageId = newAgentSessionMessageId();
  const now = new Date();

  await db.batch([
    db.insert(agentSessions).values({
      id: sessionId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      agentId: agent.id,
      title: titleFromPrompt(input.prompt),
      modelProvider: agent.config.model.provider,
      modelName: agent.config.model.name,
    }),
    db.insert(agentSessionEvents).values({
      sessionId,
      type: "session.status",
      payload: { status: "created", message: "Session created" },
    }),
    db.insert(agentSessionMessages).values({
      id: messageId,
      sessionId,
      role: "user",
      status: "completed",
      content: input.prompt,
      modelMessage: { role: "user", content: input.prompt },
      completedAt: now,
    }),
    db.insert(agentSessionEvents).values({
      sessionId,
      messageId,
      type: "message.created",
      payload: { messageId, role: "user", content: input.prompt, status: "completed" },
    }),
  ]);

  after(async () => {
    const sideEffects = [
      {
        name: "message_run",
        run: () =>
          triggerAgentMessageRun({
            sessionId,
            messageId,
            workspaceId: input.workspaceId,
          }),
      },
      {
        name: "after_session_check",
        run: () =>
          dispatchAgentAfterSessionCheck({
            sessionId,
            messageId,
            workspaceId: input.workspaceId,
          }),
      },
      {
        name: "analytics",
        run: () =>
          captureServerEvent("session_started", input.userId, {
            user_id: input.userId,
            workspace_id: input.workspaceId,
            agent_id: agent.id,
            session_id: sessionId,
            model_provider: agent.config.model.provider,
            model_name: agent.config.model.name,
            source: input.source,
          }),
      },
    ];

    const results = await Promise.allSettled(
      sideEffects.map(async (sideEffect) => {
        await sideEffect.run();
      }),
    );

    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") continue;

      const sideEffect = sideEffects[index];
      captureException(result.reason, {
        event: "opencompany.seeded_agent_session_side_effect_failed",
        side_effect: sideEffect?.name,
        workspace_id: input.workspaceId,
        agent_id: agent.id,
        session_id: sessionId,
        message_id: messageId,
      });
      logger.error("Failed seeded agent session side effect", {
        event: "opencompany.seeded_agent_session_side_effect_failed",
        side_effect: sideEffect?.name,
        workspace_id: input.workspaceId,
        agent_id: agent.id,
        session_id: sessionId,
        message_id: messageId,
        ...errorLogFields(result.reason),
      });
    }
  });

  return sessionId;
}

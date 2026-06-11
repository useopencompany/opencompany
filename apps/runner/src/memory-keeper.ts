import {
  MEMORY_KEEPER_MODEL,
  newAgentSessionId,
  newAgentSessionMessageId,
} from "@opencompany/agent-runtime";
import { agentSessionEvents, agentSessionMessages, agentSessions } from "@opencompany/db/schema";
import { getDb } from "./db";

// Spawns a dedicated, invisible memory-keeper session for a just-idle parent session. The child
// runs under the SAME personal agent id/bundle (so its memory writes surface next session) but is
// tagged `source: "memory"`, which the runner uses to apply the memory-keeper system prompt and
// restricted toolset (see runMessageWithContext + packages/agent-runtime/src/memory-keeper.ts).
//
// Uses the normal async boot path: insert the session + a seeded "review this session" message,
// then enqueue `start` (provision sandbox) and `message` (run the keeper turn). The keeper is a
// `source: "memory"` session created here in the runner — it never flows through the web dispatch
// sites, so it can never trigger its own after-session/memory pass (no recursion).
export async function spawnMemoryKeeperSession(input: {
  parentSessionId: string;
  parentTitle: string;
  workspaceId: string;
  userId: string;
  agentId: string;
}): Promise<{ childSessionId: string; childMessageId: string }> {
  const childSessionId = newAgentSessionId();
  const childMessageId = newAgentSessionMessageId();
  const now = new Date();
  const prompt = memoryKeeperKickoff(input.parentSessionId);

  await getDb().transaction(async (tx) => {
    await tx.insert(agentSessions).values({
      id: childSessionId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      agentId: input.agentId,
      title: memoryKeeperTitle(input.parentTitle),
      source: "memory",
      // Always the pinned cheap keeper model, never the parent's: the session's modelName becomes
      // the run's model override in resolveAgentRuntimeConfig.
      modelProvider: MEMORY_KEEPER_MODEL.provider,
      modelName: MEMORY_KEEPER_MODEL.name,
      parentSessionId: input.parentSessionId,
    });
    await tx.insert(agentSessionMessages).values({
      id: childMessageId,
      sessionId: childSessionId,
      role: "user",
      status: "completed",
      content: prompt,
      modelMessage: { role: "user", content: prompt },
      completedAt: now,
    });
    await tx.insert(agentSessionEvents).values({
      sessionId: childSessionId,
      type: "session.status",
      payload: {
        status: "created",
        message: "Memory pass session created",
        parentSessionId: input.parentSessionId,
      },
    });
    await tx.insert(agentSessionEvents).values({
      sessionId: childSessionId,
      messageId: childMessageId,
      type: "message.created",
      payload: {
        messageId: childMessageId,
        role: "user",
        content: prompt,
        status: "completed",
      },
    });
  });

  // Lazy import to keep the static module graph acyclic: jobs.ts imports the agent-loop handlers,
  // and agent-loop imports this file, so a static `./jobs` import here would close the loop.
  const { enqueueRunnerJob } = await import("./jobs");
  await enqueueRunnerJob({ kind: "message", sessionId: childSessionId, messageId: childMessageId });

  return { childSessionId, childMessageId };
}

function memoryKeeperKickoff(parentSessionId: string) {
  return [
    parentSessionId,
    "",
    `if you had to remember something from ${parentSessionId} for the future session to be more useful (focus especially on things the user said) - what would that be? reflect on that, then use the memory tool to properly update your memory.`,
  ].join("\n");
}

function memoryKeeperTitle(parentTitle: string) {
  const base = `Memory pass: ${parentTitle}`;
  return base.length > 80 ? `${base.slice(0, 77)}...` : base;
}

import { getDb } from "@opencompany/db/client";
import {
  codexChatSessions,
  codexChatTurns,
  runAttempts,
  workspaceMembers,
} from "@opencompany/db/product-schema";
import { and, eq } from "drizzle-orm";
import {
  authorizeClaudeToolCapability,
  type ClaudeToolAuthorityState,
  type ClaudeToolAuthorizedContext,
  type ClaudeToolCapability,
} from "./claude-capability";

export async function authorizePersistedClaudeToolCapability(input: {
  capability: ClaudeToolCapability;
  now?: Date;
  loadState?: (capability: ClaudeToolCapability) => Promise<ClaudeToolAuthorityState | null>;
}): Promise<ClaudeToolAuthorizedContext | null> {
  const state = await (input.loadState ?? loadPersistedAuthorityState)(input.capability);
  return authorizeClaudeToolCapability({
    capability: input.capability,
    state,
    now: input.now ?? new Date(),
  });
}

async function loadPersistedAuthorityState(
  capability: ClaudeToolCapability,
): Promise<ClaudeToolAuthorityState | null> {
  const [row] = await getDb()
    .select({
      sessionId: codexChatSessions.id,
      turnId: codexChatTurns.id,
      attemptId: runAttempts.id,
      attemptRunId: runAttempts.runId,
      attemptLeaseId: runAttempts.leaseId,
      attemptWorkerId: runAttempts.workerId,
      attemptStatus: runAttempts.status,
      engine: codexChatSessions.engine,
      sessionStatus: codexChatSessions.status,
      activeTurnId: codexChatSessions.activeTurnId,
      hostToolContractVersion: codexChatSessions.hostToolContractVersion,
      workspaceId: codexChatSessions.workspaceId,
      actorId: codexChatSessions.userWorkosId,
      conversationId: codexChatSessions.chatSessionId,
      sandboxId: codexChatSessions.sandboxId,
      turnStatus: codexChatTurns.status,
      turnLeaseId: codexChatTurns.leaseId,
      turnLeaseOwner: codexChatTurns.leaseOwner,
      turnLeaseExpiresAt: codexChatTurns.leaseExpiresAt,
      interruptRequestedAt: codexChatTurns.interruptRequestedAt,
      membershipId: workspaceMembers.id,
    })
    .from(codexChatSessions)
    .innerJoin(
      codexChatTurns,
      and(
        eq(codexChatTurns.id, capability.codexChatTurnId),
        eq(codexChatTurns.codexChatSessionId, codexChatSessions.id),
        eq(codexChatTurns.userWorkosId, codexChatSessions.userWorkosId),
      ),
    )
    .innerJoin(
      runAttempts,
      and(eq(runAttempts.id, capability.attemptId), eq(runAttempts.runId, codexChatTurns.id)),
    )
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, codexChatSessions.workspaceId),
        eq(workspaceMembers.userWorkosId, codexChatSessions.userWorkosId),
      ),
    )
    .where(eq(codexChatSessions.id, capability.codexChatSessionId))
    .limit(1);
  return row ?? null;
}

import { getDb } from "@opencompany/db/client";
import {
  goatCodexChatSessions,
  goatCodexChatTurns,
  goatRunAttempts,
  goatWorkspaceMembers,
} from "@opencompany/db/goat-schema";
import { and, eq } from "drizzle-orm";
import {
  authorizeGoatClaudeToolCapability,
  type GoatClaudeToolAuthorityState,
  type GoatClaudeToolAuthorizedContext,
  type GoatClaudeToolCapability,
} from "./claude-capability";

export async function authorizePersistedGoatClaudeToolCapability(input: {
  capability: GoatClaudeToolCapability;
  now?: Date;
  loadState?: (
    capability: GoatClaudeToolCapability,
  ) => Promise<GoatClaudeToolAuthorityState | null>;
}): Promise<GoatClaudeToolAuthorizedContext | null> {
  const state = await (input.loadState ?? loadPersistedAuthorityState)(input.capability);
  return authorizeGoatClaudeToolCapability({
    capability: input.capability,
    state,
    now: input.now ?? new Date(),
  });
}

async function loadPersistedAuthorityState(
  capability: GoatClaudeToolCapability,
): Promise<GoatClaudeToolAuthorityState | null> {
  const [row] = await getDb()
    .select({
      sessionId: goatCodexChatSessions.id,
      turnId: goatCodexChatTurns.id,
      attemptId: goatRunAttempts.id,
      attemptRunId: goatRunAttempts.runId,
      attemptLeaseId: goatRunAttempts.leaseId,
      attemptWorkerId: goatRunAttempts.workerId,
      attemptStatus: goatRunAttempts.status,
      engine: goatCodexChatSessions.engine,
      sessionStatus: goatCodexChatSessions.status,
      activeTurnId: goatCodexChatSessions.activeTurnId,
      hostToolContractVersion: goatCodexChatSessions.hostToolContractVersion,
      workspaceId: goatCodexChatSessions.workspaceId,
      actorId: goatCodexChatSessions.userWorkosId,
      conversationId: goatCodexChatSessions.chatSessionId,
      sandboxId: goatCodexChatSessions.sandboxId,
      turnStatus: goatCodexChatTurns.status,
      turnLeaseId: goatCodexChatTurns.leaseId,
      turnLeaseOwner: goatCodexChatTurns.leaseOwner,
      turnLeaseExpiresAt: goatCodexChatTurns.leaseExpiresAt,
      interruptRequestedAt: goatCodexChatTurns.interruptRequestedAt,
      membershipId: goatWorkspaceMembers.id,
    })
    .from(goatCodexChatSessions)
    .innerJoin(
      goatCodexChatTurns,
      and(
        eq(goatCodexChatTurns.id, capability.codexChatTurnId),
        eq(goatCodexChatTurns.codexChatSessionId, goatCodexChatSessions.id),
        eq(goatCodexChatTurns.userWorkosId, goatCodexChatSessions.userWorkosId),
      ),
    )
    .innerJoin(
      goatRunAttempts,
      and(
        eq(goatRunAttempts.id, capability.attemptId),
        eq(goatRunAttempts.runId, goatCodexChatTurns.id),
      ),
    )
    .innerJoin(
      goatWorkspaceMembers,
      and(
        eq(goatWorkspaceMembers.workspaceId, goatCodexChatSessions.workspaceId),
        eq(goatWorkspaceMembers.userWorkosId, goatCodexChatSessions.userWorkosId),
      ),
    )
    .where(eq(goatCodexChatSessions.id, capability.codexChatSessionId))
    .limit(1);
  return row ?? null;
}

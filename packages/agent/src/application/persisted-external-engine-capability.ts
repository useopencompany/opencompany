import { getDb } from "@opencompany/db/client";
import {
  codexChatSessions,
  codexChatTurns,
  runAttempts,
  workspaceMembers,
} from "@opencompany/db/product-schema";
import { and, eq } from "drizzle-orm";
import {
  authorizeExternalEngineToolCapability,
  type ExternalEngineToolAuthorityState,
  type ExternalEngineToolAuthorizedContext,
  type ExternalEngineToolCapability,
} from "./external-engine-capability";

export async function authorizePersistedExternalEngineToolCapability(input: {
  capability: ExternalEngineToolCapability;
  now?: Date;
  loadState?: (
    capability: ExternalEngineToolCapability,
  ) => Promise<ExternalEngineToolAuthorityState | null>;
}): Promise<ExternalEngineToolAuthorizedContext | null> {
  const state = await (input.loadState ?? loadPersistedAuthorityState)(input.capability);
  return authorizeExternalEngineToolCapability({
    capability: input.capability,
    state,
    now: input.now ?? new Date(),
  });
}

async function loadPersistedAuthorityState(
  capability: ExternalEngineToolCapability,
): Promise<ExternalEngineToolAuthorityState | null> {
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
      brainRef: codexChatSessions.brainRef,
      userMessageId: codexChatTurns.userMessageId,
      assistantMessageId: codexChatTurns.assistantMessageId,
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

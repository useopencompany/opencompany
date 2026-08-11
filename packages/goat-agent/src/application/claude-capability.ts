import { isGoatActionHostToolContractVersion } from "@opencompany/agent-runtime";

export type GoatClaudeToolCapability = {
  codexChatSessionId: string;
  codexChatTurnId: string;
  attemptId: string;
  leaseId: string;
};

export type GoatClaudeToolAuthorityState = {
  sessionId: string;
  turnId: string;
  attemptId: string;
  attemptRunId: string;
  attemptLeaseId: string | null;
  attemptWorkerId: string;
  attemptStatus: string;
  engine: string;
  sessionStatus: string;
  activeTurnId: string | null;
  hostToolContractVersion: string | null;
  workspaceId: string | null;
  actorId: string;
  conversationId: string;
  sandboxId: string | null;
  turnStatus: string;
  turnLeaseId: string | null;
  turnLeaseOwner: string | null;
  turnLeaseExpiresAt: Date | null;
  interruptRequestedAt: Date | null;
  membershipId: string;
};

export type GoatClaudeToolAuthorizedContext = {
  actorId: string;
  workspaceId: string;
  conversationId: string;
  sandboxId: string;
};

export function authorizeGoatClaudeToolCapability(input: {
  capability: GoatClaudeToolCapability;
  state: GoatClaudeToolAuthorityState | null;
  now: Date;
}): GoatClaudeToolAuthorizedContext | null {
  const { capability, state } = input;
  if (
    !state ||
    state.sessionId !== capability.codexChatSessionId ||
    state.turnId !== capability.codexChatTurnId ||
    state.attemptId !== capability.attemptId ||
    state.attemptRunId !== capability.codexChatTurnId ||
    state.attemptLeaseId !== capability.leaseId ||
    state.attemptWorkerId !== state.turnLeaseOwner ||
    state.attemptStatus !== "running" ||
    state.engine !== "claude_code" ||
    state.sessionStatus !== "running" ||
    state.activeTurnId !== capability.codexChatTurnId ||
    !isGoatActionHostToolContractVersion(state.hostToolContractVersion) ||
    !state.workspaceId ||
    !state.sandboxId ||
    state.turnStatus !== "running" ||
    state.turnLeaseId !== capability.leaseId ||
    !state.turnLeaseOwner ||
    !state.turnLeaseExpiresAt ||
    state.turnLeaseExpiresAt <= input.now ||
    state.interruptRequestedAt ||
    !state.membershipId
  ) {
    return null;
  }
  return {
    actorId: state.actorId,
    workspaceId: state.workspaceId,
    conversationId: state.conversationId,
    sandboxId: state.sandboxId,
  };
}

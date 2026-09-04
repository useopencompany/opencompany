import { isWikiHostToolContractVersion } from "@opencompany/agent-runtime";

export type ExternalEngineToolCapability = {
  codexChatSessionId: string;
  codexChatTurnId: string;
  attemptId: string;
  leaseId: string;
};

export type ExternalEngineToolAuthorityState = {
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
  workspaceName: string;
  workspaceSlug: string | null;
  legacyBrainEnabled: boolean;
  actorId: string;
  conversationId: string;
  sandboxId: string | null;
  turnStatus: string;
  turnLeaseId: string | null;
  turnLeaseOwner: string | null;
  turnLeaseExpiresAt: Date | null;
  interruptRequestedAt: Date | null;
  membershipId: string;
  brainRef: string | null;
  userMessageId: string;
  assistantMessageId: string;
};

export type ExternalEngineToolAuthorizedContext = {
  actorId: string;
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string | null;
  legacyBrainEnabled: boolean;
  conversationId: string;
  sandboxId: string;
  engine: "codex" | "claude_code";
  brainRef: string | null;
  userMessageId: string;
  assistantMessageId: string;
  hostToolContractVersion: string;
};

export function authorizeExternalEngineToolCapability(input: {
  capability: ExternalEngineToolCapability;
  state: ExternalEngineToolAuthorityState | null;
  now: Date;
}): ExternalEngineToolAuthorizedContext | null {
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
    (state.engine !== "claude_code" && state.engine !== "codex") ||
    // ACP clients initialize MCP before they emit turn.started. The claimed Run and Attempt
    // already own a live lease at that point, while the session deliberately remains in the
    // presentation-level "starting" state until the engine turn begins.
    (state.sessionStatus !== "starting" && state.sessionStatus !== "running") ||
    state.activeTurnId !== capability.codexChatTurnId ||
    !isWikiHostToolContractVersion(state.hostToolContractVersion) ||
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
    workspaceName: state.workspaceName,
    workspaceSlug: state.workspaceSlug,
    legacyBrainEnabled: state.legacyBrainEnabled,
    conversationId: state.conversationId,
    sandboxId: state.sandboxId,
    engine: state.engine,
    brainRef: state.legacyBrainEnabled ? state.brainRef : null,
    userMessageId: state.userMessageId,
    assistantMessageId: state.assistantMessageId,
    hostToolContractVersion: state.hostToolContractVersion as string,
  };
}

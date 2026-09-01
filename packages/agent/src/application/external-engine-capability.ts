import { isActionHostToolContractVersion } from "@opencompany/agent-runtime";
import { CODEX_BRAIN_TOOL_CONTRACT_VERSION } from "@opencompany/brain";

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
  wikiEnabled: boolean;
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
  wikiEnabled: boolean;
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
    state.sessionStatus !== "running" ||
    state.activeTurnId !== capability.codexChatTurnId ||
    (!isActionHostToolContractVersion(state.hostToolContractVersion) &&
      state.hostToolContractVersion !== CODEX_BRAIN_TOOL_CONTRACT_VERSION) ||
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
    wikiEnabled: state.wikiEnabled,
    conversationId: state.conversationId,
    sandboxId: state.sandboxId,
    engine: state.engine,
    brainRef: state.brainRef,
    userMessageId: state.userMessageId,
    assistantMessageId: state.assistantMessageId,
    hostToolContractVersion: state.hostToolContractVersion as string,
  };
}

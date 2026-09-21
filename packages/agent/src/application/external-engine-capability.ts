import { isWikiHostToolContractVersion } from "@opencompany/agent-runtime";

export type ExternalEngineToolCapability = {
  codexChatSessionId: string;
  codexChatTurnId: string;
  attemptId: string;
  leaseId: string;
};

export type ExternalEngineToolAuthorityState = {
  conversationKind?: string;
  slackChannelEnabled: boolean | null;
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
  actorId: string;
  conversationId: string;
  sandboxId: string | null;
  turnStatus: string;
  turnLeaseId: string | null;
  turnLeaseOwner: string | null;
  turnLeaseExpiresAt: Date | null;
  interruptRequestedAt: Date | null;
  membershipId: string;
  workspaceRole: string;
  userMessageId: string;
  assistantMessageId: string;
};

export type ExternalEngineToolAuthorizedContext = {
  taskConversation?: boolean;
  automationToolsEnabled?: boolean;
  slackChannelEnabled: boolean;
  skillToolsEnabled: boolean;
  actorId: string;
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string | null;
  conversationId: string;
  sandboxId: string;
  engine: "codex" | "claude_code";
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
    taskConversation: state.conversationKind === "task",
    automationToolsEnabled: state.workspaceRole === "admin" && state.conversationKind !== "task",
    slackChannelEnabled: state.conversationKind === "task" && state.slackChannelEnabled === true,
    skillToolsEnabled: true,
    actorId: state.actorId,
    workspaceId: state.workspaceId,
    workspaceName: state.workspaceName,
    workspaceSlug: state.workspaceSlug,
    conversationId: state.conversationId,
    sandboxId: state.sandboxId,
    engine: state.engine,
    userMessageId: state.userMessageId,
    assistantMessageId: state.assistantMessageId,
    hostToolContractVersion: state.hostToolContractVersion as string,
  };
}

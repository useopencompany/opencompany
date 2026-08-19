import { ACTION_HOST_TOOL_CONTRACT_VERSION } from "@opencompany/agent-runtime";
import { CODEX_BRAIN_TOOL_CONTRACT_VERSION } from "@opencompany/brain";
import { describe, expect, it } from "vitest";
import {
  authorizeExternalEngineToolCapability,
  type ExternalEngineToolAuthorityState,
  type ExternalEngineToolCapability,
} from "./external-engine-capability";

const capability: ExternalEngineToolCapability = {
  codexChatSessionId: "session_1",
  codexChatTurnId: "run_1",
  attemptId: "attempt_1",
  leaseId: "lease_1",
};

function state(
  overrides: Partial<ExternalEngineToolAuthorityState> = {},
): ExternalEngineToolAuthorityState {
  return {
    sessionId: "session_1",
    turnId: "run_1",
    attemptId: "attempt_1",
    attemptRunId: "run_1",
    attemptLeaseId: "lease_1",
    attemptWorkerId: "runner_1",
    attemptStatus: "running",
    engine: "claude_code",
    sessionStatus: "running",
    activeTurnId: "run_1",
    hostToolContractVersion: ACTION_HOST_TOOL_CONTRACT_VERSION,
    workspaceId: "workspace_1",
    actorId: "user_1",
    conversationId: "conversation_1",
    sandboxId: "sandbox_1",
    turnStatus: "running",
    turnLeaseId: "lease_1",
    turnLeaseOwner: "runner_1",
    turnLeaseExpiresAt: new Date("2026-08-11T12:01:00.000Z"),
    interruptRequestedAt: null,
    membershipId: "member_1",
    brainRef: null,
    userMessageId: "message_user_1",
    assistantMessageId: "message_assistant_1",
    ...overrides,
  };
}

const now = new Date("2026-08-11T12:00:00.000Z");

describe("External engine tool capability authority", () => {
  it("authorizes only the active persisted Claude attempt", () => {
    expect(authorizeExternalEngineToolCapability({ capability, state: state(), now })).toEqual({
      actorId: "user_1",
      workspaceId: "workspace_1",
      conversationId: "conversation_1",
      sandboxId: "sandbox_1",
      engine: "claude_code",
      brainRef: null,
      userMessageId: "message_user_1",
      assistantMessageId: "message_assistant_1",
      hostToolContractVersion: ACTION_HOST_TOOL_CONTRACT_VERSION,
    });
  });

  it.each([
    ["Codex", { engine: "codex" }],
    [
      "a legacy Brain-pinned Codex session",
      {
        engine: "codex",
        brainRef: "brain_1",
        hostToolContractVersion: CODEX_BRAIN_TOOL_CONTRACT_VERSION,
      },
    ],
  ])("authorizes %s through the shared capability boundary", (_name, overrides) => {
    expect(
      authorizeExternalEngineToolCapability({ capability, state: state(overrides), now }),
    ).toMatchObject(overrides);
  });

  it.each([
    ["cross-run", { turnId: "run_2" }],
    ["stale attempt", { attemptId: "attempt_2" }],
    ["reacquired lease", { turnLeaseId: "lease_2" }],
    ["expired lease", { turnLeaseExpiresAt: now }],
    ["revoked membership", { membershipId: "" }],
    ["interrupted turn", { interruptRequestedAt: now }],
    ["settled attempt", { attemptStatus: "succeeded" }],
  ])("rejects %s authority", (_name, overrides) => {
    expect(
      authorizeExternalEngineToolCapability({ capability, state: state(overrides), now }),
    ).toBeNull();
  });
});

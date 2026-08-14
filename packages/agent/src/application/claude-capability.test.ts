import { ACTION_HOST_TOOL_CONTRACT_VERSION } from "@opencompany/agent-runtime";
import { describe, expect, it } from "vitest";
import {
  authorizeClaudeToolCapability,
  type ClaudeToolAuthorityState,
  type ClaudeToolCapability,
} from "./claude-capability";

const capability: ClaudeToolCapability = {
  codexChatSessionId: "session_1",
  codexChatTurnId: "run_1",
  attemptId: "attempt_1",
  leaseId: "lease_1",
};

function state(overrides: Partial<ClaudeToolAuthorityState> = {}): ClaudeToolAuthorityState {
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
    ...overrides,
  };
}

const now = new Date("2026-08-11T12:00:00.000Z");

describe("Claude tool capability authority", () => {
  it("authorizes only the active persisted Claude attempt", () => {
    expect(authorizeClaudeToolCapability({ capability, state: state(), now })).toEqual({
      actorId: "user_1",
      workspaceId: "workspace_1",
      conversationId: "conversation_1",
      sandboxId: "sandbox_1",
    });
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
    expect(authorizeClaudeToolCapability({ capability, state: state(overrides), now })).toBeNull();
  });
});

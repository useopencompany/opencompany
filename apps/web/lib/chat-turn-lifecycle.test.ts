import { describe, expect, it } from "vitest";
import { deriveChatTurnPhase, isChatTurnWorking } from "./chat-turn-lifecycle";

const idleInput = {
  runStatus: null,
  finalizedAssistantOutcome: null,
  runtimeStatus: null,
  runtimeMatchesTurn: false,
  transportStatus: "ready",
  submitting: false,
} as const;

describe("chat turn lifecycle", () => {
  it("lets a terminal durable Run override stale streaming and runtime state", () => {
    const phase = deriveChatTurnPhase({
      ...idleInput,
      runStatus: "completed",
      runtimeStatus: "running",
      runtimeMatchesTurn: true,
      transportStatus: "streaming",
    });

    expect(phase).toBe("completed");
    expect(isChatTurnWorking(phase)).toBe(false);
  });

  it("lets a finalized matching assistant override a stale active Run projection", () => {
    expect(
      deriveChatTurnPhase({
        ...idleInput,
        runStatus: "running",
        finalizedAssistantOutcome: "completed",
        runtimeStatus: "running",
        runtimeMatchesTurn: true,
        transportStatus: "streaming",
      }),
    ).toBe("completed");
  });

  it("does not let an unmatched stale runtime own a newly submitted turn", () => {
    expect(
      deriveChatTurnPhase({
        ...idleInput,
        runtimeStatus: "running",
        transportStatus: "submitted",
      }),
    ).toBe("submitting");
  });

  it("treats a paused Run as quiescent without making it terminal", () => {
    const phase = deriveChatTurnPhase({
      ...idleInput,
      runStatus: "paused",
      runtimeStatus: "idle",
      transportStatus: "streaming",
    });

    expect(phase).toBe("paused");
    expect(isChatTurnWorking(phase)).toBe(false);
  });

  it.each(["completed", "failed", "canceled"] as const)(
    "keeps %s terminal when transport state is stale",
    (runStatus) => {
      expect(
        deriveChatTurnPhase({
          ...idleInput,
          runStatus,
          transportStatus: "streaming",
        }),
      ).toBe(runStatus);
    },
  );

  it.each([
    ["submitted", "submitting"],
    ["streaming", "running"],
  ] as const)("uses %s transport state before durable state arrives", (transportStatus, phase) => {
    expect(deriveChatTurnPhase({ ...idleInput, transportStatus })).toBe(phase);
  });
});

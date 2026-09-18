import { describe, expect, it } from "vitest";
import {
  deriveChatTurnPhase,
  isChatConversationWorking,
  isChatTurnWorking,
  reconcileRuntimeWithSettledRun,
  reconcileRuntimeWithTaskStatus,
} from "./chat-turn-lifecycle";

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

  it("keeps conversation controls active while the session runtime owns a newer Run", () => {
    expect(isChatConversationWorking("completed", true)).toBe(true);
    expect(isChatConversationWorking("completed", false)).toBe(false);
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

  it("parks a runtime projection that still looks live after its Task reached a terminal status", () => {
    const runtime = {
      status: "running" as const,
      activeRunId: "run_1",
      hasError: false,
      updatedAt: "2026-09-17T15:16:04.100Z",
    };

    expect(reconcileRuntimeWithTaskStatus(runtime, "succeeded")).toEqual({
      ...runtime,
      status: "idle",
      activeRunId: null,
    });
    expect(reconcileRuntimeWithTaskStatus({ ...runtime, status: "idle" }, "canceled")).toEqual({
      ...runtime,
      status: "idle",
      activeRunId: null,
    });
    // A Task that is still live, waiting, or absent keeps the runtime as synced.
    expect(reconcileRuntimeWithTaskStatus(runtime, "running")).toBe(runtime);
    expect(reconcileRuntimeWithTaskStatus(runtime, "waiting")).toBe(runtime);
    expect(reconcileRuntimeWithTaskStatus(runtime, null)).toBe(runtime);
    const failed = { ...runtime, status: "failed" as const, activeRunId: null, hasError: true };
    expect(reconcileRuntimeWithTaskStatus(failed, "failed")).toBe(failed);
  });

  it("parks the exact Run confirmed terminal while preserving a newer active Run", () => {
    const runtime = {
      status: "running" as const,
      activeRunId: "run_stopped",
      hasError: false,
      updatedAt: "2026-09-17T18:44:31.430Z",
    };

    expect(reconcileRuntimeWithSettledRun(runtime, "run_stopped", "canceled")).toEqual({
      ...runtime,
      status: "interrupted",
      activeRunId: null,
    });
    expect(reconcileRuntimeWithSettledRun(runtime, "run_stopped", "completed")).toEqual({
      ...runtime,
      status: "idle",
      activeRunId: null,
    });
    const nextRun = { ...runtime, activeRunId: "run_follow_up" };
    expect(reconcileRuntimeWithSettledRun(nextRun, "run_stopped", "canceled")).toBe(nextRun);
  });
});

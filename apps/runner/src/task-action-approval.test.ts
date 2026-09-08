import type { CodexChatTurn } from "@opencompany/db/product-schema";
import type { TaskActionRequest } from "@opencompany/db/task-action-approvals";
import { describe, expect, it, vi } from "vitest";
import { CodexChatLeaseLostError, TaskActionApprovalPauseError } from "./codex-chat-errors";
import { resumeTaskActionApprovals } from "./task-action-approval";

const turn = { id: "run_1", codexChatSessionId: "runtime_1", leaseId: "lease_1" } as CodexChatTurn;
const request: TaskActionRequest = {
  invocationId: "task_action_1",
  action: "plugin:gmail:gmail.create_draft",
  params: { to: "recipient@example.com", subject: "Hello", body: "Ready." },
  decision: "approved",
  executionStatus: "pending",
  result: null,
};

function dependencies(overrides: Partial<TaskActionRequest> = {}) {
  return {
    repository: {
      requests: vi.fn(async () => [{ ...request, ...overrides }]),
      claim: vi.fn(async () => true),
      complete: vi.fn(async () => true),
    },
    execute: vi.fn(async () => ({
      ok: true as const,
      action: request.action,
      result: { draftId: "draft_1" },
    })),
  };
}

describe("task action approval continuation", () => {
  it("executes the saved inputs once and supplies the result to the resumed engine", async () => {
    const deps = dependencies();
    const context = await resumeTaskActionApprovals(turn, deps);
    expect(deps.execute).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        request: {
          operation: "execute",
          sessionId: "runtime_1",
          turnId: "run_1",
          invocationId: request.invocationId,
          action: request.action,
          params: request.params,
        },
      }),
    );
    expect(deps.repository.complete).toHaveBeenCalledWith(
      expect.objectContaining({ result: expect.objectContaining({ ok: true }) }),
    );
    expect(context).toContain("draft_1");
    expect(context).toContain("do not execute them again");
  });

  it("parks a request still awaiting approval without executing it", async () => {
    const deps = dependencies({ decision: "pending" });
    const beforeResume = vi.fn(async () => undefined);
    await expect(resumeTaskActionApprovals(turn, deps, beforeResume)).rejects.toBeInstanceOf(
      TaskActionApprovalPauseError,
    );
    expect(beforeResume).toHaveBeenCalledOnce();
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it("delivers denial to the engine without contacting the provider", async () => {
    const deps = dependencies({ decision: "denied" });
    expect(await resumeTaskActionApprovals(turn, deps)).toContain("The user denied this action");
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it("reuses a persisted result after a restart", async () => {
    const deps = dependencies({
      executionStatus: "completed",
      result: { ok: true, action: request.action, result: { draftId: "existing_draft" } },
    });
    expect(await resumeTaskActionApprovals(turn, deps)).toContain("existing_draft");
    expect(deps.repository.claim).not.toHaveBeenCalled();
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it("does not repeat a write whose outcome was lost during a restart", async () => {
    const deps = dependencies({ executionStatus: "executing" });
    expect(await resumeTaskActionApprovals(turn, deps)).toContain("outcome is uncertain");
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it("does not execute if cancellation or another worker prevented the claim", async () => {
    const deps = dependencies();
    deps.repository.claim.mockResolvedValue(false);
    await expect(resumeTaskActionApprovals(turn, deps)).rejects.toBeInstanceOf(
      CodexChatLeaseLostError,
    );
    expect(deps.execute).not.toHaveBeenCalled();
  });
});

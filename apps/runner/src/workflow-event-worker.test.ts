import { describe, expect, it, vi } from "vitest";
import {
  createNextWorkflowEventTask,
  eventHarness,
  workflowEventRetryDelayMs,
} from "./workflow-event-worker";

describe("workflow event worker", () => {
  it("replaces the planned placeholder with the provider event goal", () => {
    const harness = eventHarness({
      workflowName: "Triage issues",
      goal: "Assess this issue.\n\n<linear_issue_context>\nTitle: Billing bug\n</linear_issue_context>",
      harnessSpec: {
        schemaVersion: "goat.harness.v1",
        engine: "opencompany",
        model: "openai/gpt-5.4",
        systemPrompt: "Follow the workflow.",
        initialUserMessage: "placeholder",
        tools: [],
        skills: [],
        maxModelSteps: 16,
        resultMode: "assistant_final",
      },
    });

    expect(harness.initialUserMessage).toBe(
      "Task: Triage issues\n\nAssess this issue.\n\n<linear_issue_context>\nTitle: Billing bug\n</linear_issue_context>",
    );
    expect(harness.systemPrompt).toBe("Follow the workflow.");
  });

  it("creates one task and marks the durable event created", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([pendingEvent(true)])
      .mockResolvedValueOnce([]);
    const createTask = vi.fn(async () => ({ taskId: "task_1" }));
    const db = {
      transaction: async (callback: (tx: { execute: typeof execute }) => unknown) =>
        callback({ execute }),
    };

    await expect(
      createNextWorkflowEventTask(new Date("2026-08-20T12:00:00.000Z"), {
        db: db as never,
        createTask,
      }),
    ).resolves.toEqual({ status: "created", eventId: "event_1", taskId: "task_1" });
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({ execute }),
      expect.objectContaining({ id: "event_1" }),
      new Date("2026-08-20T12:00:00.000Z"),
    );
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("ignores an event when its run-as user is no longer eligible", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([pendingEvent(false)])
      .mockResolvedValueOnce([]);
    const createTask = vi.fn();
    const db = {
      transaction: async (callback: (tx: { execute: typeof execute }) => unknown) =>
        callback({ execute }),
    };

    await expect(
      createNextWorkflowEventTask(new Date("2026-08-20T12:00:00.000Z"), {
        db: db as never,
        createTask,
      }),
    ).resolves.toEqual({ status: "ignored", eventId: "event_1" });
    expect(createTask).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("backs off a failed event so it cannot starve later deliveries", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([pendingEvent(true)])
      .mockResolvedValueOnce([]);
    const db = {
      transaction: async (callback: (tx: { execute: typeof execute }) => unknown) =>
        callback({ execute }),
    };

    await expect(
      createNextWorkflowEventTask(new Date("2026-08-20T12:00:00.000Z"), {
        db: db as never,
        createTask: vi.fn().mockRejectedValue(new Error("model unavailable")),
      }),
    ).resolves.toEqual({ status: "retry", eventId: "event_1" });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(workflowEventRetryDelayMs(1)).toBe(1_000);
    expect(workflowEventRetryDelayMs(20)).toBe(15 * 60_000);
  });
});

function pendingEvent(eligible: boolean) {
  return {
    id: "event_1",
    workspaceId: "workspace_1",
    userWorkosId: "user_1",
    workflowSlug: "triage-issues",
    workflowName: "Triage issues",
    goal: "Assess this issue.",
    harnessSpec: {
      schemaVersion: "goat.harness.v1",
      engine: "opencompany",
      model: "openai/gpt-5.4",
      systemPrompt: "Follow the workflow.",
      initialUserMessage: "placeholder",
      tools: [],
      skills: [],
      maxModelSteps: 16,
      resultMode: "assistant_final",
    },
    attemptCount: 0,
    eligible,
  };
}

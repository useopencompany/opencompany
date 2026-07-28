import { describe, expect, it } from "vitest";
import {
  createOpenCompanyChatToolContext,
  OPENCOMPANY_CHAT_MAX_STEPS,
  prepareOpenCompanyChatStep,
  UPDATE_TASK_STATUS_TOOL_NAME,
} from "./chat-agent";

const model = "moonshotai/kimi-k2.6" as never;

describe("update_task_status tool gating", () => {
  it("is absent when no updateTaskStatus runner is injected (interactive chat / Slack)", () => {
    const context = createOpenCompanyChatToolContext({ model });
    expect(UPDATE_TASK_STATUS_TOOL_NAME in context.tools).toBe(false);
  });

  it("is present only when an updateTaskStatus runner is injected (task run)", async () => {
    const calls: Array<{ status: string; comment: string }> = [];
    const context = createOpenCompanyChatToolContext({
      model,
      updateTaskStatus: async ({ status, comment }) => {
        calls.push({ status, comment });
      },
    });
    expect(UPDATE_TASK_STATUS_TOOL_NAME in context.tools).toBe(true);

    const tool = context.tools[UPDATE_TASK_STATUS_TOOL_NAME] as {
      execute: (args: unknown) => Promise<unknown>;
    };
    const result = await tool.execute({
      status: "needs_attention",
      comment: "  Blocked on auth.  ",
    });
    expect(result).toEqual({
      ok: true,
      status: "needs_attention",
      comment: "Blocked on auth.",
    });
    expect(calls).toEqual([{ status: "needs_attention", comment: "Blocked on auth." }]);
  });
});

describe("prepareOpenCompanyChatStep maxSteps", () => {
  it("reserves the final step with the default chat budget", () => {
    expect(prepareOpenCompanyChatStep({ stepNumber: OPENCOMPANY_CHAT_MAX_STEPS - 2 })).toEqual({});
    expect(prepareOpenCompanyChatStep({ stepNumber: OPENCOMPANY_CHAT_MAX_STEPS - 1 })).toEqual({
      activeTools: [],
      toolChoice: "none",
    });
  });

  it("reserves the final step at a task's larger budget", () => {
    expect(prepareOpenCompanyChatStep({ stepNumber: 14, maxSteps: 16 })).toEqual({});
    expect(prepareOpenCompanyChatStep({ stepNumber: 15, maxSteps: 16 })).toEqual({
      activeTools: [],
      toolChoice: "none",
    });
  });
});

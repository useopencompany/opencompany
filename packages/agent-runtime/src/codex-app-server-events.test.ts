import { describe, expect, it } from "vitest";
import { normalizeCodexAppServerEvent } from "./codex-app-server-events";

describe("normalizeCodexAppServerEvent", () => {
  it("maps assistant deltas and completed agent messages", () => {
    expect(
      normalizeCodexAppServerEvent({
        method: "item/agentMessage/delta",
        params: { threadId: "thr_1", turnId: "turn_1", delta: "hello" },
      }),
    ).toEqual([
      {
        type: "assistant.delta",
        payload: { threadId: "thr_1", turnId: "turn_1", delta: "hello" },
        rawEvent: {
          method: "item/agentMessage/delta",
          params: { threadId: "thr_1", turnId: "turn_1", delta: "hello" },
        },
      },
    ]);

    expect(
      normalizeCodexAppServerEvent({
        method: "item/completed",
        params: { item: { id: "item_1", type: "agentMessage", text: "done" } },
      })[0],
    ).toMatchObject({
      type: "assistant.completed",
      payload: { itemId: "item_1", content: "done" },
    });
  });

  it("maps command activity", () => {
    expect(
      normalizeCodexAppServerEvent({
        method: "item/started",
        params: { item: { id: "cmd_1", type: "commandExecution", command: "bun test" } },
      })[0],
    ).toMatchObject({
      type: "command.started",
      payload: { itemId: "cmd_1", command: "bun test" },
    });

    expect(
      normalizeCodexAppServerEvent({
        method: "item/commandExecution/outputDelta",
        params: { itemId: "cmd_1", delta: "ok", stream: "stdout" },
      })[0],
    ).toMatchObject({
      type: "command.output",
      payload: { itemId: "cmd_1", delta: "ok", stream: "stdout" },
    });

    expect(
      normalizeCodexAppServerEvent({
        method: "item/completed",
        params: {
          item: { id: "cmd_1", type: "commandExecution", command: "bun test", status: "failed" },
        },
      })[0],
    ).toMatchObject({
      type: "command.failed",
      payload: { itemId: "cmd_1", command: "bun test" },
    });
  });

  it("maps reasoning, turn completion, usage, and errors", () => {
    expect(
      normalizeCodexAppServerEvent({
        method: "item/completed",
        params: { item: { id: "reason_1", type: "reasoning", summary: "looked around" } },
      })[0],
    ).toMatchObject({
      type: "reasoning.completed",
      payload: { itemId: "reason_1", text: "looked around" },
    });

    expect(
      normalizeCodexAppServerEvent({
        method: "turn/completed",
        params: { threadId: "thr_1", turn: { id: "turn_1", status: "completed" } },
      })[0],
    ).toMatchObject({
      type: "turn.completed",
      payload: { threadId: "thr_1", turnId: "turn_1", status: "completed" },
    });

    expect(
      normalizeCodexAppServerEvent({
        method: "thread/tokenUsage/updated",
        params: { tokenUsage: { total: 10 } },
      })[0],
    ).toMatchObject({
      type: "usage.updated",
      payload: { tokenUsage: { total: 10 } },
    });

    expect(
      normalizeCodexAppServerEvent({
        method: "error",
        params: { message: "bad" },
      })[0],
    ).toMatchObject({ type: "error", payload: { message: "bad" } });
  });

  it("maps plan and goal updates", () => {
    expect(
      normalizeCodexAppServerEvent({
        method: "item/plan/delta",
        params: { itemId: "plan_1", delta: "1. Inspect" },
      })[0],
    ).toMatchObject({
      type: "plan.updated",
      payload: { itemId: "plan_1", text: "1. Inspect", status: "running" },
    });

    expect(
      normalizeCodexAppServerEvent({
        method: "item/completed",
        params: { item: { id: "plan_1", type: "plan", text: "1. Inspect", status: "completed" } },
      })[0],
    ).toMatchObject({
      type: "plan.updated",
      payload: { itemId: "plan_1", text: "1. Inspect", status: "completed" },
    });

    expect(
      normalizeCodexAppServerEvent({
        method: "thread/goal/updated",
        params: {
          goal: {
            objective: "Finish the feature",
            status: "active",
            tokenBudget: 1000,
            tokensUsed: 25,
          },
        },
      })[0],
    ).toMatchObject({
      type: "goal.updated",
      payload: {
        objective: "Finish the feature",
        status: "active",
        tokenBudget: 1000,
        tokensUsed: 25,
      },
    });
  });

  it("maps user questions and approval requests", () => {
    expect(
      normalizeCodexAppServerEvent({
        method: "userInput/requested",
        params: { itemId: "question_1", question: "Which branch?" },
      })[0],
    ).toMatchObject({
      type: "question.requested",
      payload: { itemId: "question_1", question: "Which branch?" },
    });

    expect(
      normalizeCodexAppServerEvent({
        method: "approval/requested",
        params: { itemId: "approval_1", title: "Run command", action: "bun test" },
      })[0],
    ).toMatchObject({
      type: "approval.requested",
      payload: { itemId: "approval_1", title: "Run command", action: "bun test" },
    });
  });
});

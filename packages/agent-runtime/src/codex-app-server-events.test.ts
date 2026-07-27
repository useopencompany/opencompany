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

  it("maps file changes, MCP tool calls, and web searches", () => {
    expect(
      normalizeCodexAppServerEvent({
        method: "item/started",
        params: {
          item: {
            id: "file_1",
            type: "fileChange",
            changes: [{ path: "src/index.ts", kind: "edit" }],
          },
        },
      })[0],
    ).toMatchObject({
      type: "file_change.started",
      payload: { itemId: "file_1", changes: [{ path: "src/index.ts", kind: "edit" }] },
    });

    expect(
      normalizeCodexAppServerEvent({
        method: "item/completed",
        params: {
          item: {
            id: "file_1",
            type: "fileChange",
            status: "completed",
            changes: [{ path: "src/index.ts", kind: "edit" }, { path: "README.md" }],
          },
        },
      })[0],
    ).toMatchObject({
      type: "file_change.completed",
      payload: {
        itemId: "file_1",
        status: "completed",
        changes: [{ path: "src/index.ts", kind: "edit" }, { path: "README.md" }],
      },
    });

    expect(
      normalizeCodexAppServerEvent({
        method: "item/started",
        params: {
          item: { id: "mcp_1", type: "mcpToolCall", server: "linear", tool: "create_issue" },
        },
      })[0],
    ).toMatchObject({
      type: "mcp_tool.started",
      payload: { itemId: "mcp_1", server: "linear", tool: "create_issue" },
    });

    expect(
      normalizeCodexAppServerEvent({
        method: "item/completed",
        params: {
          item: {
            id: "mcp_1",
            type: "mcpToolCall",
            server: "linear",
            tool: "create_issue",
            status: "failed",
            error: { message: "auth expired" },
          },
        },
      })[0],
    ).toMatchObject({
      type: "mcp_tool.completed",
      payload: {
        itemId: "mcp_1",
        server: "linear",
        tool: "create_issue",
        status: "failed",
        error: "auth expired",
      },
    });

    expect(
      normalizeCodexAppServerEvent({
        method: "item/completed",
        params: { item: { id: "search_1", type: "webSearch", query: "vitest mock modules" } },
      })[0],
    ).toMatchObject({
      type: "web_search.completed",
      payload: { itemId: "search_1", query: "vitest mock modules", status: "completed" },
    });
  });

  it("maps dynamic host tool calls without exposing successful result content", () => {
    expect(
      normalizeCodexAppServerEvent({
        method: "item/started",
        params: {
          threadId: "thread_1",
          turnId: "turn_1",
          item: {
            id: "dynamic_1",
            type: "dynamicToolCall",
            tool: "goat_brain",
            arguments: { command: "query", flags: { text: "pricing" } },
          },
        },
      })[0],
    ).toMatchObject({
      type: "dynamic_tool.started",
      payload: {
        threadId: "thread_1",
        turnId: "turn_1",
        itemId: "dynamic_1",
        tool: "goat_brain",
        arguments: { command: "query", flags: { text: "pricing" } },
      },
    });

    expect(
      normalizeCodexAppServerEvent({
        method: "item/completed",
        params: {
          item: {
            id: "dynamic_1",
            type: "dynamicToolCall",
            tool: "goat_brain",
            status: "completed",
            success: true,
            contentItems: [{ type: "inputText", text: '{"private":"brain result"}' }],
          },
        },
      })[0],
    ).toMatchObject({
      type: "dynamic_tool.completed",
      payload: {
        itemId: "dynamic_1",
        tool: "goat_brain",
        status: "completed",
        success: true,
      },
    });
    expect(
      normalizeCodexAppServerEvent({
        method: "item/completed",
        params: {
          item: {
            id: "dynamic_2",
            type: "dynamicToolCall",
            tool: "goat_brain",
            status: "failed",
            success: false,
            contentItems: [
              {
                type: "inputText",
                text: '{"ok":false,"error":"Brain access expired.","traceId":"private"}',
              },
            ],
          },
        },
      })[0],
    ).toMatchObject({
      type: "dynamic_tool.completed",
      payload: {
        itemId: "dynamic_2",
        tool: "goat_brain",
        status: "failed",
        success: false,
        error: "Brain access expired.",
      },
    });
  });

  it("maps user questions and approval requests", () => {
    expect(
      normalizeCodexAppServerEvent({
        id: "request_7",
        method: "item/tool/requestUserInput",
        interactionId: "goat_codex_chat_interaction_1",
        params: {
          threadId: "thread_1",
          turnId: "turn_1",
          itemId: "question_1",
          autoResolutionMs: 15_000,
          questions: [
            {
              id: "branch",
              header: "Branch",
              question: "Which branch should I use?",
              options: [{ label: "main", description: "Use the default branch." }],
            },
          ],
        },
      })[0],
    ).toMatchObject({
      type: "question.requested",
      payload: {
        requestId: "request_7",
        method: "item/tool/requestUserInput",
        interactionId: "goat_codex_chat_interaction_1",
        threadId: "thread_1",
        turnId: "turn_1",
        itemId: "question_1",
        question: "Which branch should I use?",
        autoResolutionMs: 15_000,
      },
    });

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

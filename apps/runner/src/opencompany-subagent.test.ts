import type { ActionDispatcher } from "@opencompany/agent/chat-agent";
import type { ChatActionCatalog } from "@opencompany/agent/chat-ui";
import { createSubagentBudget } from "@opencompany/agent/subagent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  autoApprovedActionCatalog,
  createSubagentActionDispatcher,
  createSubagentRunner,
  createSubagentTraceChannel,
  replaceSubagentChildren,
  type SubagentTraceUpdate,
} from "./opencompany-subagent";

const runProductChatAgent = vi.hoisted(() => vi.fn());
vi.mock("@opencompany/agent/chat-agent", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runProductChatAgent,
}));

describe("replaceSubagentChildren", () => {
  it("replaces the children of the matching tool part", () => {
    const parts = [
      { type: "text", text: "before" },
      { type: "tool-run_subagent", toolCallId: "call_1", children: [] },
    ];

    const next = replaceSubagentChildren(parts, "call_1", [{ type: "text", text: "step" }]);

    expect(next?.[1]).toEqual({
      type: "tool-run_subagent",
      toolCallId: "call_1",
      children: [{ type: "text", text: "step" }],
    });
    expect(next?.[0], "sibling parts are untouched").toEqual({ type: "text", text: "before" });
  });

  it("finds a nested subagent so a depth-2 run lands under its own parent", () => {
    const parts = [
      {
        type: "tool-run_subagent",
        toolCallId: "outer",
        children: [{ type: "tool-run_subagent", toolCallId: "inner", children: [] }],
      },
    ];

    const next = replaceSubagentChildren(parts, "inner", [{ type: "text", text: "deep" }]);

    const outerChildren = next?.[0]?.children as Array<Record<string, unknown>>;
    expect(outerChildren[0]?.children).toEqual([{ type: "text", text: "deep" }]);
  });

  it("returns null when the tool call is not in the projection", () => {
    expect(replaceSubagentChildren([{ type: "text", text: "only" }], "missing", [])).toBeNull();
  });
});

describe("subagent action access", () => {
  const catalog: ChatActionCatalog = {
    sources: [
      { id: "linear", kind: "integration", label: "Linear", description: "Issues" },
      { id: "slack", kind: "integration", label: "Slack", description: "Messages" },
    ] as ChatActionCatalog["sources"],
    actions: [
      {
        id: "linear.get_issue",
        source: "linear",
        description: "Read",
        params: {},
        permissionMode: "on",
      },
      {
        id: "slack.send_message",
        source: "slack",
        description: "Post",
        params: {},
        permissionMode: "ask",
      },
    ] as ChatActionCatalog["actions"],
  };

  it("drops approval-gated actions and the sources left with none", () => {
    const narrowed = autoApprovedActionCatalog(catalog);

    expect(narrowed.actions.map((action) => action.id)).toEqual(["linear.get_issue"]);
    expect(narrowed.sources.map((source) => source.id)).toEqual(["linear"]);
  });

  it("refuses an approval-gated action even when the model names it directly", async () => {
    const execute = vi.fn();
    const dispatcher = createSubagentActionDispatcher({
      catalog,
      execute,
    } as unknown as ActionDispatcher);

    const result = await dispatcher.execute({
      action: "slack.send_message",
      params: {},
      toolCallId: "call_1",
    });

    expect(execute, "the parent dispatcher must never see it").not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe("not_permitted");
  });

  it("passes an auto-approved action through and never requests approval", async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true, action: "linear.get_issue", result: {} });
    const dispatcher = createSubagentActionDispatcher({
      catalog,
      execute,
      needsApproval: vi.fn().mockResolvedValue(true),
    } as unknown as ActionDispatcher);

    await dispatcher.execute({ action: "linear.get_issue", params: {}, toolCallId: "call_1" });

    expect(execute).toHaveBeenCalledOnce();
    await expect(
      dispatcher.needsApproval?.({ action: "linear.get_issue", params: {}, toolCallId: "call_1" }),
    ).resolves.toBe(false);
  });
});

describe("createSubagentRunner", () => {
  const updates: SubagentTraceUpdate[] = [];
  const recordUsage = vi.fn().mockResolvedValue(undefined);

  function runner(signal = new AbortController().signal) {
    const trace = createSubagentTraceChannel();
    trace.subscribe((update) => updates.push(update));
    return createSubagentRunner({
      model: "moonshotai/kimi-k2.6" as never,
      gatewayApiKey: "gw",
      workspaceId: "ws_1",
      userWorkosId: "user_1",
      chatSessionId: "chat_1",
      currentDate: new Date("2026-09-12T00:00:00Z"),
      signal,
      budget: createSubagentBudget(),
      trace,
      recordUsage,
      runners: { webSearch: vi.fn() },
    });
  }

  beforeEach(() => {
    updates.length = 0;
    recordUsage.mockClear();
    runProductChatAgent.mockReset();
  });

  it("returns the subagent's summary and runs it in its own context", async () => {
    runProductChatAgent.mockResolvedValue({ content: "  Pricing moved to usage-based.  " });

    const result = await runner()({
      description: "check pricing",
      task: "What changed in pricing?",
      toolCallId: "call_1",
      depth: 1,
    });

    expect(result).toEqual({ ok: true, summary: "Pricing moved to usage-based.", steps: 0 });
    const call = runProductChatAgent.mock.calls[0]?.[0];
    expect(call.messages, "the child sees only the task, never the parent transcript").toEqual([
      { role: "user", content: "What changed in pricing?" },
    ]);
    expect(call.subagent).toEqual({ depth: 1 });
    expect(call.wikiToolReadOnly).toBe(true);
  });

  it("streams each finished step into the parent's trace and bills it to the turn", async () => {
    runProductChatAgent.mockImplementation(async (options: Record<string, unknown>) => {
      const onStepFinish = options.onStepFinish as (step: unknown) => Promise<void>;
      await onStepFinish({
        text: "Looking at the pricing page.",
        toolCalls: [{ toolCallId: "t1", toolName: "web_search", input: { query: "pricing" } }],
        toolResults: [{ toolCallId: "t1", output: { ok: true } }],
        usage: { inputTokens: 10, outputTokens: 5 },
      });
      return { content: "done" };
    });

    const result = await runner()({
      description: "check pricing",
      task: "Check pricing",
      toolCallId: "call_1",
      depth: 1,
    });

    expect(result).toMatchObject({ ok: true, steps: 1 });
    expect(recordUsage).toHaveBeenCalledWith({ inputTokens: 10, outputTokens: 5 });
    const children = updates.at(-1)?.children ?? [];
    expect(updates.at(-1)?.parentToolCallId).toBe("call_1");
    expect(children).toEqual([
      { type: "text", text: "Looking at the pricing page.", state: "done" },
      {
        type: "tool-web_search",
        toolCallId: "t1",
        state: "output-available",
        input: { query: "pricing" },
        output: { ok: true },
      },
    ]);
  });

  it("reports a failed subagent instead of failing the parent turn", async () => {
    runProductChatAgent.mockRejectedValue(new Error("gateway exploded"));

    const result = await runner()({
      description: "check pricing",
      task: "Check pricing",
      toolCallId: "call_1",
      depth: 1,
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("gateway exploded");
  });

  it("rethrows when the turn itself was interrupted", async () => {
    const controller = new AbortController();
    runProductChatAgent.mockImplementation(async () => {
      controller.abort();
      throw new Error("aborted");
    });

    await expect(
      runner(controller.signal)({
        description: "check pricing",
        task: "Check pricing",
        toolCallId: "call_1",
        depth: 1,
      }),
    ).rejects.toThrow("aborted");
  });

  it("reports an empty summary as a failure rather than a silent success", async () => {
    runProductChatAgent.mockResolvedValue({ content: "   " });

    const result = await runner()({
      description: "check pricing",
      task: "Check pricing",
      toolCallId: "call_1",
      depth: 1,
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("without returning a summary");
  });
});

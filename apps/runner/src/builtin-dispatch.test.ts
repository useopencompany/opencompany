import type { AgentConfig } from "@opencompany/agent-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchBuiltinUseTool } from "./tool-dispatcher";

// The built-in `use_tool` dispatcher routes a deferred tool's body through executeRuntimeTool but
// persists the result under `use_tool` so it pairs with the model's dispatcher call. These tests
// mock the persistence + hosted-tool layers and assert that pairing + recoverable error handling.

const leaseWrites = vi.hoisted(() => ({
  appendRuntimeEventForLease: vi.fn((event) => Promise.resolve(event)),
  insertToolMessageForLease: vi.fn((message) => Promise.resolve(message)),
  requireLeaseWrite: vi.fn(async (write) => write),
}));

const hostedTools = vi.hoisted(() => ({
  executeHostedTool: vi.fn(async () => ({ output: { ok: true, hits: 1 } })),
  getHostedToolFailureContext: vi.fn(() => ({})),
}));

vi.mock("./lease-writes", () => ({
  ...leaseWrites,
  StaleRunLeaseError: class StaleRunLeaseError extends Error {},
}));

vi.mock("./model-messages", () => ({
  buildToolModelMessage: vi.fn((input) => ({ role: "tool", content: [input] })),
  serializeToolOutputForStorage: vi.fn((output) => JSON.stringify(output)),
  toPersistedModelMessage: vi.fn((message) => message),
}));

vi.mock("./hosted-tools", () => ({
  executeHostedTool: hostedTools.executeHostedTool,
  getHostedToolFailureContext: hostedTools.getHostedToolFailureContext,
  MissingEnvError: class MissingEnvError extends Error {},
}));

vi.mock("@opencompany/observability", () => ({
  captureException: vi.fn(),
  createLogger: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}));

const agentConfig: AgentConfig = {
  schemaVersion: "agent.v1",
  title: "Research",
  instructions: "Research.",
  model: { provider: "vercel-ai-gateway", name: "openai/gpt-5.4-mini" },
  tools: [{ id: "exa", type: "hosted_tool", label: "exa", description: "Web research." }],
  brain: [],
  integrations: { github: { repositories: [] } },
  triggers: [],
};

function baseInput(args: unknown) {
  return {
    sessionId: "session_1",
    assistantMessageId: "assistant_1",
    runLeaseId: "lease_1",
    runLeaseOwner: "owner_1",
    workspaceId: "workspace_1",
    agentConfig,
    toolCallId: "call_use",
    args,
    getSandbox: vi.fn(async () => ({}) as never),
    workdir: "/work",
    env: {} as never,
    enabledTools: ["exa_search"] as const,
    repository: null,
    signal: new AbortController().signal,
    checkAbort: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("dispatchBuiltinUseTool", () => {
  it("runs the underlying tool and persists the result under use_tool", async () => {
    const output = await dispatchBuiltinUseTool({
      ...baseInput({ tool: "exa_search", arguments: { query: "vercel" } }),
      enabledTools: ["exa_search"],
    });

    // The underlying hosted tool ran with only its own arguments.
    expect(hostedTools.executeHostedTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "exa_search", args: { query: "vercel" } }),
    );
    expect(output).toEqual({ ok: true, hits: 1 });

    // The persisted tool-result pairs with the model's `use_tool` call, not the underlying name.
    expect(leaseWrites.insertToolMessageForLease).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "use_tool", toolCallId: "call_use" }),
    );
    const completed = leaseWrites.appendRuntimeEventForLease.mock.calls
      .map((call) => call[0] as { type: string; payload: { name: string } })
      .find((event) => event.type === "tool.completed");
    expect(completed?.payload.name).toBe("use_tool");
  });

  it("returns a recoverable error for an unknown tool, persisted under use_tool", async () => {
    const output = (await dispatchBuiltinUseTool({
      ...baseInput({ tool: "does_not_exist", arguments: {} }),
      enabledTools: ["exa_search"],
    })) as { ok: boolean; error: { code: string; recoverable: boolean } };

    expect(hostedTools.executeHostedTool).not.toHaveBeenCalled();
    expect(output.ok).toBe(false);
    expect(output.error.code).toBe("unknown_runtime_tool");
    expect(output.error.recoverable).toBe(true);
    expect(leaseWrites.insertToolMessageForLease).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "use_tool" }),
    );
    const failed = leaseWrites.appendRuntimeEventForLease.mock.calls
      .map((call) => call[0] as { type: string; payload: { name: string } })
      .find((event) => event.type === "tool.failed");
    expect(failed?.payload.name).toBe("use_tool");
  });

  it("persists hosted tool failures as recoverable tool results instead of session errors", async () => {
    hostedTools.executeHostedTool.mockRejectedValueOnce(new Error("Exa search failed"));

    const output = (await dispatchBuiltinUseTool({
      ...baseInput({ tool: "exa_search", arguments: { query: "vercel" } }),
      enabledTools: ["exa_search"],
    })) as { ok: boolean; error: { message: string; code: string; recoverable: boolean } };

    expect(output).toEqual({
      ok: false,
      error: {
        message: "Exa search failed",
        code: "tool_execution_failed",
        recoverable: true,
      },
    });
    expect(leaseWrites.insertToolMessageForLease).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "use_tool", toolCallId: "call_use" }),
    );
    const events = leaseWrites.appendRuntimeEventForLease.mock.calls.map(
      (call) => call[0] as { type: string; payload: { name?: string; error?: unknown } },
    );
    expect(events.some((event) => event.type === "session.error")).toBe(false);
    const failed = events.find((event) => event.type === "tool.failed");
    expect(failed).toMatchObject({
      payload: {
        name: "use_tool",
        error: { code: "tool_execution_failed", recoverable: true },
      },
    });
  });

  it("rejects a tool that exists but is not enabled for the session", async () => {
    const output = (await dispatchBuiltinUseTool({
      ...baseInput({ tool: "amp_coder", arguments: {} }),
      enabledTools: ["exa_search"],
    })) as { ok: boolean; error: { code: string } };

    expect(hostedTools.executeHostedTool).not.toHaveBeenCalled();
    expect(output.ok).toBe(false);
    expect(output.error.code).toBe("unknown_runtime_tool");
  });

  it("rejects missing required arguments before running the tool, recoverably", async () => {
    const output = (await dispatchBuiltinUseTool({
      ...baseInput({ tool: "exa_search", arguments: {} }),
      enabledTools: ["exa_search"],
    })) as { ok: boolean; error: { code: string; message: string; recoverable: boolean } };

    expect(hostedTools.executeHostedTool).not.toHaveBeenCalled();
    expect(output.ok).toBe(false);
    expect(output.error.code).toBe("invalid_tool_input");
    expect(output.error.recoverable).toBe(true);
    expect(output.error.message).toContain('missing required "query"');
    expect(output.error.message).toContain('tool_help({ tool: "exa_search" })');
    const failed = leaseWrites.appendRuntimeEventForLease.mock.calls
      .map((call) => call[0] as { type: string; payload: { name: string } })
      .find((event) => event.type === "tool.failed");
    expect(failed?.payload.name).toBe("use_tool");
  });

  it("rejects an unknown top-level argument when the schema forbids extras", async () => {
    const output = (await dispatchBuiltinUseTool({
      ...baseInput({ tool: "exa_search", arguments: { query: "vercel", bogus: 1 } }),
      enabledTools: ["exa_search"],
    })) as { ok: boolean; error: { code: string; message: string } };

    expect(hostedTools.executeHostedTool).not.toHaveBeenCalled();
    expect(output.ok).toBe(false);
    expect(output.error.code).toBe("invalid_tool_input");
    expect(output.error.message).toContain('unexpected property "bogus"');
  });

  it("rejects a top-level argument of the wrong primitive type", async () => {
    const output = (await dispatchBuiltinUseTool({
      ...baseInput({ tool: "exa_search", arguments: { query: 123 } }),
      enabledTools: ["exa_search"],
    })) as { ok: boolean; error: { code: string; message: string } };

    expect(hostedTools.executeHostedTool).not.toHaveBeenCalled();
    expect(output.ok).toBe(false);
    expect(output.error.code).toBe("invalid_tool_input");
    expect(output.error.message).toContain('"query" must be a string');
  });

  it("routes the deferred update_agent_file through use_tool and enforces the self-edit gate", async () => {
    // update_agent_file is a standalone deferrable: dispatched via use_tool, it must reach the
    // internal handler (not be rejected as unknown) and still hit the read-skill gate, since the
    // skill was never read in this session.
    const output = (await dispatchBuiltinUseTool({
      ...baseInput({ tool: "update_agent_file", arguments: { instructions: "new" } }),
      enabledTools: ["update_agent_file"],
    })) as { ok: boolean; errors?: string[] };

    expect(hostedTools.executeHostedTool).not.toHaveBeenCalled();
    expect(output.ok).toBe(false);
    expect(output.errors?.[0]).toContain("Read the agent-self-edit skill first");
    expect(leaseWrites.insertToolMessageForLease).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "use_tool", toolCallId: "call_use" }),
    );
  });
});

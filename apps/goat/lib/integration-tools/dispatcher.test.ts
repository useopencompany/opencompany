import { describe, expect, it, vi } from "vitest";
import {
  createIntegrationToolDispatcher,
  validateIntegrationToolArguments,
} from "@/lib/integration-tools/dispatcher";
import {
  findIntegrationToolDefinition,
  integrationToolDefinitionsForProviders,
} from "@/lib/integration-tools/registry";

describe("createIntegrationToolDispatcher search", () => {
  it("returns all connected providers' tools for an empty query", () => {
    const dispatcher = createIntegrationToolDispatcher({
      connectedProviders: ["linear", "gmail"],
      executors: { linear: vi.fn(), gmail: vi.fn() },
    });
    const output = dispatcher.search({ query: "" });
    if (!output.ok) throw new Error(output.error);
    expect(output.tools.map((tool) => tool.name).sort()).toEqual(
      integrationToolDefinitionsForProviders(["linear", "gmail"])
        .map((definition) => definition.name)
        .sort(),
    );
    expect(output.tools[0]?.inputSchema.type).toBe("object");
  });

  it("returns a provider's full set when the query names the provider", () => {
    const dispatcher = createIntegrationToolDispatcher({
      connectedProviders: ["linear", "slack"],
      executors: { linear: vi.fn(), slack: vi.fn() },
    });
    const output = dispatcher.search({ query: "linear" });
    if (!output.ok) throw new Error(output.error);
    const linearNames = integrationToolDefinitionsForProviders(["linear"]).map(
      (definition) => definition.name,
    );
    for (const name of linearNames) {
      expect(output.tools.map((tool) => tool.name)).toContain(name);
    }
  });

  it("never returns tools for disconnected providers", () => {
    const dispatcher = createIntegrationToolDispatcher({
      connectedProviders: ["linear"],
      executors: { linear: vi.fn() },
    });
    const output = dispatcher.search({ query: "email inbox" });
    if (!output.ok) throw new Error(output.error);
    expect(output.tools.every((tool) => tool.provider === "linear")).toBe(true);
  });

  it("ranks keyword matches above description matches", () => {
    const dispatcher = createIntegrationToolDispatcher({
      connectedProviders: ["gmail"],
      executors: { gmail: vi.fn() },
    });
    const output = dispatcher.search({ query: "unread inbox" });
    if (!output.ok) throw new Error(output.error);
    expect(output.tools[0]?.name).toBe("gmail_search_emails");
  });

  it("returns guidance instead of an error on zero hits", () => {
    const dispatcher = createIntegrationToolDispatcher({
      connectedProviders: ["linear"],
      executors: { linear: vi.fn() },
    });
    const output = dispatcher.search({ query: "zzzzqqqq" });
    if (!output.ok) throw new Error(output.error);
    expect(output.tools).toEqual([]);
    expect(output.guidance).toContain("linear");
  });

  it("errors when no providers are connected", () => {
    const dispatcher = createIntegrationToolDispatcher({
      connectedProviders: [],
      executors: {},
    });
    expect(dispatcher.search({ query: "anything" })).toEqual({
      ok: false,
      error: "No integrations are connected.",
    });
  });
});

describe("createIntegrationToolDispatcher call", () => {
  it("rejects unknown tool names with the available names", async () => {
    const dispatcher = createIntegrationToolDispatcher({
      connectedProviders: ["linear"],
      executors: { linear: vi.fn() },
    });
    const output = await dispatcher.call({ tool: "linear_delete_everything" });
    expect(output.ok).toBe(false);
    if (output.ok) return;
    expect(output.error).toContain("Unknown integration tool");
    expect(output.availableTools).toContain("linear_list_issues");
  });

  it("rejects tools whose provider is not connected", async () => {
    const dispatcher = createIntegrationToolDispatcher({
      connectedProviders: ["linear"],
      executors: { linear: vi.fn() },
    });
    const output = await dispatcher.call({
      tool: "gmail_search_emails",
      arguments: { account: "a@b.co", query: "is:unread" },
    });
    expect(output.ok).toBe(false);
    if (output.ok) return;
    expect(output.error).toContain("Gmail is not connected");
  });

  it("returns validation errors without invoking the executor", async () => {
    const execute = vi.fn();
    const dispatcher = createIntegrationToolDispatcher({
      connectedProviders: ["linear"],
      executors: { linear: execute },
    });
    const output = await dispatcher.call({
      tool: "linear_list_issues",
      arguments: { state: "done", limit: "20", nonsense: true },
    });
    expect(output.ok).toBe(false);
    if (output.ok) return;
    expect(output.validationErrors).toEqual([
      'Argument "state" must be one of: triage, backlog, unstarted, started, completed, canceled.',
      'Argument "limit" must be of type number.',
      'Unknown argument "nonsense".',
    ]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("reports missing required arguments", async () => {
    const dispatcher = createIntegrationToolDispatcher({
      connectedProviders: ["gmail"],
      executors: { gmail: vi.fn() },
    });
    const output = await dispatcher.call({ tool: "gmail_search_emails", arguments: {} });
    expect(output.ok).toBe(false);
    if (output.ok) return;
    expect(output.validationErrors).toEqual([
      'Missing required argument "account".',
      'Missing required argument "query".',
    ]);
  });

  it("executes valid calls and bounds the result", async () => {
    const execute = vi.fn().mockResolvedValue({ issues: ["ENG-1"], note: "x".repeat(5000) });
    const dispatcher = createIntegrationToolDispatcher({
      connectedProviders: ["linear"],
      executors: { linear: execute },
    });
    const output = await dispatcher.call({
      tool: "linear_list_issues",
      arguments: { teamKey: "ENG", limit: 5 },
    });
    expect(output.ok).toBe(true);
    if (!output.ok) return;
    expect(output.tool).toBe("linear_list_issues");
    expect(output.truncated).toBe(true);
    expect(execute).toHaveBeenCalledWith({
      tool: findIntegrationToolDefinition("linear_list_issues"),
      args: { teamKey: "ENG", limit: 5 },
    });
  });

  it("caps thrown executor error messages", async () => {
    const dispatcher = createIntegrationToolDispatcher({
      connectedProviders: ["slack"],
      executors: {
        slack: vi.fn().mockRejectedValue(new Error("boom ".repeat(500))),
      },
    });
    const output = await dispatcher.call({
      tool: "slack_list_channels",
      arguments: {},
    });
    expect(output.ok).toBe(false);
    if (output.ok) return;
    expect(output.error.length).toBeLessThanOrEqual(620);
    expect(output.error.endsWith("… [truncated]")).toBe(true);
  });
});

describe("validateIntegrationToolArguments", () => {
  it("accepts a fully valid argument object", () => {
    const definition = findIntegrationToolDefinition("slack_get_thread");
    expect(
      validateIntegrationToolArguments(definition!, {
        channel: "#product",
        threadTs: "1720000000.123456",
        limit: 10,
      }),
    ).toEqual([]);
  });
});

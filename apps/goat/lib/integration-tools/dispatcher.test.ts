import { describe, expect, it, vi } from "vitest";
import {
  createIntegrationToolDispatcher,
  type IntegrationProviderExecutor,
  validateIntegrationToolArguments,
} from "@/lib/integration-tools/dispatcher";
import { findIntegrationToolCard } from "@/lib/integration-tools/registry";

function stubExecutor(overrides: Partial<IntegrationProviderExecutor> = {}) {
  return {
    execute: vi.fn(async () => ({ ok: true })),
    inspect: vi.fn(async () => ({ inputSchema: { type: "object" }, conventions: [] })),
    ...overrides,
  } satisfies IntegrationProviderExecutor;
}

function bothConnectedDispatcher(executors?: {
  linear?: IntegrationProviderExecutor;
  github?: IntegrationProviderExecutor;
}) {
  return createIntegrationToolDispatcher({
    connectedProviders: ["linear", "github"],
    activatedProviders: ["github"],
    executors: {
      linear: executors?.linear ?? stubExecutor(),
      github: executors?.github ?? stubExecutor(),
    },
  });
}

describe("createIntegrationToolDispatcher", () => {
  it("exposes connected integrations and caps Level 1 cards to activated providers", () => {
    const dispatcher = bothConnectedDispatcher();
    expect(dispatcher.connectedIntegrations.map((entry) => entry.provider)).toEqual([
      "linear",
      "github",
    ]);
    expect(dispatcher.level1CardsText).toContain("tool://github/");
    expect(dispatcher.level1CardsText).not.toContain("tool://linear/");
  });

  it("drops activated providers whose executor is missing", () => {
    const dispatcher = createIntegrationToolDispatcher({
      connectedProviders: ["linear", "github"],
      activatedProviders: ["linear", "github"],
      executors: { github: stubExecutor() },
    });
    expect(dispatcher.connectedIntegrations.map((entry) => entry.provider)).toEqual(["github"]);
    expect(dispatcher.activatedProviders).toEqual(["github"]);
  });

  it("searches only connected providers' catalogs", () => {
    const dispatcher = createIntegrationToolDispatcher({
      connectedProviders: ["github"],
      activatedProviders: [],
      executors: { github: stubExecutor() },
    });
    const result = dispatcher.search({ query: "issues" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tools.length).toBeGreaterThan(0);
      expect(result.tools.every((tool) => tool.pointer.startsWith("tool://github/"))).toBe(true);
    }
  });

  it("rejects malformed pointers with a recoverable error", async () => {
    const dispatcher = bothConnectedDispatcher();
    const result = await dispatcher.call({ pointer: "linear/list_issues" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Invalid pointer");
  });

  it("rejects pointers for disconnected providers", async () => {
    const dispatcher = createIntegrationToolDispatcher({
      connectedProviders: ["github"],
      activatedProviders: [],
      executors: { github: stubExecutor() },
    });
    const call = await dispatcher.call({ pointer: "tool://linear/list_issues" });
    expect(call.ok).toBe(false);
    if (!call.ok) expect(call.error).toContain("not connected");

    const inspect = await dispatcher.inspect({ pointer: "integration://linear" });
    expect(inspect.ok).toBe(false);
  });

  it("rejects unknown tools with the provider's available tools", async () => {
    const dispatcher = bothConnectedDispatcher();
    const result = await dispatcher.call({ pointer: "tool://github/delete_repository" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.availableTools?.length).toBeGreaterThan(0);
    }
  });

  it("rejects calling an integration:// pointer directly", async () => {
    const dispatcher = bothConnectedDispatcher();
    const result = await dispatcher.call({ pointer: "integration://github" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.availableTools?.length).toBeGreaterThan(0);
  });

  it("returns structured validation errors with the compact signature", async () => {
    const execute = vi.fn();
    const dispatcher = bothConnectedDispatcher({ github: stubExecutor({ execute }) });
    const result = await dispatcher.call({
      pointer: "tool://github/get_issue",
      arguments: { repository: 42, extra: true },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.validationErrors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('"repository" must be of type string'),
          expect.stringContaining('Missing required argument "number"'),
          expect.stringContaining('Unknown argument "extra"'),
        ]),
      );
      expect(result.signature).toContain("get_issue(");
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("executes valid calls through the provider executor and bounds the result", async () => {
    const execute = vi.fn(async () => ({ issues: [{ title: "x".repeat(10_000) }] }));
    const dispatcher = bothConnectedDispatcher({ github: stubExecutor({ execute }) });
    const result = await dispatcher.call({
      pointer: "tool://github/list_issues",
      arguments: { repository: "acme/app", state: "open" },
    });
    expect(execute).toHaveBeenCalledWith({
      tool: expect.objectContaining({ name: "list_issues" }),
      args: { repository: "acme/app", state: "open" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.truncated).toBe(true);
      expect(JSON.stringify(result.result).length).toBeLessThan(40_000);
    }
  });

  it("wraps executor failures as recoverable errors", async () => {
    const dispatcher = bothConnectedDispatcher({
      github: stubExecutor({
        execute: vi.fn(async () => {
          throw new Error("GitHub is not connected for this workspace.");
        }),
      }),
    });
    const result = await dispatcher.call({
      pointer: "tool://github/list_repositories",
      arguments: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not connected");
      expect(result.signature).toContain("list_repositories(");
    }
  });

  it("inspecting an integration:// pointer lists the provider's tools", async () => {
    const dispatcher = bothConnectedDispatcher();
    const result = await dispatcher.inspect({ pointer: "integration://linear" });
    expect(result.ok).toBe(true);
    if (result.ok && "tools" in result) {
      expect(result.tools.length).toBeGreaterThan(0);
    } else {
      throw new Error("expected a provider tool listing");
    }
  });
});

describe("validateIntegrationToolArguments", () => {
  const card = findIntegrationToolCard("github", "list_issues");
  if (!card) throw new Error("registry card missing");

  it("accepts optional fields and enum values", () => {
    expect(
      validateIntegrationToolArguments(card, { repository: "acme/app", state: "all", limit: 5 }),
    ).toEqual([]);
  });

  it("flags invalid enum values", () => {
    expect(
      validateIntegrationToolArguments(card, { repository: "acme/app", state: "merged" }),
    ).toEqual([expect.stringContaining('"state" must be one of')]);
  });
});

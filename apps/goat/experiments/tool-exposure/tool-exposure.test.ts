import { describe, expect, it } from "vitest";
import {
  createFlatRuntime,
  createTieredRuntime,
  estimateInitialContextTokens,
  renderLevel0,
  renderLevel1,
  renderLevel2,
} from "./exposure";
import {
  BASE_INTEGRATIONS,
  createScaledRegistry,
  registryToolCount,
  resolveTool,
} from "./registry";
import { scoreToolSelection } from "./scoring";
import { BENCHMARK_TASKS } from "./tasks";
import { matchIntegrations } from "./trigger";

describe("tool exposure registry", () => {
  it("contains five integrations with 20 losslessly addressable tools each", () => {
    expect(BASE_INTEGRATIONS).toHaveLength(5);
    expect(registryToolCount(BASE_INTEGRATIONS)).toBe(100);
    for (const integration of BASE_INTEGRATIONS) {
      expect(integration.tools).toHaveLength(20);
      expect(integration.pointer).toBe(`integration://${integration.id}`);
      expect(renderLevel0([integration])).toContain(integration.pointer);
      expect(renderLevel1(integration, false)).toContain(integration.pointer);
      for (const definition of integration.tools) {
        expect(resolveTool(BASE_INTEGRATIONS, integration.id, definition.name)).toBe(definition);
        expect(renderLevel1(integration, false)).toContain(
          `tool://${integration.id}/${definition.name}`,
        );
        expect(renderLevel2(integration, definition).pointer).toBe(
          `tool://${integration.id}/${definition.name}`,
        );
      }
    }
  });

  it("keeps synthetic scaling nodes losslessly addressable", () => {
    const registry = createScaledRegistry(12);
    expect(registry).toHaveLength(12);
    expect(registryToolCount(registry)).toBe(240);
    expect(new Set(registry.map((integration) => integration.pointer)).size).toBe(12);
  });

  it("resolves every tool expected by the benchmark tasks", () => {
    for (const task of BENCHMARK_TASKS) {
      for (const expected of task.expectedTools) {
        expect(
          resolveTool(BASE_INTEGRATIONS, expected.integrationId, expected.toolName),
          `${task.id}: ${expected.pointer}`,
        ).toBeDefined();
      }
    }
  });
});

describe("deterministic trigger", () => {
  it("expands every explicitly needed integration in a five-way task", () => {
    const task = BENCHMARK_TASKS.find((item) => item.id === "five-source-digest")!;
    const result = matchIntegrations(task.prompt, BASE_INTEGRATIONS);
    expect(new Set(result.expandedIntegrationIds)).toEqual(
      new Set(["linear", "attio", "slack", "github", "notion"]),
    );
    expect(result.reasons.every((reason) => reason.pattern && reason.match)).toBe(true);
  });

  it("preserves the deliberate false negative for recovery testing", () => {
    const task = BENCHMARK_TASKS.find((item) => item.id === "implicit-slack-broadcast")!;
    expect(matchIntegrations(task.prompt, BASE_INTEGRATIONS).expandedIntegrationIds).not.toContain(
      "slack",
    );
    expect(renderLevel0(BASE_INTEGRATIONS)).toContain("integration://slack");
  });

  it("matches each task's declared deterministic expansion expectation", () => {
    for (const task of BENCHMARK_TASKS) {
      const actual = matchIntegrations(task.prompt, BASE_INTEGRATIONS).expandedIntegrationIds;
      expect(new Set(actual), task.id).toEqual(new Set(task.triggerShouldExpand));
    }
  });
});

describe("tiered exposure", () => {
  it("uses substantially less initial context than flat exposure", () => {
    const task = BENCHMARK_TASKS[0]!;
    const flat = estimateInitialContextTokens(createFlatRuntime(BASE_INTEGRATIONS), task.prompt);
    const tiered = estimateInitialContextTokens(
      createTieredRuntime(task.prompt, BASE_INTEGRATIONS),
      task.prompt,
    );
    expect(tiered).toBeLessThan(flat * 0.15);
  });

  it("resolves Level 2 at call time and validates the full schema", async () => {
    const task = BENCHMARK_TASKS[0]!;
    const runtime = createTieredRuntime(task.prompt, BASE_INTEGRATIONS);
    const callable = runtime.tools.call_integration_tool as unknown as {
      execute: (input: unknown) => Promise<unknown>;
    };
    const result = await callable.execute({
      integration: "linear",
      tool: "create_issue",
      arguments: { teamKey: "ENG", title: "Test" },
    });
    expect(result).toMatchObject({ ok: true });
    expect(runtime.observedToolCalls).toMatchObject([
      { integrationId: "linear", toolName: "create_issue", valid: true },
    ]);
    expect(runtime.expansionTrace).toContainEqual(
      expect.objectContaining({
        level: 2,
        integrationId: "linear",
        toolName: "create_issue",
        reason: "call_time",
      }),
    );
  });
});

describe("scoring", () => {
  it("requires every expected tool and rejects unrelated calls", () => {
    const task = BENCHMARK_TASKS[0]!;
    expect(
      scoreToolSelection(task, [
        {
          integrationId: "linear",
          toolName: "create_issue",
          arguments: {},
          valid: true,
        },
      ]).exact,
    ).toBe(true);
    expect(
      scoreToolSelection(task, [
        {
          integrationId: "linear",
          toolName: "create_issue",
          arguments: {},
          valid: true,
        },
        {
          integrationId: "slack",
          toolName: "send_message",
          arguments: {},
          valid: true,
        },
      ]).exact,
    ).toBe(false);
  });
});

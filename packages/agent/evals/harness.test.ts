import { generateText, type ToolSet } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { CHAT_MAX_STEPS } from "../src/chat-agent";
import * as prompts from "../src/prompts";
import { loadCatalog } from "./fixtures";
import { CostBudget, gradeTrial, readCost, runTrial } from "./harness";
import { scenarios } from "./scenarios";
import { ln } from "./scenarios/discovery";
import type { Scenario, Trial } from "./types";

const model = "moonshotai/kimi-k2.6";
const get = (id: string) => scenarios.find((s) => s.id === id)!;
const call = (name: string, input: unknown) => ({
  type: "tool-call" as const,
  toolCallId: crypto.randomUUID(),
  toolName: name,
  input: JSON.stringify(input),
});
const text = (value: string) => ({ type: "text" as const, text: value });
type Content = ReturnType<typeof call> | ReturnType<typeof text>;
function scripted(turns: Content[][], cost: string | null = "0.01") {
  let index = 0;
  const doGenerate = vi.fn(async () => {
    const content = turns[index++];
    if (!content) throw new Error("Unexpected extra model call");
    return {
      content,
      finishReason: {
        unified: content.some((c) => c.type === "tool-call")
          ? ("tool-calls" as const)
          : ("stop" as const),
        raw: "stop",
      },
      usage: {
        inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 20, text: 20, reasoning: 0 },
      },
      warnings: [],
      providerMetadata: { gateway: { cost } },
    };
  });
  const fake = new MockLanguageModelV4({ doGenerate });
  return {
    doGenerate,
    generate: ((options: Parameters<typeof generateText>[0]) =>
      generateText({ ...options, model: fake })) as typeof generateText,
  };
}
const catalog = await loadCatalog();
async function run(scenario: Scenario, generate: typeof generateText, budget = new CostBudget(5)) {
  return runTrial({
    scenario,
    model,
    variant: "v5",
    repeat: 0,
    apiKey: "synthetic-key",
    budget,
    catalog,
    generate,
  });
}

describe("real harness benchmark", () => {
  it.each([
    ["deepseek/deepseek-v4-flash", "deepinfra"],
    ["alibaba/qwen3.8-max", "alibaba"],
  ] as const)("pins %s to an available gateway provider", async (model, provider) => {
    const script = scripted([[text("No changes made: unavailable.")]]);
    const trial = await runTrial({
      scenario: get("unavailable"),
      model,
      variant: "v5",
      repeat: 0,
      apiKey: "synthetic-key",
      budget: new CostBudget(1),
      catalog,
      generate: (async (options) => {
        expect(options.providerOptions?.gateway).toEqual({ only: [provider], caching: "auto" });
        return script.generate(options);
      }) as typeof generateText,
    });
    expect(trial.status).toBe("passed");
    expect(trial.provider).toBe(provider);
  });

  it("uses the production prompt and tool schemas, and fingerprints actual prompt changes", async () => {
    const seen: { system?: unknown; tools?: ToolSet } = {};
    const script = scripted([[text("No changes made: unavailable.")]]);
    const trial = await run(get("unavailable"), (async (options) => {
      seen.system = options.system;
      seen.tools = options.tools!;
      return script.generate(options);
    }) as typeof generateText);
    expect(String(seen.system)).toContain("opencompany");
    expect(Object.keys(seen.tools!)).toEqual(["list_actions", "describe_actions", "use_action"]);
    expect(trial.status).toBe("passed");
    const inspect = await runTrial({
      scenario: get("unavailable"),
      model,
      variant: "v4",
      repeat: 0,
      apiKey: "test",
      budget: new CostBudget(1),
      inspectOnly: true,
      catalog,
    });
    expect(inspect.fingerprint).not.toBe(trial.fingerprint);
    const originalPrompt = prompts.createProductChatSystemPrompt;
    const promptSpy = vi
      .spyOn(prompts, "createProductChatSystemPrompt")
      .mockImplementation(
        (input) => `${originalPrompt(input)}\nCandidate production prompt change.`,
      );
    try {
      const changed = await runTrial({
        scenario: get("unavailable"),
        model,
        variant: "v5",
        repeat: 0,
        apiKey: "test",
        budget: new CostBudget(1),
        inspectOnly: true,
        catalog,
      });
      expect(changed.fingerprint).not.toBe(trial.fingerprint);
    } finally {
      promptSpy.mockRestore();
    }
    expect(CHAT_MAX_STEPS).toBe(8);
  });

  it("validates create parameters and the result through the production action service", async () => {
    const script = scripted([
      [call("describe_actions", { actions: [`${ln}save_issue`] })],
      [
        call("use_action", {
          action: `${ln}save_issue`,
          params: {
            team: "Product",
            title: "Sidebar collapse resets after refresh",
            description: "Collapse the sidebar and refresh. It should stay collapsed.",
          },
        }),
      ],
      [text("Created DEMO-3.")],
    ]);
    const trial = await run(get("linear-file-issue"), script.generate);
    expect(trial.status).toBe("passed");
    expect(trial).toMatchObject({
      inputTokens: 300,
      outputTokens: 60,
      costUsd: 0.03,
      steps: 3,
      toolCalls: 2,
    });
    expect(trial.debugTrace?.schemaVersion).toBe("opencompany.chat.debug.v1");
    expect(trial.executions).toMatchObject([{ valid: true, schemaVisible: true, success: true }]);
  });

  it("pauses an ask-mode action, then executes exactly once after synthetic approval", async () => {
    const script = scripted([
      [call("describe_actions", { actions: [`${ln}save_issue`] })],
      [
        call("use_action", {
          action: `${ln}save_issue`,
          params: { id: "DEMO-1", title: "Launch review" },
        }),
      ],
      [text("Renamed DEMO-1 to Launch review.")],
    ]);
    const trial = await run(get("approval-resume"), script.generate);
    expect(trial.failures).toEqual([]);
    expect(trial.status).toBe("passed");
    expect(trial.approvals).toEqual([{ count: 1, executionsBeforeApproval: 0 }]);
    expect(trial.executions).toHaveLength(1);
    expect(trial.executions[0]?.approved).toBe(true);
    expect(script.doGenerate.mock.calls).toHaveLength(3);
  });

  it("fails schema-before-execute even when the production service admits a discovered source", async () => {
    const script = scripted([
      [call("list_actions", { source: "plugin:linear:linear" })],
      [call("use_action", { action: `${ln}get_issue`, params: { id: "DEMO-1" } })],
      [text("Launch checklist, Todo.")],
    ]);
    const trial = await run(get("small-integration"), script.generate);
    expect(trial.failures).toContain("schema before execute");
    expect(trial.costUsd).toBe(0.03);
  });

  it("does not credit schemas returned by a parallel tool call in the same model response", async () => {
    const script = scripted([
      [call("list_actions", { source: "plugin:linear:linear" })],
      [
        call("describe_actions", { actions: [`${ln}get_issue`] }),
        call("use_action", { action: `${ln}get_issue`, params: { id: "DEMO-1" } }),
      ],
      [text("Launch checklist, Todo.")],
    ]);
    const trial = await run(get("small-integration"), script.generate);
    expect(trial.failures).toContain("schema before execute");
  });

  it("rejects malformed parameters and prohibited writes in the safety twin", async () => {
    const script = scripted([
      [call("describe_actions", { actions: [`${ln}save_issue`] })],
      [
        call("use_action", {
          action: `${ln}save_issue`,
          params: { id: "DEMO-10", assigneeId: "wrong-key" },
        }),
      ],
      [text("Which issue: DEMO-10 or DEMO-11?")],
    ]);
    const trial = await run(get("linear-ambiguous-update"), script.generate);
    expect(trial.status).toBe("failed");
    expect(trial.invalidArguments).toBe(1);
    expect(trial.failures).toContain("prohibited action");
    expect(trial.executions.every((e) => !e.success)).toBe(true);
  });

  it("grades prohibited attempts even when the SDK rejects the tool before execution", async () => {
    const script = scripted([
      [call("use_action", { action: `${ln}delete_issue`, params: { id: "DEMO-1" } })],
      [text("That action is unavailable; no changes made.")],
    ]);
    const trial = await run(get("unavailable"), script.generate);
    expect(trial.executions).toHaveLength(0);
    expect(trial.failures).toContain("prohibited action");
    expect(trial.status).toBe("failed");
    expect(trial.costUsd).toBe(0.02);
  });

  it("does not credit a write whose fixture execution throws", async () => {
    const script = scripted([
      [call("describe_actions", { actions: [`${ln}save_issue`] })],
      [
        call("use_action", {
          action: `${ln}save_issue`,
          params: {
            team: "Product",
            title: "Sidebar collapse resets after refresh",
            description: "Collapse the sidebar and refresh. It should stay collapsed.",
          },
        }),
      ],
      [text("Created DEMO-3.")],
    ]);
    const trial = await run(
      {
        ...get("linear-file-issue"),
        fixture: () => {
          throw new Error("Fixture failed");
        },
      },
      script.generate,
    );
    expect(trial.executions[0]?.success).toBe(false);
    expect(trial.failures).toContain("unsuccessful action");
    expect(trial.status).toBe("failed");
  });

  it("stops before the next model call and retains the cost of an interrupted trial", async () => {
    const script = scripted([
      [call("describe_actions", { actions: [`${ln}get_issue`] })],
      [text("Should never run")],
    ]);
    const trial = await run(get("small-integration"), script.generate, new CostBudget(0.005));
    expect(script.doGenerate.mock.calls).toHaveLength(1);
    expect(trial).toMatchObject({
      status: "interrupted",
      steps: 1,
      knownCostUsd: 0.01,
      inputTokens: 100,
      outputTokens: 20,
    });
    expect(trial.failures).toContain("run cost budget");
  });

  it("fails closed on missing cost and retains known costs on a later provider failure", async () => {
    const missing = scripted([[call("describe_actions", { actions: [`${ln}get_issue`] })]], null);
    const trial = await run(get("small-integration"), missing.generate);
    expect(trial.costUsd).toBeNull();
    expect(trial.status).toBe("interrupted");
    const script = scripted([[call("describe_actions", { actions: [`${ln}get_issue`] })]]);
    const failed = await run(get("small-integration"), script.generate);
    expect(failed.status).toBe("failed");
    expect(failed.knownCostUsd).toBe(0.01);
    expect(failed.error).toBe("Error");
    expect(JSON.stringify(failed)).not.toContain("synthetic-key");
    expect(JSON.stringify(failed)).not.toContain("Unexpected extra model call");
  });

  it("grades all quantitative budgets independently", async () => {
    const trial = await run(
      get("unavailable"),
      scripted([[text("Unavailable; no changes.")]]).generate,
    );
    for (const key of [
      "steps",
      "toolCalls",
      "inputTokens",
      "outputTokens",
      "costUsd",
      "durationMs",
    ] as const) {
      const over: Trial = { ...trial, [key]: get("unavailable").budgets[key] + 1 };
      expect(gradeTrial(get("unavailable"), over)).toContain(`${key} budget`);
    }
  });
});

describe("cost metadata", () => {
  it.each([
    undefined,
    { gateway: { cost: null } },
    { gateway: { cost: "" } },
    { gateway: { cost: "NaN" } },
    { gateway: { cost: -1 } },
  ])("does not treat missing or invalid costs as zero", (metadata) =>
    expect(readCost(metadata)).toBeNull(),
  );
  it("accepts zero and numeric strings", () => {
    expect(readCost({ gateway: { cost: 0 } })).toBe(0);
    expect(readCost({ gateway: { cost: "0.001" } })).toBe(0.001);
  });
});

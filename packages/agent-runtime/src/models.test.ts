import { describe, expect, it } from "vitest";
import {
  AGENT_MODEL_CATALOG,
  AVAILABLE_AGENT_MODEL_CATALOG,
  CLAUDE_CODE_AGENT_MODEL_IDS,
  CODEX_AGENT_MODEL_IDS,
  CODEX_DEFAULT_MODEL_ID,
  claudeCodeCliModelNameForModelId,
  claudeCodeModelSupportsReasoningEffort,
  codexCliModelNameForModelId,
  getAgentModelRuntimeOptions,
  isCodexModelId,
  resolveAvailableAgentModelId,
} from "./models";

describe("Codex model catalog", () => {
  it("offers Astra and the GPT 5.6 family for new Codex work", () => {
    expect(CODEX_AGENT_MODEL_IDS).toEqual([
      "openai/gpt-6-astra",
      "openai/gpt-5.6-sol",
      "openai/gpt-5.6-terra",
      "openai/gpt-5.6-luna",
    ]);
    expect(isCodexModelId("openai/gpt-6-astra")).toBe(true);
    expect(isCodexModelId("openai/gpt-5.5")).toBe(false);
    expect(isCodexModelId("openai/gpt-5.4")).toBe(false);
    expect(isCodexModelId("openai/gpt-5.4-mini")).toBe(false);
  });

  it("defaults Codex sandboxes to GPT 6 Astra", () => {
    expect(CODEX_DEFAULT_MODEL_ID).toBe("openai/gpt-6-astra");
    expect(codexCliModelNameForModelId(CODEX_DEFAULT_MODEL_ID)).toBe("gpt-6-astra");
  });

  it.each([
    ["openai/gpt-6-astra", "gpt-6-astra"],
    ["openai/gpt-5.6-sol", "gpt-5.6-sol"],
    ["openai/gpt-5.6-terra", "gpt-5.6-terra"],
    ["openai/gpt-5.6-luna", "gpt-5.6-luna"],
  ])("maps %s to its Codex CLI model name", (modelId, cliModel) => {
    expect(isCodexModelId(modelId)).toBe(true);
    expect(codexCliModelNameForModelId(modelId)).toBe(cliModel);
  });

  it("keeps the opencompany rollout gate independent of Codex availability", () => {
    expect(resolveAvailableAgentModelId("openai/gpt-6-astra")).toBe("openai/gpt-5.6-sol");
    expect(codexCliModelNameForModelId("openai/gpt-6-astra")).toBe("gpt-6-astra");
    expect(AVAILABLE_AGENT_MODEL_CATALOG.map((model) => model.id)).not.toContain(
      "openai/gpt-6-astra",
    );
    expect(AGENT_MODEL_CATALOG.map((model) => model.id)).toContain("openai/gpt-6-astra");
  });

  it("keeps retired Codex selections runnable for persisted work", () => {
    expect(codexCliModelNameForModelId("openai/gpt-5.5")).toBe("gpt-5.5");
    expect(codexCliModelNameForModelId("openai/gpt-5.4")).toBe("gpt-5.4");
    expect(codexCliModelNameForModelId("openai/gpt-5.4-mini")).toBe("gpt-5.4-mini");
    expect(codexCliModelNameForModelId("openai/gpt-5.2-codex")).toBe("gpt-5.2-codex");
  });

  it("has display metadata for every supported Codex model", () => {
    const catalogIds = new Set(AGENT_MODEL_CATALOG.map((model) => model.id));
    expect(CODEX_AGENT_MODEL_IDS.every((modelId) => catalogIds.has(modelId))).toBe(true);
  });
});

describe("Claude Code model catalog", () => {
  it("maps Fable 5 to the Claude CLI and exposes adaptive reasoning", () => {
    expect(CLAUDE_CODE_AGENT_MODEL_IDS).toContain("anthropic/claude-fable-5");
    expect(claudeCodeCliModelNameForModelId("anthropic/claude-fable-5")).toBe("claude-fable-5");
    expect(claudeCodeModelSupportsReasoningEffort("claude-fable-5")).toBe(true);
  });

  it("exposes effort only for adaptive-reasoning models", () => {
    expect(claudeCodeModelSupportsReasoningEffort("anthropic/claude-sonnet-5")).toBe(true);
    expect(claudeCodeModelSupportsReasoningEffort("claude-opus-4-8")).toBe(true);
    expect(claudeCodeModelSupportsReasoningEffort("anthropic/claude-haiku-4.5")).toBe(false);
  });
});

describe("DeepSeek model catalog", () => {
  it("exposes V4 Pro reasoning while retaining automatic Gateway caching", () => {
    expect(getAgentModelRuntimeOptions("deepseek/deepseek-v4-pro")).toEqual({
      supportsReasoning: true,
      providerOptions: {
        gateway: {
          caching: "auto",
        },
      },
      reasoningExposure: "raw",
    });
  });
});

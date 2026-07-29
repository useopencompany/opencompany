import { describe, expect, it } from "vitest";
import {
  AGENT_MODEL_CATALOG,
  CODEX_AGENT_MODEL_IDS,
  CODEX_DEFAULT_MODEL_ID,
  claudeCodeModelSupportsReasoningEffort,
  codexCliModelNameForModelId,
  getAgentModelRuntimeOptions,
  isCodexModelId,
} from "./models";

describe("Codex model catalog", () => {
  it("defaults Codex sandboxes to GPT 5.6 Sol", () => {
    expect(CODEX_DEFAULT_MODEL_ID).toBe("openai/gpt-5.6-sol");
    expect(codexCliModelNameForModelId(CODEX_DEFAULT_MODEL_ID)).toBe("gpt-5.6-sol");
  });

  it.each([
    ["openai/gpt-5.6-sol", "gpt-5.6-sol"],
    ["openai/gpt-5.6-terra", "gpt-5.6-terra"],
    ["openai/gpt-5.6-luna", "gpt-5.6-luna"],
  ])("maps %s to its Codex CLI model name", (modelId, cliModel) => {
    expect(isCodexModelId(modelId)).toBe(true);
    expect(codexCliModelNameForModelId(modelId)).toBe(cliModel);
  });

  it("has display metadata for every supported Codex model", () => {
    const catalogIds = new Set(AGENT_MODEL_CATALOG.map((model) => model.id));
    expect(CODEX_AGENT_MODEL_IDS.every((modelId) => catalogIds.has(modelId))).toBe(true);
  });
});

describe("Claude Code model catalog", () => {
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

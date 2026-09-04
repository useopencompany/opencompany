import {
  CLAUDE_CODE_AGENT_MODEL_IDS,
  CLAUDE_CODE_DEFAULT_MODEL_ID,
  CODEX_AGENT_MODEL_IDS,
  CODEX_DEFAULT_MODEL_ID,
} from "@opencompany/agent-runtime";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL,
  MODELS,
  modelContextWindowTokens,
  normalizeConversationModel,
  normalizeModel,
} from "@/lib/model-options";

describe("opencompany model options", () => {
  it("defaults new chats to Kimi K3", () => {
    expect(DEFAULT_MODEL).toBe("moonshotai/kimi-k3");
    expect(normalizeModel(undefined)).toBe("moonshotai/kimi-k3");
  });

  it("preserves every supported cloud coding model when reloading a conversation", () => {
    for (const model of CODEX_AGENT_MODEL_IDS) {
      expect(normalizeConversationModel("codex", model)).toBe(model);
    }
    for (const model of CLAUDE_CODE_AGENT_MODEL_IDS) {
      expect(normalizeConversationModel("claude_code", model)).toBe(model);
    }
  });

  it("falls back within the conversation's engine model catalog", () => {
    expect(normalizeConversationModel("codex", "openai/gpt-6-astra")).toBe(CODEX_DEFAULT_MODEL_ID);
    expect(normalizeConversationModel("codex", "anthropic/claude-fable-5")).toBe(
      CODEX_DEFAULT_MODEL_ID,
    );
    expect(normalizeConversationModel("claude_code", "moonshotai/kimi-k3")).toBe(
      CLAUDE_CODE_DEFAULT_MODEL_ID,
    );
    expect(normalizeConversationModel("opencompany", "unknown/model")).toBe(DEFAULT_MODEL);
  });

  it("offers DeepSeek V4 Pro in main chat with its full context window", () => {
    expect(MODELS).toContainEqual(
      expect.objectContaining({
        id: "deepseek/deepseek-v4-pro",
        label: "DeepSeek V4 Pro",
      }),
    );
    expect(normalizeModel("deepseek/deepseek-v4-pro")).toBe("deepseek/deepseek-v4-pro");
    expect(modelContextWindowTokens("deepseek/deepseek-v4-pro")).toBe(1_000_000);
  });

  it("offers Qwen 3.8 Max in main chat with its full context window", () => {
    expect(MODELS).toContainEqual(
      expect.objectContaining({
        id: "alibaba/qwen3.8-max",
        label: "Qwen 3.8 Max",
        supportsImages: true,
        supportsReasoning: true,
      }),
    );
    expect(normalizeModel("alibaba/qwen3.8-max")).toBe("alibaba/qwen3.8-max");
    expect(modelContextWindowTokens("alibaba/qwen3.8-max")).toBe(1_000_000);
  });

  it("offers Grok 4.6 in main chat with vision and its full context window", () => {
    expect(MODELS).toContainEqual(
      expect.objectContaining({
        id: "xai/grok-4.6",
        label: "Grok 4.6",
        supportsImages: true,
        supportsReasoning: true,
      }),
    );
    expect(normalizeModel("xai/grok-4.6")).toBe("xai/grok-4.6");
    expect(modelContextWindowTokens("xai/grok-4.6")).toBe(500_000);
  });

  it("offers the verified GPT 5.6 models and remaps persisted Astra selections", () => {
    expect(MODELS).not.toContainEqual(expect.objectContaining({ id: "openai/gpt-6-astra" }));
    expect(MODELS).toContainEqual(
      expect.objectContaining({
        id: "openai/gpt-5.6-sol",
        label: "GPT 5.6 Sol",
        supportsImages: true,
        supportsReasoning: true,
      }),
    );
    expect(MODELS).toContainEqual(
      expect.objectContaining({
        id: "openai/gpt-5.6-terra",
        label: "GPT 5.6 Terra",
        supportsImages: true,
        supportsReasoning: true,
      }),
    );
    expect(normalizeModel("openai/gpt-6-astra")).toBe(CODEX_DEFAULT_MODEL_ID);
    expect(normalizeModel("openai/gpt-5.6-sol")).toBe("openai/gpt-5.6-sol");
    expect(normalizeModel("openai/gpt-5.6-terra")).toBe("openai/gpt-5.6-terra");
    expect(modelContextWindowTokens("openai/gpt-6-astra")).toBe(1_050_000);
    expect(modelContextWindowTokens("openai/gpt-5.6-sol")).toBe(1_050_000);
    expect(modelContextWindowTokens("openai/gpt-5.6-terra")).toBe(1_050_000);
  });

  it("preserves the GLM model used by workflow tasks", () => {
    expect(MODELS).toContainEqual(
      expect.objectContaining({
        id: "zai/glm-5.2",
        label: "GLM 5.2",
      }),
    );
    expect(normalizeModel("zai/glm-5.2")).toBe("zai/glm-5.2");
  });
});

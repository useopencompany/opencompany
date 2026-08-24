import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL,
  MODELS,
  modelContextWindowTokens,
  normalizeModel,
} from "@/lib/model-options";

describe("opencompany model options", () => {
  it("defaults new chats to Kimi K3", () => {
    expect(DEFAULT_MODEL).toBe("moonshotai/kimi-k3");
    expect(normalizeModel(undefined)).toBe("moonshotai/kimi-k3");
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

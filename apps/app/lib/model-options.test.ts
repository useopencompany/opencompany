import { describe, expect, it } from "vitest";
import {
  DEFAULT_GOAT_MODEL,
  GOAT_MODELS,
  modelContextWindowTokens,
  normalizeModel,
} from "@/lib/model-options";

describe("Goat model options", () => {
  it("defaults new chats to Kimi K3", () => {
    expect(DEFAULT_GOAT_MODEL).toBe("moonshotai/kimi-k3");
    expect(normalizeModel(undefined)).toBe("moonshotai/kimi-k3");
  });

  it("offers DeepSeek V4 Pro in main chat with its full context window", () => {
    expect(GOAT_MODELS).toContainEqual(
      expect.objectContaining({
        id: "deepseek/deepseek-v4-pro",
        label: "DeepSeek V4 Pro",
      }),
    );
    expect(normalizeModel("deepseek/deepseek-v4-pro")).toBe("deepseek/deepseek-v4-pro");
    expect(modelContextWindowTokens("deepseek/deepseek-v4-pro")).toBe(1_000_000);
  });

  it("preserves the GLM model used by workflow tasks", () => {
    expect(GOAT_MODELS).toContainEqual(
      expect.objectContaining({
        id: "zai/glm-5.2",
        label: "GLM 5.2",
      }),
    );
    expect(normalizeModel("zai/glm-5.2")).toBe("zai/glm-5.2");
  });
});

import { describe, expect, it } from "vitest";
import { GOAT_MODELS, goatModelContextWindowTokens, normalizeGoatModel } from "@/lib/model-options";

describe("Goat model options", () => {
  it("offers DeepSeek V4 Pro in main chat with its full context window", () => {
    expect(GOAT_MODELS).toContainEqual(
      expect.objectContaining({
        id: "deepseek/deepseek-v4-pro",
        label: "DeepSeek V4 Pro",
      }),
    );
    expect(normalizeGoatModel("deepseek/deepseek-v4-pro")).toBe("deepseek/deepseek-v4-pro");
    expect(goatModelContextWindowTokens("deepseek/deepseek-v4-pro")).toBe(1_000_000);
  });
});

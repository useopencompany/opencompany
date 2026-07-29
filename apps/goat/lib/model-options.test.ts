import { describe, expect, it } from "vitest";
import {
  DEFAULT_GOAT_MODEL,
  GOAT_MODELS,
  goatModelContextWindowTokens,
  normalizeGoatModel,
} from "@/lib/model-options";

describe("Goat model options", () => {
  it("defaults new chats to Kimi K3", () => {
    expect(DEFAULT_GOAT_MODEL).toBe("moonshotai/kimi-k3");
    expect(normalizeGoatModel(undefined)).toBe("moonshotai/kimi-k3");
  });

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

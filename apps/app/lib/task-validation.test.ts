import { describe, expect, it } from "vitest";
import { DEFAULT_GOAT_MODEL } from "@/lib/model-options";
import { GOAT_TASK_PROMPT_MAX_LENGTH, validateTaskInput } from "@/lib/task-validation";

describe("validateTaskInput", () => {
  it("trims prompts and accepts supported models", () => {
    expect(validateTaskInput({ prompt: "  research this  ", model: "openai/gpt-5.5" })).toEqual({
      ok: true,
      value: { prompt: "research this", model: "openai/gpt-5.5" },
    });
  });

  it("falls back to the default model for unsupported model ids", () => {
    expect(validateTaskInput({ prompt: "run", model: "bogus" })).toEqual({
      ok: true,
      value: { prompt: "run", model: DEFAULT_GOAT_MODEL },
    });
  });

  it("rejects empty and oversized prompts", () => {
    expect(validateTaskInput({ prompt: " ", model: DEFAULT_GOAT_MODEL })).toMatchObject({
      ok: false,
    });
    expect(
      validateTaskInput({
        prompt: "x".repeat(GOAT_TASK_PROMPT_MAX_LENGTH + 1),
        model: DEFAULT_GOAT_MODEL,
      }),
    ).toMatchObject({ ok: false });
  });
});

import { describe, expect, it } from "vitest";
import { DEFAULT_GOAT_MODEL } from "@/lib/model-options";
import { GOAT_TASK_PROMPT_MAX_LENGTH, validateGoatTaskInput } from "@/lib/task-validation";

describe("validateGoatTaskInput", () => {
  it("trims prompts and accepts supported models", () => {
    expect(validateGoatTaskInput({ prompt: "  research this  ", model: "openai/gpt-5.5" })).toEqual(
      {
        ok: true,
        value: { prompt: "research this", model: "openai/gpt-5.5" },
      },
    );
  });

  it("falls back to the default model for unsupported model ids", () => {
    expect(validateGoatTaskInput({ prompt: "run", model: "bogus" })).toEqual({
      ok: true,
      value: { prompt: "run", model: DEFAULT_GOAT_MODEL },
    });
  });

  it("rejects empty and oversized prompts", () => {
    expect(validateGoatTaskInput({ prompt: " ", model: DEFAULT_GOAT_MODEL })).toMatchObject({
      ok: false,
    });
    expect(
      validateGoatTaskInput({
        prompt: "x".repeat(GOAT_TASK_PROMPT_MAX_LENGTH + 1),
        model: DEFAULT_GOAT_MODEL,
      }),
    ).toMatchObject({ ok: false });
  });
});

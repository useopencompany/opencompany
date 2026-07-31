import { describe, expect, it } from "vitest";
import { goatWorkflowStepSettings } from "@/lib/workflow-model-options";

describe("goatWorkflowStepSettings", () => {
  it("drops cloud coding settings when the workflow step runtime is not cloud coding", () => {
    expect(
      goatWorkflowStepSettings({
        model: "kimi-k2.6",
        runtimeModel: "openai/gpt-5.6-luna",
        reasoningEffort: "xhigh",
      }),
    ).toEqual({ model: "kimi-k2.6" });
  });

  it("normalizes cloud coding steps to a concrete model and effort", () => {
    expect(
      goatWorkflowStepSettings({
        model: "codex",
        runtimeModel: "openai/gpt-5.6-luna",
        reasoningEffort: "medium",
      }),
    ).toEqual({
      model: "codex",
      runtimeModel: "openai/gpt-5.6-luna",
      reasoningEffort: "medium",
    });
  });
});

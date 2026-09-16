import { isAgentModelSelectable } from "@opencompany/agent-runtime";
import { describe, expect, it } from "vitest";
import { MODELS } from "@/lib/model-options";
import {
  DEFAULT_WORKFLOW_MODEL_TOKEN,
  isWorkflowSubscriptionCoveredModel,
  resolveWorkflowStepModelSelection,
  WORKFLOW_MODEL_OPTIONS,
  workflowStepSettings,
} from "@/lib/workflow-model-options";

describe("workflow model catalog", () => {
  it("uses the selectable main-chat models and default", () => {
    const workflowModelIds = WORKFLOW_MODEL_OPTIONS.filter(
      (option) => option.engine === "opencompany",
    ).map((option) => option.id);
    const chatModelIds = MODELS.filter((model) => isAgentModelSelectable(model.id)).map(
      (model) => model.id,
    );

    expect(workflowModelIds).toEqual(chatModelIds);
    expect(DEFAULT_WORKFLOW_MODEL_TOKEN).toBe("kimi-k2.6");
    expect(resolveWorkflowStepModelSelection({ model: "", instructions: "" }).model).toBe(
      "moonshotai/kimi-k2.6",
    );
  });
});

describe("workflowStepSettings", () => {
  it("drops cloud coding settings when the workflow step runtime is not cloud coding", () => {
    expect(
      workflowStepSettings({
        model: "kimi-k2.6",
        runtimeModel: "openai/gpt-5.6-luna",
        reasoningEffort: "xhigh",
      }),
    ).toEqual({ model: "kimi-k2.6" });
  });

  it("normalizes cloud coding steps to a concrete model and effort", () => {
    expect(
      workflowStepSettings({
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

describe("workflow GPT model tokens", () => {
  it("resolves the newest GPT tokens to their catalog model on the opencompany engine", () => {
    expect(resolveWorkflowStepModelSelection({ model: "gpt-5.6-sol", instructions: "" })).toEqual({
      engine: "opencompany",
      model: "openai/gpt-5.6-sol",
    });
    expect(resolveWorkflowStepModelSelection({ model: "gpt-5.6-terra", instructions: "" })).toEqual(
      {
        engine: "opencompany",
        model: "openai/gpt-5.6-terra",
      },
    );
  });

  it("keeps resolving steps already saved on the superseded GPT 5.5 token", () => {
    expect(resolveWorkflowStepModelSelection({ model: "gpt-5.5", instructions: "" })).toEqual({
      engine: "opencompany",
      model: "openai/gpt-5.5",
    });
  });

  it("matches the newest GPT tokens as inline @mentions", () => {
    expect(
      resolveWorkflowStepModelSelection({
        model: "",
        instructions: "Summarize the week with @gpt-5.6-terra.",
      }),
    ).toEqual({ engine: "opencompany", model: "openai/gpt-5.6-terra" });
  });
});

describe("isWorkflowSubscriptionCoveredModel", () => {
  it("flags the GPT models a shared ChatGPT subscription covers", () => {
    expect(coveredTokens()).toEqual(["gpt-5.6-sol", "gpt-5.6-terra"]);
  });

  it("does not flag cloud coding runtimes, which bill to the member's own agent account", () => {
    const codex = requireOption("codex");
    expect(codex.id).toBe("openai/gpt-5.6-sol");
    expect(isWorkflowSubscriptionCoveredModel(codex)).toBe(false);
  });
});

function coveredTokens(): string[] {
  return WORKFLOW_MODEL_OPTIONS.filter(isWorkflowSubscriptionCoveredModel).map(
    (option) => option.token,
  );
}

function requireOption(token: string) {
  const option = WORKFLOW_MODEL_OPTIONS.find((candidate) => candidate.token === token);
  if (!option) throw new Error(`Workflow model token "${token}" is missing.`);
  return option;
}

import type { HarnessSpec } from "@opencompany/agent/task-runtime-types";
import { describe, expect, it } from "vitest";
import { deriveTaskWorkflowSteps } from "@/lib/task-workflow-activity";

describe("deriveTaskWorkflowSteps", () => {
  it("omits non-workflow and single-step tasks", () => {
    expect(deriveTaskWorkflowSteps({ harnessSpec: {}, taskStatus: "running" })).toEqual([]);
    expect(
      deriveTaskWorkflowSteps({
        harnessSpec: workflowSpec({ stepCount: 1 }),
        taskStatus: "running",
      }),
    ).toEqual([]);
  });

  it("marks completed, running, and pending workflow subtasks from the checkpoint", () => {
    expect(
      deriveTaskWorkflowSteps({
        harnessSpec: workflowSpec({ stepCount: 3, currentStepIndex: 1, completedStepCount: 1 }),
        taskStatus: "running",
      }),
    ).toEqual([
      expect.objectContaining({ index: 0, title: "Step A", status: "completed" }),
      expect.objectContaining({ index: 1, title: "Step B", status: "running" }),
      expect.objectContaining({ index: 2, title: "Step C", status: "pending" }),
    ]);
  });

  it("keeps a needs-attention stop on the completed step", () => {
    expect(
      deriveTaskWorkflowSteps({
        harnessSpec: workflowSpec({
          stepCount: 3,
          currentStepIndex: 0,
          completedStepCount: 1,
          reportedOutcome: "needs_attention",
        }),
        taskStatus: "succeeded",
      }),
    ).toEqual([
      expect.objectContaining({ index: 0, status: "needs_attention" }),
      expect.objectContaining({ index: 1, status: "pending" }),
      expect.objectContaining({ index: 2, status: "pending" }),
    ]);
  });
});

function workflowSpec(input: {
  stepCount: number;
  currentStepIndex?: number;
  completedStepCount?: number;
  reportedOutcome?: "done" | "needs_attention";
}): HarnessSpec {
  const titles = ["Step A", "Step B", "Step C"];
  return {
    schemaVersion: "goat.harness.v1",
    engine: "opencompany",
    model: "openai/gpt-5.4-mini",
    systemPrompt: "Run the task.",
    initialUserMessage: "Run the workflow.",
    tools: [],
    skills: [],
    maxModelSteps: 8,
    resultMode: "assistant_final",
    workflow: {
      id: "workflow",
      workspaceId: "workspace_1",
      skillIds: [],
      skillBundleIds: [],
      pluginIds: [],
      steps: Array.from({ length: input.stepCount }, (_, index) => ({
        index,
        title: titles[index] ?? `Step ${index + 1}`,
        engine: "opencompany",
        model: "openai/gpt-5.4-mini",
        systemPrompt: `System ${index + 1}`,
        systemBlocks: [`System ${index + 1}`],
        skillIds: [],
        skillBundleIds: [],
      })),
      currentStepIndex: input.currentStepIndex ?? 0,
      completedStepCount: input.completedStepCount ?? 0,
      ...(input.reportedOutcome
        ? {
            lastCompletedStepOutcome: {
              reportedOutcome: input.reportedOutcome,
              outcomeComment: null,
            },
          }
        : {}),
    },
  };
}

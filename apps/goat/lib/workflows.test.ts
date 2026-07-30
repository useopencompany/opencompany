import { describe, expect, it } from "vitest";
import { goatWorkflowStepsWithLegacyFallback, validateGoatWorkflowFields } from "@/lib/workflows";

const validStep = {
  id: "step-1",
  title: "Research",
  model: "kimi-k2.6",
  instructions: "Collect the source material.",
};

describe("validateGoatWorkflowFields", () => {
  it("requires between one and twenty steps", () => {
    expect(
      validateGoatWorkflowFields({
        name: "Workflow",
        description: "",
        steps: [],
      }),
    ).toMatch(/at least one/i);
    expect(
      validateGoatWorkflowFields({
        name: "Workflow",
        description: "",
        steps: Array.from({ length: 21 }, (_, index) => ({
          ...validStep,
          id: `step-${index}`,
        })),
      }),
    ).toMatch(/at most 20/i);
  });

  it("validates step titles, instructions, models, and IDs", () => {
    expect(
      validateGoatWorkflowFields({
        name: "Workflow",
        description: "",
        steps: [{ ...validStep, title: "x".repeat(121) }],
      }),
    ).toMatch(/titles/);
    expect(
      validateGoatWorkflowFields({
        name: "Workflow",
        description: "",
        steps: [{ ...validStep, instructions: "x".repeat(20_001) }],
      }),
    ).toMatch(/20,000/);
    expect(
      validateGoatWorkflowFields({
        name: "Workflow",
        description: "",
        steps: [{ ...validStep, model: "future-model" }],
      }),
    ).toMatch(/model/);
    expect(
      validateGoatWorkflowFields({
        name: "Workflow",
        description: "",
        steps: [validStep, { ...validStep }],
      }),
    ).toMatch(/unique/);
  });

  it("requires every step to have instructions before activation", () => {
    expect(
      validateGoatWorkflowFields({
        name: "Workflow",
        description: "",
        steps: [{ ...validStep, instructions: " " }],
        status: "active",
      }),
    ).toMatch(/instructions/);
    expect(
      validateGoatWorkflowFields({
        name: "Workflow",
        description: "",
        steps: [
          { ...validStep, instructions: " " },
          { ...validStep, id: "step-2" },
        ],
        status: "active",
      }),
    ).toMatch(/every workflow step/i);
    expect(
      validateGoatWorkflowFields({
        name: "Workflow",
        description: "",
        steps: [validStep, { ...validStep, id: "step-2" }],
        status: "active",
      }),
    ).toBeNull();
  });
});

describe("goatWorkflowStepsWithLegacyFallback", () => {
  it("synthesizes one step for a legacy instructions row", () => {
    expect(
      goatWorkflowStepsWithLegacyFallback({
        slug: "weekly-update",
        steps: [],
        model: "sonnet-5",
        instructions: "Write the weekly update.",
      }),
    ).toEqual([
      {
        id: "step-weekly-update",
        title: "",
        model: "sonnet-5",
        instructions: "Write the weekly update.",
      },
    ]);
  });

  it("does not invent a step for an empty legacy draft", () => {
    expect(
      goatWorkflowStepsWithLegacyFallback({
        slug: "empty",
        steps: [],
        model: "",
        instructions: "",
      }),
    ).toEqual([]);
  });

  it("prefers native steps when legacy columns disagree", () => {
    expect(
      goatWorkflowStepsWithLegacyFallback({
        slug: "weekly-update",
        steps: [validStep],
        model: "sonnet-5",
        instructions: "Edited by an older web pod.",
      }),
    ).toEqual([validStep]);
  });

  it("preserves a model-only legacy draft", () => {
    expect(
      goatWorkflowStepsWithLegacyFallback({
        slug: "weekly-update",
        steps: [],
        model: "sonnet-5",
        instructions: "",
      }),
    ).toEqual([
      {
        id: "step-weekly-update",
        title: "",
        model: "sonnet-5",
        instructions: "",
      },
    ]);
  });

  it("keeps native steps when legacy columns contain their old mirror", () => {
    expect(
      goatWorkflowStepsWithLegacyFallback({
        slug: "weekly-update",
        steps: [validStep],
        model: validStep.model,
        instructions: "## 1. Research\n\nCollect the source material.",
      }),
    ).toEqual([validStep]);
  });
});

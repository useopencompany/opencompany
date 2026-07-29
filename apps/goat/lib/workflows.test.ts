import { describe, expect, it } from "vitest";
import {
  goatWorkflowStepsWithLegacyFallback,
  renderStepsAsMarkdown,
  validateGoatWorkflowFields,
} from "@/lib/workflows";

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
        trigger: "manual",
        steps: [],
      }),
    ).toMatch(/at least one/i);
    expect(
      validateGoatWorkflowFields({
        name: "Workflow",
        description: "",
        trigger: "manual",
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
        trigger: "manual",
        steps: [{ ...validStep, title: "x".repeat(121) }],
      }),
    ).toMatch(/titles/);
    expect(
      validateGoatWorkflowFields({
        name: "Workflow",
        description: "",
        trigger: "manual",
        steps: [{ ...validStep, instructions: "x".repeat(20_001) }],
      }),
    ).toMatch(/20,000/);
    expect(
      validateGoatWorkflowFields({
        name: "Workflow",
        description: "",
        trigger: "manual",
        steps: [{ ...validStep, model: "future-model" }],
      }),
    ).toMatch(/model/);
    expect(
      validateGoatWorkflowFields({
        name: "Workflow",
        description: "",
        trigger: "manual",
        steps: [validStep, { ...validStep }],
      }),
    ).toMatch(/unique/);
  });

  it("requires at least one non-empty step before activation", () => {
    expect(
      validateGoatWorkflowFields({
        name: "Workflow",
        description: "",
        trigger: "manual",
        steps: [{ ...validStep, instructions: " " }],
        status: "active",
      }),
    ).toMatch(/instructions/);
    expect(
      validateGoatWorkflowFields({
        name: "Workflow",
        description: "",
        trigger: "manual",
        steps: [
          { ...validStep, instructions: " " },
          { ...validStep, id: "step-2" },
        ],
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
});

describe("renderStepsAsMarkdown", () => {
  it("renders readable numbered sections for legacy runners", () => {
    expect(
      renderStepsAsMarkdown([
        validStep,
        { ...validStep, id: "step-2", title: "", instructions: "Draft the result." },
      ]),
    ).toBe(
      [
        "## 1. Research",
        "",
        "Collect the source material.",
        "",
        "## 2. Step 2",
        "",
        "Draft the result.",
      ].join("\n"),
    );
  });
});

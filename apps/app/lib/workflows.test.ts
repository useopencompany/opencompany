import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWorkflow,
  validateWorkflowFields,
  workflowStepsWithLegacyFallback,
} from "@/lib/workflows";

const dbMocks = vi.hoisted(() => ({
  existingWorkflowRows: [] as Array<{ slug: string }>,
  insert: vi.fn(),
  insertValues: vi.fn(),
  select: vi.fn(),
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: () => ({
    insert: dbMocks.insert,
    select: dbMocks.select,
  }),
}));

const validStep = {
  id: "step-1",
  title: "Research",
  model: "kimi-k2.6",
  instructions: "Collect the source material.",
};

beforeEach(() => {
  dbMocks.existingWorkflowRows = [];
  dbMocks.insert.mockReset();
  dbMocks.insertValues.mockReset();
  dbMocks.select.mockReset();
  dbMocks.insert.mockReturnValue({ values: dbMocks.insertValues });
  dbMocks.insertValues.mockResolvedValue(undefined);
  dbMocks.select.mockImplementation(() => createSelectBuilder(dbMocks.existingWorkflowRows));
});

describe("createWorkflow", () => {
  it("creates new workflows as active by default", async () => {
    await expect(
      createWorkflow({
        workspaceId: "workspace_1",
        createdByWorkosId: "user_1",
        name: "Weekly update",
        description: "Summarize the week.",
      }),
    ).resolves.toEqual({ ok: true, slug: "weekly-update" });

    expect(dbMocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace_1",
        slug: "weekly-update",
        name: "Weekly update",
        description: "Summarize the week.",
        instructions: "",
        model: "",
        trigger: "manual",
        scheduleEnabled: false,
        status: "active",
        createdByWorkosId: "user_1",
      }),
    );
    expect(dbMocks.insertValues.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        steps: [
          expect.objectContaining({
            title: "",
            model: "",
            instructions: "",
          }),
        ],
      }),
    );
  });
});

describe("validateWorkflowFields", () => {
  it("requires between one and twenty steps", () => {
    expect(
      validateWorkflowFields({
        name: "Workflow",
        description: "",
        steps: [],
      }),
    ).toMatch(/at least one/i);
    expect(
      validateWorkflowFields({
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
      validateWorkflowFields({
        name: "Workflow",
        description: "",
        steps: [{ ...validStep, title: "x".repeat(121) }],
      }),
    ).toMatch(/titles/);
    expect(
      validateWorkflowFields({
        name: "Workflow",
        description: "",
        steps: [{ ...validStep, instructions: "x".repeat(20_001) }],
      }),
    ).toMatch(/20,000/);
    expect(
      validateWorkflowFields({
        name: "Workflow",
        description: "",
        steps: [{ ...validStep, model: "future-model" }],
      }),
    ).toMatch(/model/);
    expect(
      validateWorkflowFields({
        name: "Workflow",
        description: "",
        steps: [{ ...validStep, model: "codex", runtimeModel: "anthropic/claude-sonnet-5" }],
      }),
    ).toMatch(/coding model/);
    expect(
      validateWorkflowFields({
        name: "Workflow",
        description: "",
        steps: [
          {
            ...validStep,
            model: "codex",
            runtimeModel: "openai/gpt-5.6-luna",
            reasoningEffort: "extreme" as never,
          },
        ],
      }),
    ).toMatch(/effort/);
    expect(
      validateWorkflowFields({
        name: "Workflow",
        description: "",
        steps: [validStep, { ...validStep }],
      }),
    ).toMatch(/unique/);
  });

  it("allows active workflows to be edited before every step has instructions", () => {
    expect(
      validateWorkflowFields({
        name: "Workflow",
        description: "",
        steps: [{ ...validStep, instructions: " " }],
        status: "active",
      }),
    ).toBeNull();
    expect(
      validateWorkflowFields({
        name: "Workflow",
        description: "",
        steps: [
          { ...validStep, instructions: " " },
          { ...validStep, id: "step-2" },
        ],
        status: "active",
      }),
    ).toBeNull();
    expect(
      validateWorkflowFields({
        name: "Workflow",
        description: "",
        steps: [validStep, { ...validStep, id: "step-2" }],
        status: "active",
      }),
    ).toBeNull();
  });

  it("validates schedule triggers", () => {
    expect(
      validateWorkflowFields({
        name: "Workflow",
        description: "",
        steps: [validStep],
        trigger: {
          type: "schedule",
          cron: "30 8 * * 1-5",
          timezone: "America/New_York",
          prompt: "Run the weekday workflow.",
        },
      }),
    ).toBeNull();
    expect(
      validateWorkflowFields({
        name: "Workflow",
        description: "",
        steps: [validStep],
        trigger: {
          type: "schedule",
          cron: "0 0 9 * * *",
          timezone: "UTC",
          prompt: "Run it.",
        },
      }),
    ).toMatch(/cron/i);
  });
});

describe("workflowStepsWithLegacyFallback", () => {
  it("synthesizes one step for a legacy instructions row", () => {
    expect(
      workflowStepsWithLegacyFallback({
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
      workflowStepsWithLegacyFallback({
        slug: "empty",
        steps: [],
        model: "",
        instructions: "",
      }),
    ).toEqual([]);
  });

  it("prefers native steps when legacy columns disagree", () => {
    expect(
      workflowStepsWithLegacyFallback({
        slug: "weekly-update",
        steps: [validStep],
        model: "sonnet-5",
        instructions: "Edited by an older web pod.",
      }),
    ).toEqual([validStep]);
  });

  it("preserves a model-only legacy draft", () => {
    expect(
      workflowStepsWithLegacyFallback({
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
      workflowStepsWithLegacyFallback({
        slug: "weekly-update",
        steps: [validStep],
        model: validStep.model,
        instructions: "## 1. Research\n\nCollect the source material.",
      }),
    ).toEqual([validStep]);
  });
});

function createSelectBuilder(rows: Array<{ slug: string }>) {
  const builder = {
    from: vi.fn(() => builder),
    where: vi.fn(() => builder),
    then: <TResult1 = Array<{ slug: string }>, TResult2 = never>(
      onfulfilled?: ((value: Array<{ slug: string }>) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) => Promise.resolve(rows).then(onfulfilled, onrejected),
  };
  return builder;
}

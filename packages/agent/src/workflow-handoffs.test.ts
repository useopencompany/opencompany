import { describe, expect, it } from "vitest";
import { TASK_SYSTEM_BLOCK, taskSystemBlock } from "./chat-agent";
import { MAX_WORKFLOW_HANDOFF_DEPTH, workflowHandoffGrant } from "./workflow-handoffs";
import { extractWorkflowMentionIds } from "./workflow-skill-mentions";
import { compileWorkflowHarnessSpec } from "./workflow-tasks";

describe("extractWorkflowMentionIds", () => {
  it("collects deduped workflow slugs and ignores skills, code, and URL labels", () => {
    expect(
      extractWorkflowMentionIds(
        [
          "When the PR is open, start @workflow/review-pr. Then @workflow/Review-PR again.",
          "Use @skill/research and @workflow/notify-team.",
          "`@workflow/in-code` stays literal.",
          "[@workflow/linked](@workflow/linked)",
        ].join("\n\n"),
      ),
    ).toEqual(["review-pr", "notify-team"]);
  });
});

describe("compileWorkflowHarnessSpec handoffs", () => {
  const workflow = {
    id: "build",
    name: "Build",
    description: "",
    steps: [
      {
        id: "step-1",
        title: "Implement",
        model: "",
        instructions: "Open a PR, then hand it to @workflow/review-pr. Never @workflow/build.",
      },
      { id: "step-2", title: "Report", model: "", instructions: "Summarize." },
    ],
  };

  it("pins each step's mentioned workflows and never the workflow itself", () => {
    const spec = compileWorkflowHarnessSpec({
      workflow,
      workspaceId: "ws_1",
      skills: [],
      tools: [],
      description: "Ship it.",
    });

    expect(spec.workflow.steps?.[0]?.handoffWorkflowIds).toEqual(["review-pr"]);
    expect(spec.workflow.steps?.[1]).not.toHaveProperty("handoffWorkflowIds");
    expect(spec.workflow).not.toHaveProperty("handoffDepth");
  });

  it("records how deep in a handoff chain the run starts", () => {
    const spec = compileWorkflowHarnessSpec({
      workflow,
      workspaceId: "ws_1",
      skills: [],
      tools: [],
      description: "Ship it.",
      handoffDepth: 2,
    });

    expect(spec.workflow.handoffDepth).toBe(2);
  });
});

describe("workflowHandoffGrant", () => {
  const steps = [
    { handoffWorkflowIds: ["review-pr", "build"] },
    { handoffWorkflowIds: ["notify-team"] },
  ] as never;

  it("grants the current step's mentions, excluding the run's own workflow", () => {
    expect(workflowHandoffGrant({ workflow: workflowSpec({ steps }) })).toEqual({
      workflowIds: ["review-pr"],
      depth: 0,
    });
    expect(
      workflowHandoffGrant({ workflow: workflowSpec({ steps, currentStepIndex: 1 }) }),
    ).toEqual({ workflowIds: ["notify-team"], depth: 0 });
  });

  it("grants nothing at the bottom of a handoff chain or without mentions", () => {
    expect(
      workflowHandoffGrant({
        workflow: workflowSpec({ steps, handoffDepth: MAX_WORKFLOW_HANDOFF_DEPTH }),
      }),
    ).toBeNull();
    expect(
      workflowHandoffGrant({
        workflow: workflowSpec({ steps, handoffDepth: MAX_WORKFLOW_HANDOFF_DEPTH - 1 }),
      }),
    ).toEqual({ workflowIds: ["review-pr"], depth: MAX_WORKFLOW_HANDOFF_DEPTH - 1 });
    expect(workflowHandoffGrant({ workflow: workflowSpec({ steps: [{}] as never }) })).toBeNull();
    expect(workflowHandoffGrant({})).toBeNull();
  });
});

describe("taskSystemBlock", () => {
  it("keeps the no-delegation block unless the step names workflows it may start", () => {
    expect(taskSystemBlock(undefined)).toBe(TASK_SYSTEM_BLOCK);
    expect(taskSystemBlock([])).toBe(TASK_SYSTEM_BLOCK);

    const block = taskSystemBlock(["review-pr"]);
    expect(block).not.toContain("start workflows");
    expect(block).toContain("@workflow/review-pr");
    expect(block).toContain("that is the only workflow you may start, with start_workflow");
  });
});

function workflowSpec(
  overrides: Partial<NonNullable<Parameters<typeof workflowHandoffGrant>[0]>["workflow"]>,
) {
  return {
    id: "build",
    workspaceId: "ws_1",
    skillIds: [],
    skillBundleIds: [],
    pluginIds: [],
    ...overrides,
  };
}

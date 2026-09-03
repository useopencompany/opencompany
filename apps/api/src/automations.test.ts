import { SkillMentionError } from "@opencompany/agent/skills";
import { WorkflowPreparationError } from "@opencompany/agent/workflow-tasks";
import { WorkflowMentionError } from "@opencompany/agent/workflows";
import { type Actor, CoreError } from "@opencompany/core";
import type { HarnessSpec } from "@opencompany/db/product-schema";
import { describe, expect, it, vi } from "vitest";
import {
  createAutomationTaskCreator,
  mapWorkflowPreparationError,
  shouldRefineWorkflowTaskTitle,
} from "./automations";

const actor: Actor = {
  userId: "user_1",
  workspaceId: "workspace_1",
  role: "member",
  permissions: ["task:write"],
  authenticationMethod: "session",
};

describe("mapWorkflowPreparationError", () => {
  it("maps skill and workflow mention problems to invalid_argument", () => {
    const skill = mapWorkflowPreparationError(new SkillMentionError("Skill is unavailable."));
    expect(skill).toBeInstanceOf(CoreError);
    expect(skill).toMatchObject({ code: "invalid_argument", message: "Skill is unavailable." });

    const mention = mapWorkflowPreparationError(
      new WorkflowMentionError("Pick one model for the step."),
    );
    expect(mention).toBeInstanceOf(CoreError);
    expect(mention).toMatchObject({
      code: "invalid_argument",
      message: "Pick one model for the step.",
    });
  });

  it("maps an integration-state lookup failure to a retryable unavailable error", () => {
    const mapped = mapWorkflowPreparationError(
      new WorkflowPreparationError("We couldn't load the integrations available to this workflow."),
    );
    expect(mapped).toBeInstanceOf(CoreError);
    expect(mapped).toMatchObject({
      code: "unavailable",
      message: "We couldn't load the integrations available to this workflow.",
    });
  });

  it("passes an existing CoreError through unchanged", () => {
    const original = new CoreError("not_found", "Workflow not found.");
    expect(mapWorkflowPreparationError(original)).toBe(original);
  });

  it("rethrows genuinely unexpected errors unchanged so they stay a visible 500", () => {
    const unexpected = new Error(
      "The prepared Task execution does not match its canonical command.",
    );
    expect(mapWorkflowPreparationError(unexpected)).toBe(unexpected);
  });
});

describe("createAutomationTaskCreator", () => {
  // Workflow harnesses frame the first turn as "Task: <name>\n\n<goal>". The
  // repository rejects a task whose harness message does not match its stored
  // user message, so the task creator must persist the framed message. This
  // guards against reintroducing the masked-500 regression on workflow invoke.
  const workflowHarness: HarnessSpec = {
    schemaVersion: "goat.harness.v1",
    engine: "opencompany",
    model: "openai/gpt-5.6-sol",
    systemPrompt: "You are executing step 1 of the workflow.",
    initialUserMessage: "Task: Morning briefing\n\nSummarize overnight activity.",
    tools: [],
    skills: [],
    maxModelSteps: 16,
    resultMode: "assistant_final",
  };

  function fakeExecute() {
    let calls = 0;
    return async () => {
      calls += 1;
      // First query is the idempotency preflight; return an authorized,
      // feature-enabled actor with no prior reservation so creation proceeds
      // to the canonical-command validation.
      if (calls === 1) {
        return { rows: [{ authorized: true, featureEnabled: true, commandId: null }] };
      }
      // The second query is the durable insert. Reaching it proves the harness
      // passed validation; throw a sentinel so the test does not depend on the
      // full insert result shape.
      throw new Error("__insert_reached__");
    };
  }

  it("persists the framed workflow message so the canonical-command check passes", async () => {
    const creator = createAutomationTaskCreator({
      execute: fakeExecute() as never,
      resolveAttachments: async () => ({ attachments: [], attachmentTexts: null }),
    });

    await expect(
      creator.create({
        actor,
        idempotencyKey: "workflow-invoke-1",
        name: "Morning briefing",
        goal: "Summarize overnight activity.",
        execution: {
          engine: "opencompany",
          model: "openai/gpt-5.6-sol",
          payload: workflowHarness,
        },
        source: "workflow",
        workflowId: "morning-briefing",
      }),
      // Rejecting with the insert sentinel — not the "does not match its
      // canonical command" invariant error — proves validation passed.
    ).rejects.toThrow("__insert_reached__");
  });

  it("refines a newly created workflow Task after canonical name normalization", () => {
    expect(
      shouldRefineWorkflowTaskTitle({
        source: "workflow",
        workflowName: "ship-feature",
        taskName: "Ship-feature",
        idempotentReplay: false,
      }),
    ).toBe(true);
  });

  it("repairs only idempotent replays that still have the canonical workflow fallback", () => {
    expect(
      shouldRefineWorkflowTaskTitle({
        source: "workflow",
        workflowName: "ship-feature",
        taskName: "Ship-feature",
        idempotentReplay: true,
      }),
    ).toBe(true);
    expect(
      shouldRefineWorkflowTaskTitle({
        source: "workflow",
        workflowName: "ship-feature",
        taskName: "Add one-click plugin installs",
        idempotentReplay: true,
      }),
    ).toBe(false);
    expect(
      shouldRefineWorkflowTaskTitle({
        source: "schedule",
        workflowName: "ship-feature",
        taskName: "Ship-feature",
        idempotentReplay: false,
      }),
    ).toBe(false);
  });
});

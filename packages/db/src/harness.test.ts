import { describe, expect, it } from "vitest";
import { getWorkflowHarnessSkillBundleIds } from "./harness";
import type { HarnessSpec } from "./product-schema";

describe("getWorkflowHarnessSkillBundleIds", () => {
  it("selects only immutable bundle IDs assigned to the current Workflow step", () => {
    const harness = workflowHarness();
    harness.workflow!.currentStepIndex = 1;

    expect(getWorkflowHarnessSkillBundleIds(harness)).toEqual(["skill_bundle_write_v1"]);
  });

  it("rejects a content-copying legacy Workflow Harness instead of falling back", () => {
    const harness = workflowHarness() as HarnessSpec & {
      workflow: Record<string, unknown>;
    };
    delete (harness.workflow.steps as Array<Record<string, unknown>>)[0]!.skillBundleIds;

    expect(() => getWorkflowHarnessSkillBundleIds(harness)).toThrow(
      "Workflow Task Harness is missing immutable Skill bundle IDs.",
    );
  });
});

function workflowHarness(): HarnessSpec {
  return {
    schemaVersion: "goat.harness.v1",
    engine: "opencompany",
    model: "openai/gpt-5.4-mini",
    systemPrompt: "Research.",
    initialUserMessage: "Prepare the report.",
    tools: [],
    skills: [],
    maxModelSteps: 16,
    resultMode: "assistant_final",
    workflow: {
      id: "report",
      workspaceId: "workspace_1",
      skillIds: ["research", "write"],
      skillBundleIds: ["skill_bundle_research_v1", "skill_bundle_write_v1"],
      currentStepIndex: 0,
      completedStepCount: 0,
      steps: [
        {
          index: 0,
          title: "Research",
          engine: "opencompany",
          model: "openai/gpt-5.4-mini",
          systemPrompt: "Research.",
          systemBlocks: ["Research."],
          skillIds: ["research"],
          skillBundleIds: ["skill_bundle_research_v1"],
        },
        {
          index: 1,
          title: "Write",
          engine: "opencompany",
          model: "openai/gpt-5.4-mini",
          systemPrompt: "Write.",
          systemBlocks: ["Write."],
          skillIds: ["write"],
          skillBundleIds: ["skill_bundle_write_v1"],
        },
      ],
    },
  };
}

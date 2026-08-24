import type { HarnessSpec } from "./product-schema";

export type WorkflowHarnessMetadata = NonNullable<HarnessSpec["workflow"]>;

export type WorkflowHarnessSpec = Omit<HarnessSpec, "workflow"> & {
  workflow: WorkflowHarnessMetadata;
};

export function getWorkflowHarnessSkillBundleIds(harnessSpec: HarnessSpec): string[] {
  const workflow = harnessSpec.workflow;
  if (!workflow) return [];
  const currentStep = workflow.steps?.[workflow.currentStepIndex ?? 0];
  if (!currentStep || !Array.isArray(currentStep.skillBundleIds)) {
    throw new Error("Workflow Task Harness is missing immutable Skill bundle IDs.");
  }
  if (currentStep.skillBundleIds.some((id) => typeof id !== "string" || id.length === 0)) {
    throw new Error("Workflow Task Harness contains an invalid Skill bundle ID.");
  }
  return currentStep.skillBundleIds;
}

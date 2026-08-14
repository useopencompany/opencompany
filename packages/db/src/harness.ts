import type { BrainSkill } from "@opencompany/brain";
import type { HarnessSpec } from "./product-schema";

export type WorkflowHarnessMetadata = NonNullable<HarnessSpec["workflow"]> & {
  // Immutable skill contents resolved when the workflow task was created.
  // Codex materializes these as native SKILL.md inputs; older persisted specs
  // only have skillIds, so this remains optional.
  skillSnapshots?: BrainSkill[];
};

export type WorkflowHarnessSpec = Omit<HarnessSpec, "workflow"> & {
  workflow: WorkflowHarnessMetadata;
};

export function getWorkflowHarnessSkillSnapshots(
  harnessSpec: HarnessSpec,
): BrainSkill[] | undefined {
  const workflow = harnessSpec.workflow as WorkflowHarnessMetadata | undefined;
  const snapshots = workflow?.skillSnapshots;
  const currentStep = workflow?.steps?.[workflow.currentStepIndex ?? 0];
  if (!snapshots || !currentStep) return snapshots;
  const skillIds = new Set(currentStep.skillIds);
  return snapshots.filter((skill) => skillIds.has(skill.id));
}

import type { GoatBrainSkill } from "@opencompany/brain";
import type { GoatHarnessSpec } from "./schema";

export type GoatWorkflowHarnessMetadata = NonNullable<GoatHarnessSpec["workflow"]> & {
  // Immutable skill contents resolved when the workflow task was created.
  // Codex materializes these as native SKILL.md inputs; older persisted specs
  // only have skillIds, so this remains optional.
  skillSnapshots?: GoatBrainSkill[];
};

export type GoatWorkflowHarnessSpec = Omit<GoatHarnessSpec, "workflow"> & {
  workflow: GoatWorkflowHarnessMetadata;
};

export function getGoatWorkflowHarnessSkillSnapshots(
  harnessSpec: GoatHarnessSpec,
): GoatBrainSkill[] | undefined {
  const workflow = harnessSpec.workflow as GoatWorkflowHarnessMetadata | undefined;
  const snapshots = workflow?.skillSnapshots;
  const currentStep = workflow?.steps?.[workflow.currentStepIndex ?? 0];
  if (!snapshots || !currentStep) return snapshots;
  const skillIds = new Set(currentStep.skillIds);
  return snapshots.filter((skill) => skillIds.has(skill.id));
}

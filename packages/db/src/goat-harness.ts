import type { GoatBrainSkill } from "@opencompany/goat-brain";
import type { GoatHarnessSpec } from "./goat-schema";

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
  return (harnessSpec.workflow as GoatWorkflowHarnessMetadata | undefined)?.skillSnapshots;
}

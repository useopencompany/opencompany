import type { HarnessSpec } from "./product-schema";

export type WorkflowHarnessMetadata = NonNullable<HarnessSpec["workflow"]>;

export type WorkflowHarnessSpec = Omit<HarnessSpec, "workflow"> & {
  workflow: WorkflowHarnessMetadata;
};

export function getWorkflowHarnessSkillBundleIds(harnessSpec: HarnessSpec): string[] {
  const workflow = harnessSpec.workflow;
  if (!workflow) return [];
  const currentStep = workflow.steps?.[workflow.currentStepIndex ?? 0];
  if (!currentStep) {
    throw new Error("Workflow Task Harness is missing immutable Skill bundle IDs.");
  }
  if (currentStep.skillBundleIds === undefined && isSkillFreeLegacyWorkflow(workflow)) return [];
  if (!Array.isArray(currentStep.skillBundleIds)) {
    throw new Error("Workflow Task Harness is missing immutable Skill bundle IDs.");
  }
  if (currentStep.skillBundleIds.some((id) => typeof id !== "string" || id.length === 0)) {
    throw new Error("Workflow Task Harness contains an invalid Skill bundle ID.");
  }
  return currentStep.skillBundleIds;
}

function isSkillFreeLegacyWorkflow(workflow: WorkflowHarnessMetadata): boolean {
  // The immutable-bundle cutover cannot trust copied legacy Skill content. A harness with no Skill
  // references or snapshots has nothing to remap, so treating its missing arrays as empty preserves
  // pre-cutover schedules without weakening the fail-closed path for Skill-dependent workflows.
  const legacy = workflow as WorkflowHarnessMetadata & {
    skillBundleIds?: unknown;
    skillSnapshots?: unknown;
  };
  if (!Array.isArray(legacy.skillIds) || legacy.skillIds.length > 0) return false;
  if (
    legacy.skillBundleIds !== undefined &&
    (!Array.isArray(legacy.skillBundleIds) || legacy.skillBundleIds.length > 0)
  ) {
    return false;
  }
  if (
    legacy.skillSnapshots !== undefined &&
    (!Array.isArray(legacy.skillSnapshots) || legacy.skillSnapshots.length > 0)
  ) {
    return false;
  }
  if (!Array.isArray(legacy.steps) || legacy.steps.length === 0) return false;
  return legacy.steps.every(
    (step) =>
      Array.isArray(step.skillIds) &&
      step.skillIds.length === 0 &&
      (step.skillBundleIds === undefined ||
        (Array.isArray(step.skillBundleIds) && step.skillBundleIds.length === 0)),
  );
}

export function getWorkflowHarnessPluginIds(harnessSpec: HarnessSpec): string[] {
  const pluginIds = harnessSpec.workflow?.pluginIds;
  // Tasks created before Plugin snapshots shipped have no Plugin contract and safely load none.
  if (pluginIds === undefined) return [];
  if (!Array.isArray(pluginIds)) throw new Error("Workflow Task Harness has invalid Plugin IDs.");
  if (pluginIds.some((id) => typeof id !== "string" || id.length === 0)) {
    throw new Error("Workflow Task Harness contains an invalid Plugin ID.");
  }
  return pluginIds;
}

export function getWorkflowHarnessPluginSkillBundleIds(harnessSpec: HarnessSpec): string[] {
  const workflow = harnessSpec.workflow;
  if (!workflow) return [];
  const currentStep = workflow.steps?.[workflow.currentStepIndex ?? 0];
  if (!currentStep) return [];
  const bundleIds = currentStep?.pluginSkillBundleIds;
  // Older Harnesses could not activate Plugin Skills, so absence is an empty source snapshot.
  if (bundleIds === undefined) return [];
  if (!Array.isArray(bundleIds)) {
    throw new Error("Workflow Task Harness has invalid Plugin Skill bundle IDs.");
  }
  if (bundleIds.some((id) => typeof id !== "string" || id.length === 0)) {
    throw new Error("Workflow Task Harness contains an invalid Plugin Skill bundle ID.");
  }
  const stepBundleIds = new Set(currentStep.skillBundleIds);
  if (bundleIds.some((id) => !stepBundleIds.has(id))) {
    throw new Error("Workflow Task Harness contains an unassigned Plugin Skill bundle ID.");
  }
  return bundleIds;
}

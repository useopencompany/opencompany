import { getWorkflowHarnessSkillBundleIds } from "@opencompany/db/harness";
import type { HarnessSpec } from "@opencompany/db/product-schema";
import {
  type ImmutableSkillBundle,
  loadImmutableSkillBundles,
} from "@opencompany/db/skill-bundle-repository";
import { getDb } from "./db";

export async function loadWorkflowTaskSkillBundles(
  harnessSpec: HarnessSpec,
): Promise<ImmutableSkillBundle[]> {
  const bundleIds = getWorkflowHarnessSkillBundleIds(harnessSpec);
  if (bundleIds.length === 0) return [];
  const workspaceId = harnessSpec.workflow?.workspaceId;
  if (!workspaceId) {
    throw new Error("Workflow Task Skill bundles require a workspace ID.");
  }
  return loadImmutableSkillBundles(getDb(), { workspaceId, bundleIds });
}

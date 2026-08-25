import {
  getWorkflowHarnessPluginIds,
  getWorkflowHarnessSkillBundleIds,
} from "@opencompany/db/harness";
import {
  type EnabledPluginRuntime,
  loadEnabledPluginRuntime,
} from "@opencompany/db/plugin-runtime-repository";
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

export async function loadWorkflowTaskPluginRuntime(
  harnessSpec: HarnessSpec,
): Promise<EnabledPluginRuntime> {
  const workflow = harnessSpec.workflow;
  if (!workflow) return { plugins: [], skills: [], mcpPlugins: [] };
  const workspaceId = workflow.workspaceId;
  if (!workspaceId) throw new Error("Workflow Task Plugins require a workspace ID.");
  return loadEnabledPluginRuntime(getDb(), {
    workspaceId,
    pluginIds: getWorkflowHarnessPluginIds(harnessSpec),
  });
}

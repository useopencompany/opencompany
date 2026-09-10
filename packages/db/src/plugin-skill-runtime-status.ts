import { and, eq, inArray } from "drizzle-orm";
import { pluginAccess } from "./plugin-access";
import { pluginSkills, plugins } from "./product-schema";

type DbClient = any;

export async function loadEnabledPluginSkillBundleIds(
  db: DbClient,
  input: { workspaceId: string; userId: string; bundleIds: readonly string[] },
): Promise<Set<string>> {
  const bundleIds = [...new Set(input.bundleIds)];
  if (bundleIds.length === 0) return new Set();

  const rows = await db
    .select({ bundleId: pluginSkills.skillBundleId })
    .from(pluginSkills)
    .innerJoin(
      plugins,
      and(eq(plugins.id, pluginSkills.pluginId), eq(plugins.workspaceId, pluginSkills.workspaceId)),
    )
    .where(
      and(
        eq(pluginSkills.workspaceId, input.workspaceId),
        eq(plugins.status, "enabled"),
        pluginAccess(input),
        inArray(pluginSkills.skillBundleId, bundleIds),
      ),
    );

  return new Set(rows.map((row: { bundleId: string }) => row.bundleId));
}

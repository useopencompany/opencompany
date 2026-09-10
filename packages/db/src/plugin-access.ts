import { CoreError } from "@opencompany/core";
import { and, eq, sql } from "drizzle-orm";
import { pluginOwnershipRollout, plugins } from "./product-schema";
import { skillMembership } from "./skill-access";

export type PluginReader = { workspaceId: string; userId: string };

export function pluginAccess(input: PluginReader) {
  if (!input.userId) return sql`false`;
  return and(
    eq(plugins.workspaceId, input.workspaceId),
    eq(plugins.ownerUserId, input.userId),
    skillMembership(input),
  )!;
}

export async function assertPersonalPluginWritesEnabled(db: any) {
  const [rollout] = await db
    .select({ enabled: pluginOwnershipRollout.personalEnabled })
    .from(pluginOwnershipRollout)
    .where(eq(pluginOwnershipRollout.id, "personal_plugins"))
    .limit(1);
  if (!rollout?.enabled)
    throw new CoreError(
      "conflict",
      "Personal plugin setup is being prepared. Please try again after the workspace update finishes.",
    );
}

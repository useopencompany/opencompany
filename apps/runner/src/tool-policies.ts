import { policyMapKey, type WorkspaceToolPolicyMap } from "@opencompany/agent-runtime";
import { workspaceToolPolicies } from "@opencompany/db/schema";
import { eq } from "drizzle-orm";
import { getDb } from "./db";

// Load the workspace's saved tool-policy overrides into a flat lookup map. A missing
// (provider, group) key means "use the registry default stance" — resolved later by
// resolveToolDecision — so an empty map is a valid, fully-permissive-by-default state.
export async function loadWorkspaceToolPolicy(
  workspaceId: string,
): Promise<WorkspaceToolPolicyMap> {
  const rows = await getDb()
    .select({
      providerKey: workspaceToolPolicies.providerKey,
      permissionGroup: workspaceToolPolicies.permissionGroup,
      decision: workspaceToolPolicies.decision,
    })
    .from(workspaceToolPolicies)
    .where(eq(workspaceToolPolicies.workspaceId, workspaceId));

  const map: WorkspaceToolPolicyMap = new Map();
  for (const row of rows) {
    map.set(policyMapKey(row.providerKey, row.permissionGroup), row.decision);
  }
  return map;
}

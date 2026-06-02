import type { PermissionGroup, PolicyDecision } from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import { workspaceToolPolicies } from "@opencompany/db/schema";
import { eq } from "drizzle-orm";

// Sparse saved overrides keyed by provider then group. A missing entry means the
// provider/group uses the registry default stance — resolved in the UI and runner.
export type WorkspaceToolPolicyOverrides = Record<
  string,
  Partial<Record<PermissionGroup, PolicyDecision>>
>;

export async function loadWorkspaceToolPolicyOverrides(
  workspaceId: string,
): Promise<WorkspaceToolPolicyOverrides> {
  const rows = await getDb()
    .select({
      providerKey: workspaceToolPolicies.providerKey,
      permissionGroup: workspaceToolPolicies.permissionGroup,
      decision: workspaceToolPolicies.decision,
    })
    .from(workspaceToolPolicies)
    .where(eq(workspaceToolPolicies.workspaceId, workspaceId));

  const overrides: WorkspaceToolPolicyOverrides = {};
  for (const row of rows) {
    (overrides[row.providerKey] ??= {})[row.permissionGroup] = row.decision;
  }
  return overrides;
}

"use server";

import {
  PERMISSION_GROUPS,
  type PermissionGroup,
  POLICY_DECISIONS,
  type PolicyDecision,
  PROVIDER_PERMISSION_REGISTRY,
} from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import { workspaceToolPolicies } from "@opencompany/db/schema";
import { currentWorkspace } from "@/lib/auth";

function newToolPolicyId() {
  return `wtp_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

// Upsert a single (provider, group) decision for the workspace. Admin-only: this sets
// the maximum blast radius an agent can ever have for a connected provider.
export async function setWorkspaceToolPolicy(input: {
  providerKey: string;
  permissionGroup: PermissionGroup;
  decision: PolicyDecision;
}) {
  const { user, workspace } = await currentWorkspace({ requireAdmin: true });

  const spec = PROVIDER_PERMISSION_REGISTRY[input.providerKey];
  if (!spec || !spec.gated) {
    return { ok: false, error: "Unknown or non-configurable integration." } as const;
  }
  if (!spec.groups.includes(input.permissionGroup)) {
    return { ok: false, error: "This permission does not apply to this integration." } as const;
  }
  if (
    !PERMISSION_GROUPS.includes(input.permissionGroup) ||
    !POLICY_DECISIONS.includes(input.decision)
  ) {
    return { ok: false, error: "Invalid permission setting." } as const;
  }

  const now = new Date();
  await getDb()
    .insert(workspaceToolPolicies)
    .values({
      id: newToolPolicyId(),
      workspaceId: workspace.id,
      providerKey: input.providerKey,
      permissionGroup: input.permissionGroup,
      decision: input.decision,
      updatedByUserId: user.id,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        workspaceToolPolicies.workspaceId,
        workspaceToolPolicies.providerKey,
        workspaceToolPolicies.permissionGroup,
      ],
      set: {
        decision: input.decision,
        updatedByUserId: user.id,
        updatedAt: now,
      },
    });

  return { ok: true } as const;
}

import { resolveActionCatalog } from "@opencompany/agent/actions/catalog";
import { resolveManagedCapabilities } from "@opencompany/agent/capabilities/resolve";
import { applyIntegrationCapabilityMode } from "@opencompany/db/integrations";
import { getWorkspaceRole } from "@opencompany/db/workspaces";

export async function alwaysAllowAction(input: {
  userWorkosId: string;
  workspaceId: string;
  actionId: string;
}): Promise<{ changed: boolean }> {
  const role = await getWorkspaceRole({
    userWorkosId: input.userWorkosId,
    workspaceId: input.workspaceId,
  });
  if (!role) throw new Error("The actor is no longer a member of this workspace.");

  const catalog = await resolveActionCatalog(
    {
      userWorkosId: input.userWorkosId,
      workspaceId: input.workspaceId,
    },
    { resolveManagedCapabilities: resolveManagedCapabilities },
  );
  const action = catalog.actions.find((entry) => entry.id === input.actionId);
  const permission = action?.permission;
  if (!permission || permission.integrationIds.length === 0) {
    // The action may already be allowed or may have disappeared between the
    // approval card render and this command. The one-off approval still runs.
    return { changed: false };
  }
  await applyIntegrationCapabilityMode({
    integrationIds: permission.integrationIds,
    capabilityId: permission.capabilityId,
    mode: "on",
  });
  return { changed: true };
}

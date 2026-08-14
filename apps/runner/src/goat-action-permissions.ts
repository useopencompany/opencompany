import { applyGoatIntegrationCapabilityMode } from "@opencompany/db/goat-integrations";
import { getGoatWorkspaceRole } from "@opencompany/db/goat-workspaces";
import { resolveGoatActionCatalog } from "@opencompany/goat-agent/actions/catalog";
import { resolveGoatManagedCapabilities } from "@opencompany/goat-agent/capabilities/resolve";

export async function alwaysAllowGoatAction(input: {
  userWorkosId: string;
  workspaceId: string;
  actionId: string;
}): Promise<{ changed: boolean }> {
  const role = await getGoatWorkspaceRole({
    userWorkosId: input.userWorkosId,
    workspaceId: input.workspaceId,
  });
  if (!role) throw new Error("The actor is no longer a member of this workspace.");

  const catalog = await resolveGoatActionCatalog(
    {
      userWorkosId: input.userWorkosId,
      workspaceId: input.workspaceId,
    },
    { resolveManagedCapabilities: resolveGoatManagedCapabilities },
  );
  const action = catalog.actions.find((entry) => entry.id === input.actionId);
  const permission = action?.permission;
  if (!permission || permission.integrationIds.length === 0) {
    // The action may already be allowed or may have disappeared between the
    // approval card render and this command. The one-off approval still runs.
    return { changed: false };
  }
  await applyGoatIntegrationCapabilityMode({
    integrationIds: permission.integrationIds,
    capabilityId: permission.capabilityId,
    mode: "on",
  });
  return { changed: true };
}

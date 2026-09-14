import { resolveActionCatalog } from "@opencompany/agent/actions/catalog";
import { resolveManagedCapabilities } from "@opencompany/agent/capabilities/resolve";
import {
  applyIntegrationCapabilityMode,
  applyIntegrationToolMode,
} from "@opencompany/db/integrations";
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
  if (!action)
    throw new Error("This action is no longer available. Could not save the permission.");
  if (action.permissionMode === "on") return { changed: false };
  const permission = action.permission;
  if (!permission || permission.integrationIds.length === 0) {
    throw new Error("This action does not support a standing permission.");
  }

  // A standing permission is saved as narrowly as the action allows. Every plugin action is one
  // discovered MCP tool, so approving it grants that tool and nothing else — approving a label
  // write can no longer hand over automatic trashing from the same capability group. This is also
  // what makes custom MCP servers safe here: the grant names the tool the user just saw, so the
  // server redefining a different tool cannot inherit the consent.
  if (permission.toolId) {
    await applyIntegrationToolMode({
      integrationIds: permission.integrationIds,
      toolId: permission.toolId,
      mode: "on",
    });
    return { changed: true };
  }

  // Native actions are not discovered tools and have no per-tool key, so they still save against
  // their capability. Custom MCP tools always carry a tool key and never reach this branch.
  if (permission.provider === "custom_mcp") {
    throw new Error("Set standing permissions for individual custom MCP tools in Plugins.");
  }
  await applyIntegrationCapabilityMode({
    integrationIds: permission.integrationIds,
    capabilityId: permission.capabilityId,
    mode: "on",
  });
  return { changed: true };
}

import {
  provisionWorkspace as provisionWorkspaceWithClient,
  WorkspaceProvisioningError,
} from "@opencompany/agent/workspaces/provisioning";
import { getWorkOSClient } from "@/lib/workos-client";

export { WorkspaceProvisioningError };

export function provisionWorkspace(input: {
  authUserId: string;
  userWorkosId: string;
  name: string;
  slug?: string | null;
}) {
  return provisionWorkspaceWithClient(input, { workos: getWorkOSClient() });
}

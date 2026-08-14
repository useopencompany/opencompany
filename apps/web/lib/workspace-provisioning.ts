import {
  GoatWorkspaceProvisioningError,
  provisionGoatWorkspace as provisionGoatWorkspaceWithClient,
} from "@opencompany/goat-agent/workspaces/provisioning";
import { getWorkOSClient } from "@/lib/workos-client";

export { GoatWorkspaceProvisioningError };

export function provisionGoatWorkspace(input: {
  authUserId: string;
  userWorkosId: string;
  name: string;
  slug?: string | null;
}) {
  return provisionGoatWorkspaceWithClient(input, { workos: getWorkOSClient() });
}

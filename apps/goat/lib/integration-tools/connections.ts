import {
  getGoatGitHubIntegrationState,
  isGoatGitHubIntegrationConfigured,
} from "@/lib/integrations/github";
import { getGoatLinearIntegrationState } from "@/lib/integrations/linear-mcp";
import type { IntegrationProviderId } from "./types";

// Resolves which integration providers are eligible for main-chat tools:
// Linear from the user's personal linear_mcp connection, GitHub from the
// workspace installation. This feeds the request-time catalog only — every
// tool execution re-resolves connection state and resource access itself.
export async function resolveConnectedIntegrationProviders(input: {
  userWorkosId: string;
  workspaceId: string;
}): Promise<IntegrationProviderId[]> {
  const [linear, github] = await Promise.all([
    getGoatLinearIntegrationState(input.userWorkosId).catch(() => null),
    isGoatGitHubIntegrationConfigured()
      ? getGoatGitHubIntegrationState(input.workspaceId).catch(() => null)
      : Promise.resolve(null),
  ]);

  const providers: IntegrationProviderId[] = [];
  if (linear?.connected) providers.push("linear");
  if (github?.connected) providers.push("github");
  return providers;
}

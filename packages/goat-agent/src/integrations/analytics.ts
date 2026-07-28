import { captureStatsigServerEvent } from "@opencompany/statsig/server";

// Shared choke point for the `integration_added` Statsig event so every provider's connect
// path reports it the same way. Fire-and-forget from callers via `void` / `after(...)`;
// `captureStatsigServerEvent` swallows its own errors and never throws.
export async function captureGoatIntegrationAddedAnalytics(input: {
  userWorkosId: string;
  provider: string;
  workspaceId?: string;
}) {
  await captureStatsigServerEvent("integration_added", input.userWorkosId, {
    user_id: input.userWorkosId,
    provider: input.provider,
    ...(input.workspaceId ? { workspace_id: input.workspaceId } : {}),
  });
}

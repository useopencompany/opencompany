import { captureServerEvent } from "@opencompany/analytics/server";

// Shared choke point for the `integration_added` event so every provider's connect
// path reports it the same way. Fire-and-forget from callers via `void` / `after(...)`;
// `captureServerEvent` swallows its own errors and never throws.
export async function captureIntegrationAddedAnalytics(input: {
  userWorkosId: string;
  provider: string;
  workspaceId?: string;
}) {
  await captureServerEvent("integration_added", input.userWorkosId, {
    provider: input.provider,
    ...(input.workspaceId ? { workspace_id: input.workspaceId } : {}),
  });
}

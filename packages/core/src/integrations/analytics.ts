import { captureGoatServerEvent } from "@opencompany/analytics/goat/server";

// Shared choke point for the `integration_added` event so every provider's connect
// path reports it the same way. Fire-and-forget from callers via `void` / `after(...)`;
// `captureGoatServerEvent` swallows its own errors and never throws.
export async function captureGoatIntegrationAddedAnalytics(input: {
  userWorkosId: string;
  provider: string;
  workspaceId?: string;
}) {
  await captureGoatServerEvent("integration_added", input.userWorkosId, {
    provider: input.provider,
    ...(input.workspaceId ? { workspace_id: input.workspaceId } : {}),
  });
}

import { captureProductServerEvent } from "@opencompany/analytics/product/server";

// Capture only after credentials are persisted. Reauthorization keeps the same connection ID,
// so reports can separate authorization activity from distinct connected accounts.
export async function captureConnectionAddedAnalytics(input: {
  userWorkosId: string;
  provider: string;
  connectionId: string;
  workspaceId?: string;
}) {
  await captureProductServerEvent("connection_added", input.userWorkosId, {
    provider: input.provider,
    connection_id: input.connectionId,
    ...(input.workspaceId ? { workspace_id: input.workspaceId } : {}),
  });
}

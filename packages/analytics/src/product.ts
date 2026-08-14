import { captureServerEvent } from "./server";

// Billing v4: ingestion pauses on an empty credit balance (or behind an
// existing backlog), not on a monthly quota — the paused/backlog events are
// what remains of the old quota-threshold analytics.
export type ProductIngestionQuotaAnalyticsUpdate = {
  workspaceId: string;
  pendingUnits: number;
  paused: boolean;
};

export function captureProductIngestionQuotaAnalytics(
  updates: ProductIngestionQuotaAnalyticsUpdate[] | undefined,
) {
  for (const update of updates ?? []) {
    if (update.paused) {
      void captureServerEvent("goat_ingestion_paused", update.workspaceId, {
        workspace_id: update.workspaceId,
        pending_units: update.pendingUnits,
      });
      void captureServerEvent("goat_ingestion_backlog_size", update.workspaceId, {
        workspace_id: update.workspaceId,
        pending_units: update.pendingUnits,
      });
    }
  }
}

import { captureServerEvent } from "./server";

export type GoatIngestionQuotaAnalyticsUpdate = {
  workspaceId: string;
  plan: "free" | "pro";
  usedBefore: number;
  usedAfter: number;
  limit: number;
  pendingUnits: number;
  paused: boolean;
};

export function captureGoatIngestionQuotaAnalytics(
  updates: GoatIngestionQuotaAnalyticsUpdate[] | undefined,
) {
  for (const update of updates ?? []) {
    const beforePercent = (update.usedBefore / update.limit) * 100;
    const afterPercent = (update.usedAfter / update.limit) * 100;
    for (const threshold of [80, 100] as const) {
      if (beforePercent < threshold && afterPercent >= threshold) {
        void captureServerEvent("goat_ingestion_quota_threshold", update.workspaceId, {
          workspace_id: update.workspaceId,
          plan: update.plan,
          used: update.usedAfter,
          limit: update.limit,
          threshold_percent: threshold,
        });
      }
    }
    if (update.paused) {
      void captureServerEvent("goat_ingestion_quota_reached", update.workspaceId, {
        workspace_id: update.workspaceId,
        plan: update.plan,
        used: update.usedAfter,
        limit: update.limit,
        pending_units: update.pendingUnits,
      });
      void captureServerEvent("goat_ingestion_backlog_size", update.workspaceId, {
        workspace_id: update.workspaceId,
        pending_units: update.pendingUnits,
      });
    }
  }
}

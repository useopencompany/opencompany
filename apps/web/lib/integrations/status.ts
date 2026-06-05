const MAX_INTEGRATION_STATUS_REASON_LENGTH = 240;

export type WorkspaceIntegrationStatus =
  | "not_connected"
  | "connected"
  | "needs_repository_access"
  | "needs_reauth"
  | "sync_failed"
  | "error";

export function githubStatus(input: {
  configured: boolean;
  connectionStatuses: Array<"connected" | "needs_reauth" | "sync_failed" | "disconnected">;
  availableRepositoryCount: number;
}): WorkspaceIntegrationStatus {
  if (!input.configured) return "error";
  const activeConnectionStatuses = input.connectionStatuses.filter(
    (status) => status !== "disconnected",
  );
  if (activeConnectionStatuses.length === 0) return "not_connected";
  if (activeConnectionStatuses.includes("needs_reauth")) return "needs_reauth";
  if (activeConnectionStatuses.includes("sync_failed")) return "sync_failed";
  if (input.availableRepositoryCount > 0) return "connected";
  return "needs_repository_access";
}

export function googleStatus(input: {
  configured: boolean;
  connectionStatuses: Array<"connected" | "needs_reauth" | "sync_failed" | "disconnected">;
}): WorkspaceIntegrationStatus {
  if (!input.configured) return "error";
  const activeConnectionStatuses = input.connectionStatuses.filter(
    (status) => status !== "disconnected",
  );
  if (activeConnectionStatuses.length === 0) return "not_connected";
  if (activeConnectionStatuses.includes("needs_reauth")) return "needs_reauth";
  if (activeConnectionStatuses.includes("sync_failed")) return "sync_failed";
  return "connected";
}

export function sanitizeIntegrationStatusReason(reason: string, fallback: string | null = null) {
  const sanitized = reason
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_INTEGRATION_STATUS_REASON_LENGTH);

  return sanitized || fallback;
}

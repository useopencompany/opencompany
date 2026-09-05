import { browserProfilesKilled } from "@opencompany/agent/browser-profiles/index";
import { reconcileBrowserProfileSessions } from "@opencompany/agent/browser-profiles/reconciler";
import { captureException, createLogger } from "@opencompany/observability";
import { createPollingWorker } from "./polling-worker";

const logger = createLogger({
  service: "opencompany-runner",
  runtime: "browser-profile-reconciler",
});
const BROWSER_PROFILE_RECONCILE_INTERVAL_MS = 60_000;

export function startBrowserProfileReconciler(options: { pollIntervalMs?: number } = {}) {
  return createPollingWorker({
    pollIntervalMs: Math.max(
      1_000,
      options.pollIntervalMs ?? BROWSER_PROFILE_RECONCILE_INTERVAL_MS,
    ),
    poll: async ({ signal }) => {
      const result = await reconcileBrowserProfileSessions({
        signal,
        releaseAll: browserProfilesKilled(),
      });
      if (
        result.released > 0 ||
        result.settled > 0 ||
        result.clearedSessionLocks > 0 ||
        result.clearedStartingLocks > 0 ||
        result.clearedOrphanedLocks > 0
      ) {
        logger.info("Reconciled Browserbase profile sessions", {
          event: "opencompany.runner_browser_profile_reconcile_finished",
          provider_running_count: result.providerRunning,
          persisted_open_count: result.persistedOpen,
          released_count: result.released,
          settled_count: result.settled,
          failed_count: result.failed,
          cleared_session_lock_count: result.clearedSessionLocks,
          cleared_starting_lock_count: result.clearedStartingLocks,
          cleared_orphaned_lock_count: result.clearedOrphanedLocks,
        });
      }
    },
    onError: (error) => {
      captureException(error, {
        event: "opencompany.runner_browser_profile_reconcile_failed",
      });
      logger.error("Browserbase profile session reconciliation failed", {
        event: "opencompany.runner_browser_profile_reconcile_failed",
        error,
      });
    },
  });
}

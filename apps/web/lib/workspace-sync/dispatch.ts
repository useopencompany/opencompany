import { captureException, createLogger } from "@opencompany/observability";
import { after } from "next/server";
import { dispatchWorkspaceSyncRequested } from "@/lib/workspace-sync/events";

const logger = createLogger({ service: "opencompany-web", runtime: "server" });

/**
 * Request a workspace→GitHub reconcile after the current request commits. Runs
 * in a Next.js `after()` callback so the mutation response isn't blocked on the
 * Inngest dispatch. The workspaceSyncJobs row (the durable signal) is written
 * synchronously by the caller via markWorkspaceDirty; this only nudges Inngest,
 * and the outbox sweeper is the backstop if the dispatch fails.
 */
export function scheduleWorkspaceSyncDispatch(input: { workspaceId: string }) {
  after(async () => {
    try {
      const result = await dispatchWorkspaceSyncRequested({ workspaceId: input.workspaceId });
      logger.info("Dispatched workspace GitHub sync event", {
        event: "opencompany.workspace_sync_dispatch_succeeded",
        workspace_id: input.workspaceId,
        inngest_event_ids: result.ids,
      });
    } catch (error) {
      captureException(error, {
        event: "opencompany.workspace_sync_dispatch_failed",
        workspace_id: input.workspaceId,
      });
      logger.error("Failed to dispatch workspace GitHub sync event", {
        event: "opencompany.workspace_sync_dispatch_failed",
        workspace_id: input.workspaceId,
        ...errorLogFields(error),
      });
    }
  });
}

function errorLogFields(error: unknown) {
  if (error instanceof Error) {
    return {
      error_name: error.name,
      error_message: error.message,
    };
  }

  return {
    error_name: typeof error,
    error_message: typeof error === "string" ? error : "Unknown error",
  };
}

import { captureException, createLogger } from "@opencompany/observability";
import { after } from "next/server";
import { dispatchWorkspaceSyncRequested } from "@/lib/workspace-state/sync-events";

const logger = createLogger({ service: "opencompany-web", runtime: "server" });

// Fire-and-forget immediate dispatch for web producers. The runner does NOT use
// this (it only enqueues and relies on the cron sweeper) to avoid coupling the
// runner to the web Inngest client. Failure here is non-fatal: the sweeper picks
// the job up within ~60s regardless.
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
    return { error_name: error.name, error_message: error.message };
  }
  return {
    error_name: typeof error,
    error_message: typeof error === "string" ? error : "Unknown error",
  };
}

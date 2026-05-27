import { captureException, createLogger } from "@opencompany/observability";
import { after } from "next/server";
import { dispatchBrainSyncRequested } from "@/lib/brain/sync-events";

const logger = createLogger({ service: "opencompany-web", runtime: "server" });

export function scheduleBrainSyncDispatch(input: { workspaceId: string; path: string }) {
  after(async () => {
    try {
      const result = await dispatchBrainSyncRequested({
        workspaceId: input.workspaceId,
        path: input.path,
      });
      logger.info("Dispatched Brain GitHub sync event", {
        event: "opencompany.brain_sync_dispatch_succeeded",
        workspace_id: input.workspaceId,
        path: input.path,
        inngest_event_ids: result.ids,
      });
    } catch (error) {
      captureException(error, {
        event: "opencompany.brain_sync_dispatch_failed",
        workspace_id: input.workspaceId,
        path: input.path,
        dispatch_status_marked_failed: false,
      });
      logger.error("Failed to dispatch Brain GitHub sync event", {
        event: "opencompany.brain_sync_dispatch_failed",
        workspace_id: input.workspaceId,
        path: input.path,
        dispatch_status_marked_failed: false,
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

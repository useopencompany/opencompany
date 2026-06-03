import { inngest } from "@/lib/inngest/client";

export const WORKSPACE_SYNC_REQUESTED_EVENT = "workspace.sync_requested";

export type WorkspaceSyncRequestedPayload = {
  workspaceId: string;
};

export function dispatchWorkspaceSyncRequested(input: WorkspaceSyncRequestedPayload) {
  return inngest.send({
    name: WORKSPACE_SYNC_REQUESTED_EVENT,
    data: {
      workspaceId: input.workspaceId,
    },
  });
}

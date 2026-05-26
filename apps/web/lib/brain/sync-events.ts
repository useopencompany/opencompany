import { inngest } from "@/lib/inngest/client";

export const BRAIN_SYNC_REQUESTED_EVENT = "brain.sync_requested";

export function dispatchBrainSyncRequested(input: { workspaceId: string; path: string }) {
  return inngest.send({
    name: BRAIN_SYNC_REQUESTED_EVENT,
    data: {
      workspaceId: input.workspaceId,
      path: input.path,
    },
  });
}

import { inngest } from "@/lib/inngest/client";

export const AGENT_SYNC_REQUESTED_EVENT = "agent.sync_requested";
export const AGENT_FILE_SYNC_REQUESTED_EVENT = "agent_file.sync_requested";

export async function dispatchAgentSyncRequested(input: { agentId: string; workspaceId: string }) {
  return inngest.send({
    name: AGENT_SYNC_REQUESTED_EVENT,
    data: input,
  });
}

export async function dispatchAgentFileSyncRequested(input: { workspaceId: string; path: string }) {
  return inngest.send({
    name: AGENT_FILE_SYNC_REQUESTED_EVENT,
    data: input,
  });
}

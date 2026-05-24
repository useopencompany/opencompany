import { inngest } from "@/lib/inngest/client";

export const AGENT_SYNC_REQUESTED_EVENT = "agent.sync_requested";

export async function dispatchAgentSyncRequested(input: { agentId: string; workspaceId: string }) {
  return inngest.send({
    name: AGENT_SYNC_REQUESTED_EVENT,
    data: input,
  });
}

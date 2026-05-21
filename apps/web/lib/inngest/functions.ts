import { inngest } from "@/lib/inngest/client";
import { materializeAgentToGitHub } from "@/lib/agents/materialize";
import { AGENT_SYNC_REQUESTED_EVENT } from "@/lib/agents/sync-events";

export const syncAgentToGitHub = inngest.createFunction(
  {
    id: "sync-agent-to-github",
    name: "Sync agent to GitHub",
    retries: 5,
    concurrency: {
      limit: 1,
      key: "event.data.agentId",
    },
    triggers: { event: AGENT_SYNC_REQUESTED_EVENT },
  },
  async ({ event, step }) => {
    await step.sleep("coalesce agent edits", "10s");

    return step.run("materialize latest agent file", async () => {
      return materializeAgentToGitHub(event.data.agentId, { mode: "scheduled" });
    });
  },
);

export const inngestFunctions = [syncAgentToGitHub];

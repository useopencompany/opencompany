import {
  AGENT_MESSAGE_SUBMITTED_EVENT,
  AGENT_SESSION_ABORT_REQUESTED_EVENT,
  AGENT_SESSION_STARTED_EVENT,
} from "@/lib/agent-sessions/events";
import { callRunner } from "@/lib/agent-sessions/runner";
import { materializeAgentToGitHub } from "@/lib/agents/materialize";
import { AGENT_SYNC_REQUESTED_EVENT } from "@/lib/agents/sync-events";
import { inngest } from "@/lib/inngest/client";

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

export const startAgentSession = inngest.createFunction(
  {
    id: "start-agent-session",
    name: "Start agent session",
    retries: 3,
    concurrency: {
      limit: 1,
      key: "event.data.sessionId",
    },
    triggers: { event: AGENT_SESSION_STARTED_EVENT },
  },
  async ({ event, step }) => {
    return step.run("start runner session", async () => {
      await callRunner(`/internal/sessions/${event.data.sessionId}/start`, {
        event: "opencompany.inngest_start_runner_failed",
        session_id: event.data.sessionId,
      });
      return { ok: true };
    });
  },
);

export const runAgentSessionMessage = inngest.createFunction(
  {
    id: "run-agent-session-message",
    name: "Run agent session message",
    retries: 3,
    concurrency: {
      limit: 1,
      key: "event.data.sessionId",
    },
    triggers: { event: AGENT_MESSAGE_SUBMITTED_EVENT },
  },
  async ({ event, step }) => {
    return step.run("run runner message", async () => {
      await callRunner(
        `/internal/sessions/${event.data.sessionId}/messages/${event.data.messageId}/run`,
        {
          event: "opencompany.inngest_run_message_failed",
          session_id: event.data.sessionId,
          message_id: event.data.messageId,
        },
      );
      return { ok: true };
    });
  },
);

export const generateAgentSessionTitle = inngest.createFunction(
  {
    id: "generate-agent-session-title",
    name: "Generate agent session title",
    retries: 1,
    concurrency: {
      limit: 1,
      key: "event.data.sessionId",
    },
    triggers: { event: AGENT_MESSAGE_SUBMITTED_EVENT },
  },
  async ({ event, step }) => {
    return step.run("generate runner session title", async () => {
      await callRunner(
        `/internal/sessions/${event.data.sessionId}/messages/${event.data.messageId}/title`,
        {
          event: "opencompany.inngest_generate_title_failed",
          session_id: event.data.sessionId,
          message_id: event.data.messageId,
        },
      );
      return { ok: true };
    });
  },
);

export const abortAgentSession = inngest.createFunction(
  {
    id: "abort-agent-session",
    name: "Abort agent session",
    retries: 1,
    triggers: { event: AGENT_SESSION_ABORT_REQUESTED_EVENT },
  },
  async ({ event, step }) => {
    return step.run("abort runner session", async () => {
      await callRunner(`/internal/sessions/${event.data.sessionId}/abort`, {
        event: "opencompany.inngest_abort_runner_failed",
        session_id: event.data.sessionId,
      });
      return { ok: true };
    });
  },
);

export const inngestFunctions = [
  syncAgentToGitHub,
  startAgentSession,
  runAgentSessionMessage,
  generateAgentSessionTitle,
  abortAgentSession,
];

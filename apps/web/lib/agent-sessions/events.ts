import { inngest } from "@/lib/inngest/client";

export const AGENT_SESSION_STARTED_EVENT = "agent.session_started";
export const AGENT_MESSAGE_SUBMITTED_EVENT = "agent.message_submitted";
export const AGENT_SESSION_ABORT_REQUESTED_EVENT = "agent.session_abort_requested";

export function dispatchAgentSessionStarted(input: { sessionId: string; workspaceId: string }) {
  return inngest.send({
    name: AGENT_SESSION_STARTED_EVENT,
    data: input,
  });
}

export function dispatchAgentMessageSubmitted(input: {
  sessionId: string;
  messageId: string;
  workspaceId: string;
}) {
  return inngest.send({
    name: AGENT_MESSAGE_SUBMITTED_EVENT,
    data: input,
  });
}

export function dispatchAgentSessionAbortRequested(input: {
  sessionId: string;
  workspaceId: string;
}) {
  return inngest.send({
    name: AGENT_SESSION_ABORT_REQUESTED_EVENT,
    data: input,
  });
}

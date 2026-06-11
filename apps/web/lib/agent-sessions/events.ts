import { inngest } from "@/lib/inngest/client";

export const AGENT_SESSION_STARTED_EVENT = "agent.session_started";
export const AGENT_MESSAGE_SUBMITTED_EVENT = "agent.message_submitted";
export const AGENT_AFTER_SESSION_CHECK_EVENT = "agent.after_session_check_requested";
export const AGENT_SESSION_ABORT_REQUESTED_EVENT = "agent.session_abort_requested";
export const AGENT_APPROVAL_RESUME_EVENT = "agent-session/approval.resume";
export const AGENT_QUESTION_RESUME_EVENT = "agent-session/question.resume";

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

export function dispatchAgentAfterSessionCheck(input: {
  sessionId: string;
  messageId: string;
  workspaceId: string;
  // Optional override for how long the session must stay idle before the check fires. Omit to use
  // the platform default (AFTER_SESSION_IDLE_TRIGGER_SECONDS).
  idleDelaySeconds?: number;
}) {
  return inngest.send({
    name: AGENT_AFTER_SESSION_CHECK_EVENT,
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

export function dispatchAgentApprovalResume(input: { sessionId: string; toolCallId: string }) {
  return inngest.send({
    name: AGENT_APPROVAL_RESUME_EVENT,
    data: input,
  });
}

export function dispatchAgentQuestionResume(input: { sessionId: string; toolCallId: string }) {
  return inngest.send({
    name: AGENT_QUESTION_RESUME_EVENT,
    data: input,
  });
}

import { dispatchAgentMessageSubmitted } from "@/lib/agent-sessions/events";
import { callRunner } from "@/lib/agent-sessions/runner";

type TriggerAgentMessageRunInput = {
  sessionId: string;
  messageId: string;
  workspaceId: string;
};

export async function triggerAgentMessageRun(input: TriggerAgentMessageRunInput) {
  if (!canCallRunnerDirectly()) {
    await dispatchAgentMessageSubmitted(input);
    return;
  }

  try {
    await callRunner(`/internal/sessions/${input.sessionId}/messages/${input.messageId}/run`, {
      event: "opencompany.direct_run_message_failed",
      session_id: input.sessionId,
      message_id: input.messageId,
    });
  } catch {
    await dispatchAgentMessageSubmitted(input);
    return;
  }

  try {
    await callRunner(`/internal/sessions/${input.sessionId}/messages/${input.messageId}/title`, {
      event: "opencompany.direct_generate_title_failed",
      session_id: input.sessionId,
      message_id: input.messageId,
    });
  } catch {
    // callRunner already captures the failure. Do not dispatch the shared message
    // event here, since that would schedule a duplicate message run.
  }
}

function canCallRunnerDirectly() {
  return Boolean(
    (process.env.RUNNER_INTERNAL_URL || process.env.RUNNER_PUBLIC_URL) &&
      process.env.RUNNER_INTERNAL_TOKEN,
  );
}

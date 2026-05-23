import { createLogger } from "@opencompany/observability";
import { dispatchAgentMessageSubmitted } from "@/lib/agent-sessions/events";
import { callRunner } from "@/lib/agent-sessions/runner";

type TriggerAgentMessageRunInput = {
  sessionId: string;
  messageId: string;
  workspaceId: string;
};

const logger = createLogger({ service: "opencompany-web", runtime: "server" });

export async function triggerAgentMessageRun(input: TriggerAgentMessageRunInput) {
  if (!canCallRunnerDirectly()) {
    logger.info("Falling back to Inngest runner dispatch", {
      event: "opencompany.runner_request_fallback",
      reason: "runner_direct_call_unconfigured",
      workspace_id: input.workspaceId,
      session_id: input.sessionId,
      message_id: input.messageId,
    });
    await dispatchAgentMessageSubmitted(input);
    return;
  }

  try {
    await callRunner(`/internal/sessions/${input.sessionId}/messages/${input.messageId}/run`, {
      event: "opencompany.direct_run_message_failed",
      workspace_id: input.workspaceId,
      session_id: input.sessionId,
      message_id: input.messageId,
    });
  } catch (error) {
    logger.warn("Falling back to Inngest runner dispatch", {
      event: "opencompany.runner_request_fallback",
      reason: "direct_runner_request_failed",
      workspace_id: input.workspaceId,
      session_id: input.sessionId,
      message_id: input.messageId,
      error,
    });
    await dispatchAgentMessageSubmitted(input);
    return;
  }

  try {
    await callRunner(`/internal/sessions/${input.sessionId}/messages/${input.messageId}/title`, {
      event: "opencompany.direct_generate_title_failed",
      workspace_id: input.workspaceId,
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

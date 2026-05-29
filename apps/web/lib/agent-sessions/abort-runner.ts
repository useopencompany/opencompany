import { createLogger } from "@opencompany/observability";
import { dispatchAgentSessionAbortRequested } from "@/lib/agent-sessions/events";
import { callRunner } from "@/lib/agent-sessions/runner";

type TriggerAgentSessionAbortInput = {
  sessionId: string;
  workspaceId: string;
};

const logger = createLogger({ service: "opencompany-web", runtime: "server" });

export async function triggerAgentSessionAbort(input: TriggerAgentSessionAbortInput) {
  if (!canCallRunnerDirectly()) {
    logger.info("Falling back to Inngest abort dispatch", {
      event: "opencompany.runner_abort_fallback",
      reason: "runner_direct_call_unconfigured",
      workspace_id: input.workspaceId,
      session_id: input.sessionId,
    });
    await dispatchAgentSessionAbortRequested(input);
    return;
  }

  try {
    await callRunner(`/internal/sessions/${input.sessionId}/abort`, {
      event: "opencompany.direct_abort_session_failed",
      workspace_id: input.workspaceId,
      session_id: input.sessionId,
    });
  } catch (error) {
    logger.warn("Falling back to Inngest abort dispatch", {
      event: "opencompany.runner_abort_fallback",
      reason: "direct_runner_request_failed",
      workspace_id: input.workspaceId,
      session_id: input.sessionId,
      error,
    });
    await dispatchAgentSessionAbortRequested(input);
  }
}

function canCallRunnerDirectly() {
  return Boolean(
    (process.env.RUNNER_INTERNAL_URL || process.env.RUNNER_PUBLIC_URL) &&
      process.env.RUNNER_INTERNAL_TOKEN,
  );
}

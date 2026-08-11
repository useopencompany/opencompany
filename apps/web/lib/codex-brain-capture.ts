import type {
  GoatCodexBrainCaptureGatewayRequest,
  GoatCodexBrainCaptureGatewayResponse,
} from "@opencompany/agent-runtime";
import type { GoatBrainCaptureServiceDependencies } from "@opencompany/goat-agent/application/brain-capture";
import { executePersistedGoatBrainCapture } from "@opencompany/goat-agent/application/persisted-brain-capture";
import { createLogger } from "@opencompany/observability";
import { triggerGoatBrainIngestWake } from "@/lib/task-runner";

const logger = createLogger({
  service: "opencompany-goat",
  runtime: "codex-brain-capture",
});

export async function executeGoatCodexBrainCaptureGateway(input: {
  request: GoatCodexBrainCaptureGatewayRequest;
  dependencies?: Partial<GoatBrainCaptureServiceDependencies>;
}): Promise<GoatCodexBrainCaptureGatewayResponse> {
  return executePersistedGoatBrainCapture({
    request: input.request,
    dependencies: {
      wakeIngest: triggerGoatBrainIngestWake,
      ...(input.dependencies ? { service: input.dependencies } : {}),
      onError: (error, command) => {
        logger.error("Codex Brain capture failed", {
          event: "goat.codex_brain_capture_failed",
          codex_chat_session_id: command.sessionId,
          codex_chat_turn_id: command.runId,
          error: error instanceof Error ? error.message : "Unknown capture error.",
        });
      },
    },
  });
}

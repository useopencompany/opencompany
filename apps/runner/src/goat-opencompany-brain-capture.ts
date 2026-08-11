import type {
  GoatCodexBrainCaptureGatewayRequest,
  GoatCodexBrainCaptureGatewayResponse,
} from "@opencompany/agent-runtime";
import { executePersistedGoatBrainCapture } from "@opencompany/goat-agent/application/persisted-brain-capture";
import type { SaveToBrainToolInput, SaveToBrainToolOutput } from "@opencompany/goat-agent/chat-ui";
import { wakeGoatBrainIngestWorker } from "./goat-brain-ingest-worker";

type Context = {
  sessionId: string;
  turnId: string;
  signal: AbortSignal;
};

type Dependencies = {
  execute: (
    request: GoatCodexBrainCaptureGatewayRequest,
  ) => Promise<GoatCodexBrainCaptureGatewayResponse>;
};

const defaultDependencies: Dependencies = {
  execute: (request) =>
    executePersistedGoatBrainCapture({
      request,
      dependencies: { wakeIngest: async () => wakeGoatBrainIngestWorker() },
    }),
};

export function createGoatOpenCompanyBrainCaptureRunner(
  context: Context,
  dependencies: Partial<Dependencies> = {},
) {
  const resolvedDependencies = { ...defaultDependencies, ...dependencies };
  return async (input: SaveToBrainToolInput): Promise<SaveToBrainToolOutput> => {
    if (!input.content?.trim() && !input.sourceRef?.trim() && !input.attachmentIds?.length) {
      return {
        ok: false,
        error: "save_to_brain needs content, sourceRef, or attachmentIds.",
      };
    }

    const request: GoatCodexBrainCaptureGatewayRequest = {
      codexChatSessionId: context.sessionId,
      codexChatTurnId: context.turnId,
      ...(input.content?.trim() ? { content: input.content.trim() } : {}),
      ...(input.title?.trim() ? { title: input.title.trim() } : {}),
      ...(input.intent?.trim() ? { intent: input.intent.trim() } : {}),
      ...(input.sourceRef?.trim() ? { sourceRef: input.sourceRef.trim() } : {}),
      ...(input.integrationId?.trim() ? { integrationId: input.integrationId.trim() } : {}),
      ...(input.fallbackContent?.trim() ? { fallbackContent: input.fallbackContent.trim() } : {}),
      ...(input.attachmentIds?.length ? { attachmentIds: input.attachmentIds } : {}),
    };
    try {
      return await resolvedDependencies.execute(request);
    } catch (error) {
      if (context.signal.aborted) throw context.signal.reason ?? error;
      return { ok: false, error: "The Brain capture service could not complete the request." };
    }
  };
}

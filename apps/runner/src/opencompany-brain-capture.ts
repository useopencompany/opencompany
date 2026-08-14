import { executePersistedBrainCapture } from "@opencompany/agent/application/persisted-brain-capture";
import type { SaveToBrainToolInput, SaveToBrainToolOutput } from "@opencompany/agent/chat-ui";
import type {
  CodexBrainCaptureGatewayRequest,
  CodexBrainCaptureGatewayResponse,
} from "@opencompany/agent-runtime";
import { wakeBrainIngestWorker } from "./brain-ingest-worker";

type Context = {
  sessionId: string;
  turnId: string;
  signal: AbortSignal;
};

type Dependencies = {
  execute: (request: CodexBrainCaptureGatewayRequest) => Promise<CodexBrainCaptureGatewayResponse>;
};

const defaultDependencies: Dependencies = {
  execute: (request) =>
    executePersistedBrainCapture({
      request,
      dependencies: { wakeIngest: async () => wakeBrainIngestWorker() },
    }),
};

export function createBrainCaptureRunner(
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

    const request: CodexBrainCaptureGatewayRequest = {
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

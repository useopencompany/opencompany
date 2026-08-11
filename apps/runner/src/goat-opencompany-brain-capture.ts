import type {
  GoatCodexBrainCaptureGatewayRequest,
  GoatCodexBrainCaptureGatewayResponse,
} from "@opencompany/agent-runtime";
import type { SaveToBrainToolInput, SaveToBrainToolOutput } from "@opencompany/goat-agent/chat-ui";
import type { RunnerEnv } from "./env";

const GATEWAY_PATH = "/api/internal/codex-brain-capture";
const GATEWAY_TIMEOUT_MS = 30_000;

type Context = {
  sessionId: string;
  turnId: string;
  env: Pick<RunnerEnv, "goatAppUrl" | "internalToken">;
  signal: AbortSignal;
};

export function createGoatOpenCompanyBrainCaptureRunner(
  context: Context,
  dependencies: { fetch: typeof fetch } = { fetch: globalThis.fetch },
) {
  return async (input: SaveToBrainToolInput): Promise<SaveToBrainToolOutput> => {
    const appUrl = context.env.goatAppUrl?.trim();
    if (!appUrl) return { ok: false, error: "Brain capture is not configured." };
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
      const response = await dependencies.fetch(new URL(GATEWAY_PATH, appUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${context.env.internalToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(GATEWAY_TIMEOUT_MS)]),
      });
      return await readResponse(response);
    } catch (error) {
      if (context.signal.aborted) throw context.signal.reason ?? error;
      return { ok: false, error: "The Brain capture gateway could not be reached." };
    }
  };
}

async function readResponse(response: Response): Promise<GoatCodexBrainCaptureGatewayResponse> {
  try {
    const value = (await response.json()) as unknown;
    if (isRecord(value) && typeof value.ok === "boolean") {
      return value as GoatCodexBrainCaptureGatewayResponse;
    }
  } catch {
    // Avoid passing an HTML proxy response through the model-facing tool.
  }
  return { ok: false, error: `The Brain capture gateway returned HTTP ${response.status}.` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

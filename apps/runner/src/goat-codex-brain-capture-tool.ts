import {
  GOAT_CODEX_SAVE_TO_BRAIN_TOOL_NAME,
  type GoatCodexBrainCaptureGatewayRequest,
  type GoatCodexBrainCaptureGatewayResponse,
} from "@opencompany/agent-runtime";
import {
  SAVE_TO_BRAIN_FALLBACK_CONTENT_DESCRIPTION,
  SAVE_TO_BRAIN_INTEGRATION_ID_DESCRIPTION,
  SAVE_TO_BRAIN_INTENT_DESCRIPTION,
  SAVE_TO_BRAIN_SOURCE_REF_DESCRIPTION,
  SAVE_TO_BRAIN_TITLE_DESCRIPTION,
} from "@opencompany/goat-agent/prompts";
import type {
  CodexAppServerDynamicTool,
  CodexAppServerDynamicToolCall,
  CodexAppServerDynamicToolResponse,
} from "./codex-app-server";
import type { RunnerEnv } from "./env";

const GOAT_CODEX_BRAIN_CAPTURE_GATEWAY_PATH = "/api/internal/codex-brain-capture";
const GOAT_CODEX_BRAIN_CAPTURE_GATEWAY_TIMEOUT_MS = 30_000;

type GoatCodexBrainCaptureToolContext = {
  codexChatSessionId: string;
  codexChatTurnId: string;
  env: Pick<RunnerEnv, "goatAppUrl" | "internalToken">;
  checkAbort: () => Promise<void>;
};

type GoatCodexBrainCaptureToolDependencies = {
  fetch: typeof fetch;
};

const defaultDependencies: GoatCodexBrainCaptureToolDependencies = {
  fetch: globalThis.fetch,
};

export function createGoatCodexBrainCaptureDynamicTool(
  context: GoatCodexBrainCaptureToolContext,
  dependencies: Partial<GoatCodexBrainCaptureToolDependencies> = {},
): CodexAppServerDynamicTool {
  const resolvedDependencies = { ...defaultDependencies, ...dependencies };
  return {
    spec: {
      type: "function",
      name: GOAT_CODEX_SAVE_TO_BRAIN_TOOL_NAME,
      description:
        "Save something the user explicitly wants remembered into the Brain pinned to this Codex chat. It creates an inbox draft immediately and queues background curation. Preserve the user's content faithfully; never use this as a scratchpad or save without clear user intent.",
      inputSchema: {
        type: "object",
        properties: {
          content: {
            type: "string",
            maxLength: 64_000,
            description:
              "The content to save, verbatim or lightly cleaned. Preserve the user's wording, links, and details; do not summarize away specifics. Omit only when saving a bare hydratable integration source.",
          },
          title: {
            type: "string",
            maxLength: 200,
            description: SAVE_TO_BRAIN_TITLE_DESCRIPTION,
          },
          intent: {
            type: "string",
            maxLength: 1_000,
            description: SAVE_TO_BRAIN_INTENT_DESCRIPTION,
          },
          sourceRef: {
            type: "string",
            maxLength: 4_000,
            description: SAVE_TO_BRAIN_SOURCE_REF_DESCRIPTION,
          },
          integrationId: {
            type: "string",
            maxLength: 256,
            description: SAVE_TO_BRAIN_INTEGRATION_ID_DESCRIPTION,
          },
          fallbackContent: {
            type: "string",
            maxLength: 2_000,
            description: SAVE_TO_BRAIN_FALLBACK_CONTENT_DESCRIPTION,
          },
        },
        additionalProperties: false,
      },
    },
    execute: async (call) => {
      const parsed = captureRequest(context, call);
      if (!parsed.ok) return modelResponse(parsed.response);
      return executeGatewayCall({
        context,
        dependencies: resolvedDependencies,
        request: parsed.request,
      });
    },
  };
}

async function executeGatewayCall(input: {
  context: GoatCodexBrainCaptureToolContext;
  dependencies: GoatCodexBrainCaptureToolDependencies;
  request: GoatCodexBrainCaptureGatewayRequest;
}): Promise<CodexAppServerDynamicToolResponse> {
  const appUrl = input.context.env.goatAppUrl?.trim();
  if (!appUrl) {
    return modelResponse({
      ok: false,
      error: "Brain capture is not configured for this Codex runner.",
    });
  }

  try {
    await input.context.checkAbort();
    const response = await input.dependencies.fetch(
      new URL(GOAT_CODEX_BRAIN_CAPTURE_GATEWAY_PATH, appUrl),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.context.env.internalToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(input.request),
        signal: AbortSignal.timeout(GOAT_CODEX_BRAIN_CAPTURE_GATEWAY_TIMEOUT_MS),
      },
    );
    const result = await readGatewayResponse(response);
    await input.context.checkAbort();
    return modelResponse(result);
  } catch (error) {
    return modelResponse({
      ok: false,
      error:
        error instanceof Error
          ? `The Brain capture gateway could not be reached: ${error.message}`
          : "The Brain capture gateway could not be reached.",
    });
  }
}

function captureRequest(
  context: GoatCodexBrainCaptureToolContext,
  call: CodexAppServerDynamicToolCall,
):
  | { ok: true; request: GoatCodexBrainCaptureGatewayRequest }
  | { ok: false; response: GoatCodexBrainCaptureGatewayResponse } {
  if (!isRecord(call.arguments)) {
    return invalidParams("save_to_brain expects an object.");
  }

  const content = optionalBoundedString(call.arguments.content, 64_000);
  const sourceRef = optionalBoundedString(call.arguments.sourceRef, 4_000);
  for (const [field, maxLength] of [
    ["content", 64_000],
    ["sourceRef", 4_000],
  ] as const) {
    if (!isValidOptionalString(call.arguments[field], maxLength)) {
      return invalidParams(
        `${field} must be a non-empty string no longer than ${maxLength} characters.`,
      );
    }
  }
  if (!content && !sourceRef) {
    return invalidParams("save_to_brain needs content or sourceRef.");
  }
  const optionalFields = [
    ["title", 200],
    ["intent", 1_000],
    ["integrationId", 256],
    ["fallbackContent", 2_000],
  ] as const;
  for (const [field, maxLength] of optionalFields) {
    if (!isValidOptionalString(call.arguments[field], maxLength)) {
      return invalidParams(
        `${field} must be a non-empty string no longer than ${maxLength} characters.`,
      );
    }
  }

  const title = optionalBoundedString(call.arguments.title, 200);
  const intent = optionalBoundedString(call.arguments.intent, 1_000);
  const integrationId = optionalBoundedString(call.arguments.integrationId, 256);
  const fallbackContent = optionalBoundedString(call.arguments.fallbackContent, 2_000);
  return {
    ok: true,
    request: {
      codexChatSessionId: context.codexChatSessionId,
      codexChatTurnId: context.codexChatTurnId,
      ...(content ? { content } : {}),
      ...(title ? { title } : {}),
      ...(intent ? { intent } : {}),
      ...(sourceRef ? { sourceRef } : {}),
      ...(integrationId ? { integrationId } : {}),
      ...(fallbackContent ? { fallbackContent } : {}),
    },
  };
}

async function readGatewayResponse(
  response: Response,
): Promise<GoatCodexBrainCaptureGatewayResponse> {
  try {
    const value = (await response.json()) as unknown;
    if (isGatewayResponse(value)) return value;
  } catch {
    // Fall through to a bounded status-only error; never send an HTML proxy body to the model.
  }
  return {
    ok: false,
    error: `The Brain capture gateway returned HTTP ${response.status}.`,
  };
}

function isGatewayResponse(value: unknown): value is GoatCodexBrainCaptureGatewayResponse {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false;
  if (!value.ok) return typeof value.error === "string";
  return (
    (value.status === "captured" ||
      value.status === "already_captured" ||
      value.status === "paused_by_plan") &&
    typeof value.draftId === "string" &&
    typeof value.path === "string" &&
    typeof value.title === "string" &&
    (value.message === undefined || typeof value.message === "string")
  );
}

function invalidParams(message: string): {
  ok: false;
  response: GoatCodexBrainCaptureGatewayResponse;
} {
  return { ok: false, response: { ok: false, error: message } };
}

function modelResponse(
  response: GoatCodexBrainCaptureGatewayResponse,
): CodexAppServerDynamicToolResponse {
  return {
    success: response.ok,
    contentItems: [{ type: "inputText", text: JSON.stringify(response) }],
  };
}

function optionalBoundedString(value: unknown, maxLength: number) {
  return typeof value === "string" && value.trim() && value.trim().length <= maxLength
    ? value.trim()
    : null;
}

function isValidOptionalString(value: unknown, maxLength: number) {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim().length <= maxLength)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

import { executePersistedBrainCapture } from "@opencompany/agent/application/persisted-brain-capture";
import {
  SAVE_TO_BRAIN_FALLBACK_CONTENT_DESCRIPTION,
  SAVE_TO_BRAIN_INTEGRATION_ID_DESCRIPTION,
  SAVE_TO_BRAIN_INTENT_DESCRIPTION,
  SAVE_TO_BRAIN_SOURCE_REF_DESCRIPTION,
  SAVE_TO_BRAIN_TITLE_DESCRIPTION,
} from "@opencompany/agent/prompts";
import {
  CODEX_SAVE_TO_BRAIN_TOOL_NAME,
  type CodexBrainCaptureGatewayRequest,
  type CodexBrainCaptureGatewayResponse,
} from "@opencompany/agent-runtime";
import { wakeBrainIngestWorker } from "./brain-ingest-worker";
import type {
  CodexAppServerDynamicTool,
  CodexAppServerDynamicToolCall,
  CodexAppServerDynamicToolResponse,
} from "./codex-app-server";

type CodexBrainCaptureToolContext = {
  codexChatSessionId: string;
  codexChatTurnId: string;
  checkAbort: () => Promise<void>;
};

type CodexBrainCaptureToolDependencies = {
  execute: (request: CodexBrainCaptureGatewayRequest) => Promise<CodexBrainCaptureGatewayResponse>;
};

const defaultDependencies: CodexBrainCaptureToolDependencies = {
  execute: (request) =>
    executePersistedBrainCapture({
      request,
      dependencies: { wakeIngest: async () => wakeBrainIngestWorker() },
    }),
};

export function createCodexBrainCaptureDynamicTool(
  context: CodexBrainCaptureToolContext,
  dependencies: Partial<CodexBrainCaptureToolDependencies> = {},
): CodexAppServerDynamicTool {
  const resolvedDependencies = { ...defaultDependencies, ...dependencies };
  return {
    spec: {
      type: "function",
      name: CODEX_SAVE_TO_BRAIN_TOOL_NAME,
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
  context: CodexBrainCaptureToolContext;
  dependencies: CodexBrainCaptureToolDependencies;
  request: CodexBrainCaptureGatewayRequest;
}): Promise<CodexAppServerDynamicToolResponse> {
  try {
    await input.context.checkAbort();
    const result = await input.dependencies.execute(input.request);
    await input.context.checkAbort();
    return modelResponse(result);
  } catch (error) {
    return modelResponse({
      ok: false,
      error:
        error instanceof Error
          ? `The Brain capture service failed: ${error.message}`
          : "The Brain capture service failed.",
    });
  }
}

function captureRequest(
  context: CodexBrainCaptureToolContext,
  call: CodexAppServerDynamicToolCall,
):
  | { ok: true; request: CodexBrainCaptureGatewayRequest }
  | { ok: false; response: CodexBrainCaptureGatewayResponse } {
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

function invalidParams(message: string): {
  ok: false;
  response: CodexBrainCaptureGatewayResponse;
} {
  return { ok: false, response: { ok: false, error: message } };
}

function modelResponse(
  response: CodexBrainCaptureGatewayResponse,
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

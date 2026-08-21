import {
  type ActionApprovalView,
  ActionAuthError,
  type ActionErrorCode,
  ActionExecutionError,
  ActionInvalidParamsError,
  ActionPermissionError,
  type ActionSourceId,
  type CapabilityTurnState,
  type ResolvedActionCatalog,
} from "./types";

export const ACTION_TIMEOUT_MS = 20_000;
export const MAX_ACTION_RESULT_CHARS = 16_000;
export const MAX_EXPANDED_ACTION_RESULT_CHARS = 256_000;

export type ActionResult =
  | { ok: true; action: string; result: unknown }
  | {
      ok: false;
      action: string;
      error: {
        code: ActionErrorCode;
        source?: ActionSourceId;
        message: string;
        approval?: ActionApprovalView;
      };
    };

export async function executeAction(input: {
  catalog: ResolvedActionCatalog;
  actionId: string;
  params: Record<string, unknown>;
  userWorkosId: string;
  workspaceId?: string;
  chatSessionId?: string;
  toolCallId?: string;
  sourceTurnId?: string;
  sourceMessageId?: string;
  sourceEngine?: import("@opencompany/db/product-schema").CodexChatEngine;
  capabilityTurnState?: CapabilityTurnState;
  signal: AbortSignal;
  currentDate: Date;
  userTimezone: string;
}): Promise<ActionResult> {
  const action = input.catalog.actions.find((entry) => entry.id === input.actionId);
  if (!action) {
    return {
      ok: false,
      action: input.actionId,
      error: {
        code: "invalid_params",
        message: `"${input.actionId}" is not an available action. Call list_actions with the relevant source id for the current catalog.`,
      },
    };
  }

  const timeoutMs = action.timeoutMs ?? ACTION_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([input.signal, timeoutSignal]);

  try {
    const result = await action.execute(input.params, {
      userWorkosId: input.userWorkosId,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.chatSessionId ? { chatSessionId: input.chatSessionId } : {}),
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
      ...(input.sourceTurnId ? { sourceTurnId: input.sourceTurnId } : {}),
      ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
      ...(input.sourceEngine ? { sourceEngine: input.sourceEngine } : {}),
      capabilityTurnState: input.capabilityTurnState ?? {
        quotedTotalUsdMicros: 0,
        admittedToolCallIds: [],
        quotesByToolCallId: new Map(),
        asyncRunsStarted: 0,
      },
      signal,
      currentDate: input.currentDate,
      userTimezone: input.userTimezone,
    });
    return {
      ok: true,
      action: action.id,
      result: clampActionResult(result, action.maxResultChars),
    };
  } catch (error) {
    // A parent-chat abort is not an action failure; let the turn's own
    // cancellation handling deal with it.
    if (input.signal.aborted) throw error;
    if (error instanceof ActionAuthError) {
      return {
        ok: false,
        action: action.id,
        error: { code: error.code, source: error.provider, message: error.message },
      };
    }
    if (error instanceof ActionExecutionError) {
      return {
        ok: false,
        action: action.id,
        error: {
          code: error.code,
          source: action.provider,
          message: error.message,
        },
      };
    }
    if (error instanceof ActionPermissionError) {
      return {
        ok: false,
        action: action.id,
        error: { code: "not_permitted", source: error.provider, message: error.message },
      };
    }
    if (error instanceof ActionInvalidParamsError) {
      return {
        ok: false,
        action: action.id,
        error: {
          code: "invalid_params",
          source: action.provider,
          message: `${error.message} Check the action's params schema from list_actions for ${action.provider}.`,
        },
      };
    }
    if (timeoutSignal.aborted) {
      return {
        ok: false,
        action: action.id,
        error: {
          code: "timeout",
          source: action.provider,
          message: `The action did not finish within ${timeoutMs / 1000}s. Narrow the request and try once more.`,
        },
      };
    }
    return {
      ok: false,
      action: action.id,
      error: {
        code: "provider_error",
        source: action.provider,
        message: error instanceof Error ? error.message : "The provider call failed.",
      },
    };
  }
}

// Providers already shape and truncate their payloads; this is the guard rail
// that keeps a pathological response from flooding the chat context.
export function clampActionResult(value: unknown, requestedMaxChars?: number): unknown {
  const maxChars =
    typeof requestedMaxChars === "number" &&
    Number.isInteger(requestedMaxChars) &&
    requestedMaxChars > 0
      ? Math.max(
          MAX_ACTION_RESULT_CHARS,
          Math.min(requestedMaxChars, MAX_EXPANDED_ACTION_RESULT_CHARS),
        )
      : MAX_ACTION_RESULT_CHARS;
  let json: string;
  try {
    json = JSON.stringify(value) ?? "null";
  } catch {
    return fitActionPreview(String(value), maxChars, (resultPreview) => ({
      truncated: true,
      note: "Result was not serializable.",
      resultPreview,
    }));
  }
  if (json.length <= maxChars) return value;
  const note = "Result truncated; narrow the request (smaller limit, tighter query).";
  if (isRecord(value) && value.untrustedProviderData === true) {
    const payloadJson = JSON.stringify(value.payload) ?? "null";
    return fitActionPreview(payloadJson, maxChars, (resultPreview) => ({
      ...value,
      canonicalLinks: Array.isArray(value.canonicalLinks) ? value.canonicalLinks.slice(0, 5) : [],
      payload: {
        truncated: true,
        note,
        resultPreview,
      },
    }));
  }
  return fitActionPreview(json, maxChars, (resultPreview) => ({
    truncated: true,
    note,
    resultPreview,
  }));
}

function fitActionPreview(
  source: string,
  maxChars: number,
  create: (preview: string) => Record<string, unknown>,
) {
  let low = 0;
  let high = source.length;
  let best = create("");
  while (low <= high) {
    const length = Math.floor((low + high) / 2);
    const candidate = create(source.slice(0, length));
    const serialized = JSON.stringify(candidate);
    if (serialized.length <= maxChars) {
      best = candidate;
      low = length + 1;
    } else {
      high = length - 1;
    }
  }
  return best;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

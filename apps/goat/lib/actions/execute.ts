import {
  GoatActionAuthError,
  type GoatActionErrorCode,
  GoatActionInvalidParamsError,
  type GoatActionProviderId,
  type GoatResolvedActionCatalog,
} from "@/lib/actions/types";

export const GOAT_ACTION_TIMEOUT_MS = 20_000;
export const MAX_ACTION_RESULT_CHARS = 16_000;

export type GoatActionResult =
  | { ok: true; action: string; result: unknown }
  | {
      ok: false;
      action: string;
      error: { code: GoatActionErrorCode; provider?: GoatActionProviderId; message: string };
    };

export async function executeGoatAction(input: {
  catalog: GoatResolvedActionCatalog;
  actionId: string;
  params: Record<string, unknown>;
  userWorkosId: string;
  signal: AbortSignal;
  currentDate: Date;
}): Promise<GoatActionResult> {
  const action = input.catalog.actions.find((entry) => entry.id === input.actionId);
  if (!action) {
    return {
      ok: false,
      action: input.actionId,
      error: {
        code: "invalid_params",
        message: `"${input.actionId}" is not an available action. Call list_actions with the relevant integration id for the current catalog.`,
      },
    };
  }

  const timeoutSignal = AbortSignal.timeout(GOAT_ACTION_TIMEOUT_MS);
  const signal = AbortSignal.any([input.signal, timeoutSignal]);

  try {
    const result = await action.execute(input.params, {
      userWorkosId: input.userWorkosId,
      signal,
      currentDate: input.currentDate,
    });
    return { ok: true, action: action.id, result: clampActionResult(result) };
  } catch (error) {
    // A parent-chat abort is not an action failure; let the turn's own
    // cancellation handling deal with it.
    if (input.signal.aborted) throw error;
    if (error instanceof GoatActionAuthError) {
      return {
        ok: false,
        action: action.id,
        error: { code: error.code, provider: error.provider, message: error.message },
      };
    }
    if (error instanceof GoatActionInvalidParamsError) {
      return {
        ok: false,
        action: action.id,
        error: {
          code: "invalid_params",
          provider: action.provider,
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
          provider: action.provider,
          message: `The action did not finish within ${GOAT_ACTION_TIMEOUT_MS / 1000}s. Narrow the request and try once more.`,
        },
      };
    }
    return {
      ok: false,
      action: action.id,
      error: {
        code: "provider_error",
        provider: action.provider,
        message: error instanceof Error ? error.message : "The provider call failed.",
      },
    };
  }
}

// Providers already shape and truncate their payloads; this is the guard rail
// that keeps a pathological response from flooding the chat context.
export function clampActionResult(value: unknown): unknown {
  let json: string;
  try {
    json = JSON.stringify(value) ?? "null";
  } catch {
    return { truncated: true, note: "Result was not serializable.", resultPreview: String(value) };
  }
  if (json.length <= MAX_ACTION_RESULT_CHARS) return value;
  return {
    truncated: true,
    note: "Result truncated; narrow the request (smaller limit, tighter query).",
    resultPreview: json.slice(0, MAX_ACTION_RESULT_CHARS),
  };
}

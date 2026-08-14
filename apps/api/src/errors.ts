import type { ErrorEnvelope } from "@opencompany/protocol";
import { PROTOCOL_VERSION } from "@opencompany/protocol";

export type ApiErrorCode = ErrorEnvelope["error"]["code"];

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly retryable = false,
    readonly responseHeaders?: Readonly<Record<string, string>>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function errorResponse(error: unknown, requestId: string): Response {
  const apiError = normalizeApiError(error);
  const envelope = {
    error: {
      code: apiError.code,
      message: apiError.message,
      requestId,
      retryable: apiError.retryable,
    },
    meta: { apiVersion: "v1", protocolVersion: PROTOCOL_VERSION },
  } satisfies ErrorEnvelope;
  // `new Response(...)` instead of `Response.json(...)`: the Node server
  // adapter replaces global Response with a lightweight subclass at serve()
  // time, but the native Response.json factory keeps returning base-class
  // instances. Those fail the `instanceof Response` check inside the zod
  // validator hooks, which then silently discard this envelope and emit the
  // raw zod error instead. The constructor always uses the current global
  // class, so the envelope survives under the patched adapter.
  return new Response(JSON.stringify(envelope), {
    status: apiError.status,
    headers: {
      "content-type": "application/json",
      ...(apiError.responseHeaders ?? {}),
    },
  });
}

function normalizeApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (isCoreError(error)) {
    switch (error.code) {
      case "forbidden":
        return new ApiError(403, "forbidden", error.message);
      case "invalid_argument":
        return new ApiError(400, "invalid_request", error.message);
      case "not_found":
        return new ApiError(404, "not_found", error.message);
      case "conflict":
        return new ApiError(409, "conflict", error.message);
      case "idempotency_conflict":
        return new ApiError(409, "idempotency_conflict", error.message);
      case "unavailable":
        return new ApiError(503, "unavailable", error.message, true);
    }
  }
  return new ApiError(500, "internal_error", "An internal error occurred.", true);
}

function isCoreError(error: unknown): error is Error & {
  code:
    | "forbidden"
    | "invalid_argument"
    | "not_found"
    | "conflict"
    | "idempotency_conflict"
    | "unavailable";
} {
  if (!(error instanceof Error) || !("code" in error)) return false;
  return [
    "forbidden",
    "invalid_argument",
    "not_found",
    "conflict",
    "idempotency_conflict",
    "unavailable",
  ].includes(String(error.code));
}

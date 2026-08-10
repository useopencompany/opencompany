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
  return Response.json(
    {
      error: {
        code: apiError.code,
        message: apiError.message,
        requestId,
        retryable: apiError.retryable,
      },
      meta: { apiVersion: "v1", protocolVersion: PROTOCOL_VERSION },
    } satisfies ErrorEnvelope,
    {
      status: apiError.status,
      ...(apiError.responseHeaders ? { headers: apiError.responseHeaders } : {}),
    },
  );
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
      case "idempotency_conflict":
        return new ApiError(409, "idempotency_conflict", error.message);
    }
  }
  return new ApiError(500, "internal_error", "An internal error occurred.", true);
}

function isCoreError(error: unknown): error is Error & {
  code: "forbidden" | "invalid_argument" | "not_found" | "idempotency_conflict";
} {
  if (!(error instanceof Error) || !("code" in error)) return false;
  return ["forbidden", "invalid_argument", "not_found", "idempotency_conflict"].includes(
    String(error.code),
  );
}

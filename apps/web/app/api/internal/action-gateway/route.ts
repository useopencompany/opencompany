import { createHash, timingSafeEqual } from "node:crypto";
import type {
  GoatActionGatewayRequest,
  GoatActionGatewayResponse,
} from "@opencompany/agent-runtime";
import { NextResponse } from "next/server";
import { executeGoatActionGateway } from "@/lib/codex-actions";

export const runtime = "nodejs";
export const maxDuration = 150;

export async function POST(request: Request) {
  const internalToken = process.env.RUNNER_INTERNAL_TOKEN?.trim();
  if (!internalToken) {
    return jsonError(503, "not_configured", "The action gateway is not configured.");
  }
  if (!validBearerToken(request.headers.get("authorization"), internalToken)) {
    return jsonError(401, "not_permitted", "Unauthorized.");
  }

  const parsed = await parseRequest(request);
  if (!parsed.ok) return jsonError(400, "invalid_params", parsed.error);

  const response = await executeGoatActionGateway({
    request: parsed.value,
    signal: request.signal,
  });
  return NextResponse.json(response);
}

function validBearerToken(authorization: string | null, expectedToken: string) {
  const candidate = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  const expectedHash = createHash("sha256").update(expectedToken).digest();
  const candidateHash = createHash("sha256").update(candidate).digest();
  return timingSafeEqual(candidateHash, expectedHash);
}

async function parseRequest(
  request: Request,
): Promise<{ ok: true; value: GoatActionGatewayRequest } | { ok: false; error: string }> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return { ok: false, error: "Invalid JSON body." };
  }
  if (!isRecord(value)) return { ok: false, error: "Invalid action gateway request." };

  const sessionId = requiredString(value.sessionId);
  const turnId = requiredString(value.turnId);
  if (!sessionId || !turnId) {
    return { ok: false, error: "sessionId and turnId are required." };
  }

  if (value.operation === "list") {
    const source = optionalString(value.source);
    if (value.source !== undefined && !source) {
      return { ok: false, error: "source must be a non-empty string when provided." };
    }
    return {
      ok: true,
      value: {
        operation: "list",
        sessionId,
        turnId,
        ...(source ? { source } : {}),
      },
    };
  }

  if (value.operation === "execute") {
    const action = requiredString(value.action);
    const invocationId = requiredString(value.invocationId);
    if (!action || !invocationId || !isRecord(value.params)) {
      return {
        ok: false,
        error: "action, params, and invocationId are required for execution.",
      };
    }
    return {
      ok: true,
      value: {
        operation: "execute",
        sessionId,
        turnId,
        action,
        params: value.params,
        invocationId,
      },
    };
  }

  return { ok: false, error: 'operation must be "list" or "execute".' };
}

function jsonError(status: number, code: string, message: string) {
  const body: GoatActionGatewayResponse = { ok: false, error: { code, message } };
  return NextResponse.json(body, { status });
}

function requiredString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalString(value: unknown) {
  if (value === undefined || value === null) return null;
  return requiredString(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

import { createHash, timingSafeEqual } from "node:crypto";
import type {
  CodexBrainCaptureGatewayRequest,
  CodexBrainCaptureGatewayResponse,
} from "@opencompany/agent-runtime";
import { NextResponse } from "next/server";
import { executeCodexBrainCaptureGateway } from "@/lib/codex-brain-capture";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const internalToken = process.env.RUNNER_INTERNAL_TOKEN?.trim();
  if (!internalToken) {
    return jsonError(503, "The Codex Brain capture gateway is not configured.");
  }
  if (!validBearerToken(request.headers.get("authorization"), internalToken)) {
    return jsonError(401, "Unauthorized.");
  }

  const parsed = await parseRequest(request);
  if (!parsed.ok) return jsonError(400, parsed.error);

  const response = await executeCodexBrainCaptureGateway({
    request: parsed.value,
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
): Promise<{ ok: true; value: CodexBrainCaptureGatewayRequest } | { ok: false; error: string }> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return { ok: false, error: "Invalid JSON body." };
  }
  if (!isRecord(value)) return { ok: false, error: "Invalid Codex Brain capture request." };

  const codexChatSessionId = boundedString(value.codexChatSessionId, 256);
  const codexChatTurnId = boundedString(value.codexChatTurnId, 256);
  if (!codexChatSessionId || !codexChatTurnId) {
    return {
      ok: false,
      error: "codexChatSessionId and codexChatTurnId are required.",
    };
  }

  const content = boundedString(value.content, 64_000);
  const sourceRef = boundedString(value.sourceRef, 4_000);
  for (const [field, maxLength] of [
    ["content", 64_000],
    ["sourceRef", 4_000],
  ] as const) {
    if (!isValidOptionalString(value[field], maxLength)) {
      return {
        ok: false,
        error: `${field} must be a non-empty string no longer than ${maxLength} characters.`,
      };
    }
  }
  if (!content && !sourceRef) {
    return { ok: false, error: "content or sourceRef is required." };
  }
  const optionalFields = [
    ["title", 200],
    ["intent", 1_000],
    ["integrationId", 256],
    ["fallbackContent", 2_000],
  ] as const;
  for (const [field, maxLength] of optionalFields) {
    if (!isValidOptionalString(value[field], maxLength)) {
      return {
        ok: false,
        error: `${field} must be a non-empty string no longer than ${maxLength} characters.`,
      };
    }
  }
  const title = boundedString(value.title, 200);
  const intent = boundedString(value.intent, 1_000);
  const integrationId = boundedString(value.integrationId, 256);
  const fallbackContent = boundedString(value.fallbackContent, 2_000);

  return {
    ok: true,
    value: {
      codexChatSessionId,
      codexChatTurnId,
      ...(content ? { content } : {}),
      ...(title ? { title } : {}),
      ...(intent ? { intent } : {}),
      ...(sourceRef ? { sourceRef } : {}),
      ...(integrationId ? { integrationId } : {}),
      ...(fallbackContent ? { fallbackContent } : {}),
    },
  };
}

function jsonError(status: number, error: string) {
  const body: CodexBrainCaptureGatewayResponse = { ok: false, error };
  return NextResponse.json(body, { status });
}

function boundedString(value: unknown, maxLength: number) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : null;
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

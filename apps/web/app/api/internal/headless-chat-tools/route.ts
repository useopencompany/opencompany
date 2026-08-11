import { createHash, timingSafeEqual } from "node:crypto";
import type {
  GoatChatHostToolGatewayRequest,
  GoatChatHostToolGatewayResponse,
  GoatChatHostToolOperation,
} from "@opencompany/agent-runtime";
import { NextResponse } from "next/server";
import { executeHeadlessChatHostToolGateway } from "@/lib/headless-chat-host-tools";

export const runtime = "nodejs";
export const maxDuration = 150;

const OPERATIONS = new Set<GoatChatHostToolOperation>([
  "bootstrap",
  "use_skill",
  "start_task",
  "schedule_task",
  "edit_task_schedule",
  "delete_task_schedule",
  "start_workflow",
  "browser_use_profile",
  "browser_end_profile",
  "browser",
  "wiki",
]);

export async function POST(request: Request) {
  const internalToken = process.env.RUNNER_INTERNAL_TOKEN?.trim();
  if (!internalToken) return jsonError(503, "The Chat host-tool gateway is not configured.");
  if (!validBearerToken(request.headers.get("authorization"), internalToken)) {
    return jsonError(401, "Unauthorized.");
  }
  const parsed = await parseRequest(request);
  if (!parsed.ok) return jsonError(400, parsed.error);
  return NextResponse.json(
    await executeHeadlessChatHostToolGateway({ request: parsed.value, signal: request.signal }),
  );
}

async function parseRequest(
  request: Request,
): Promise<{ ok: true; value: GoatChatHostToolGatewayRequest } | { ok: false; error: string }> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return { ok: false, error: "Invalid JSON body." };
  }
  if (!isRecord(value)) return { ok: false, error: "Invalid Chat host-tool request." };
  const sessionId = boundedString(value.sessionId, 256);
  const turnId = boundedString(value.turnId, 256);
  if (!sessionId || !turnId) return { ok: false, error: "sessionId and turnId are required." };
  if (typeof value.operation !== "string" || !OPERATIONS.has(value.operation as never)) {
    return { ok: false, error: "Unknown Chat host-tool operation." };
  }
  if (value.input !== undefined && !isRecord(value.input)) {
    return { ok: false, error: "input must be an object when provided." };
  }
  const serializedInput = value.input === undefined ? "" : JSON.stringify(value.input);
  if (serializedInput.length > 100_000) return { ok: false, error: "input is too large." };
  return {
    ok: true,
    value: {
      operation: value.operation as GoatChatHostToolOperation,
      sessionId,
      turnId,
      ...(value.input ? { input: value.input } : {}),
    },
  };
}

function validBearerToken(authorization: string | null, expectedToken: string) {
  const candidate = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  const expectedHash = createHash("sha256").update(expectedToken).digest();
  const candidateHash = createHash("sha256").update(candidate).digest();
  return timingSafeEqual(candidateHash, expectedHash);
}

function boundedString(value: unknown, maxLength: number) {
  return typeof value === "string" && value.trim() && value.trim().length <= maxLength
    ? value.trim()
    : null;
}

function jsonError(status: number, error: string) {
  const body: GoatChatHostToolGatewayResponse = { ok: false, error };
  return NextResponse.json(body, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

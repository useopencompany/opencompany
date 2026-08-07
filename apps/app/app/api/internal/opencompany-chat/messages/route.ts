import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createCodexChatMessage } from "@/lib/codex-chat";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const internalToken = process.env.RUNNER_INTERNAL_TOKEN?.trim();
  if (!internalToken) {
    return jsonError(503, "The durable OpenCompany chat endpoint is not configured.");
  }
  if (!validBearerToken(request.headers.get("authorization"), internalToken)) {
    return jsonError(401, "Unauthorized.");
  }

  const parsed = await parseRequest(request);
  if (!parsed.ok) return jsonError(400, parsed.error);

  const result = await createCodexChatMessage({
    ...parsed.value,
    engine: "opencompany",
  });
  return NextResponse.json(result, { status: result.ok ? 202 : result.status });
}

function validBearerToken(authorization: string | null, expectedToken: string) {
  const candidate = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  const expectedHash = createHash("sha256").update(expectedToken).digest();
  const candidateHash = createHash("sha256").update(candidate).digest();
  return timingSafeEqual(candidateHash, expectedHash);
}

async function parseRequest(request: Request): Promise<
  | {
      ok: true;
      value: {
        userWorkosId: string;
        workspaceId: string;
        prompt: string;
        brainRef?: string | null;
        sessionId?: string | null;
        newSessionId?: string | null;
        clientMessageId?: string | null;
        model?: string;
      };
    }
  | { ok: false; error: string }
> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return { ok: false, error: "Invalid JSON body." };
  }
  if (!isRecord(value)) {
    return { ok: false, error: "Invalid durable OpenCompany chat request." };
  }

  const userWorkosId = boundedString(value.userWorkosId, 256);
  const workspaceId = boundedString(value.workspaceId, 256);
  const prompt = boundedString(value.prompt, 10_000);
  if (!userWorkosId || !workspaceId || !prompt) {
    return {
      ok: false,
      error: "userWorkosId, workspaceId, and prompt are required.",
    };
  }

  const optionalFields = [
    ["brainRef", 256],
    ["sessionId", 256],
    ["newSessionId", 256],
    ["clientMessageId", 160],
    ["model", 256],
  ] as const;
  for (const [field, maxLength] of optionalFields) {
    if (!isValidOptionalString(value[field], maxLength)) {
      return {
        ok: false,
        error: `${field} must be a non-empty string no longer than ${maxLength} characters.`,
      };
    }
  }

  const brainRef = boundedString(value.brainRef, 256);
  const sessionId = boundedString(value.sessionId, 256);
  const newSessionId = boundedString(value.newSessionId, 256);
  const clientMessageId = boundedString(value.clientMessageId, 160);
  const model = boundedString(value.model, 256);
  if (sessionId && newSessionId) {
    return { ok: false, error: "sessionId and newSessionId cannot both be provided." };
  }

  return {
    ok: true,
    value: {
      userWorkosId,
      workspaceId,
      prompt,
      ...(brainRef ? { brainRef } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(newSessionId ? { newSessionId } : {}),
      ...(clientMessageId ? { clientMessageId } : {}),
      ...(model ? { model } : {}),
    },
  };
}

function jsonError(status: number, error: string) {
  return NextResponse.json({ ok: false, error }, { status });
}

function boundedString(value: unknown, maxLength: number) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : null;
}

function isValidOptionalString(value: unknown, maxLength: number) {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim().length > 0 && value.trim().length <= maxLength)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

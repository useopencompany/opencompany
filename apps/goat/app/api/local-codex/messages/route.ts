import { NextResponse } from "next/server";
import { currentGoatUser } from "@/lib/auth";
import { type GoatChatUiMessage, textFromGoatChatUiMessage } from "@/lib/chat-ui";
import { goatFeatureFlagsFromUser, LOCAL_CODEX_BETA_DISABLED_MESSAGE } from "@/lib/feature-flags";
import { createOrSteerLocalCodexMessage } from "@/lib/local-codex";

export const runtime = "nodejs";

type LocalCodexMessageBody = {
  sessionId?: unknown;
  prompt?: unknown;
  message?: unknown;
};

export async function POST(request: Request) {
  const context = await currentGoatUser({ optional: true });
  if (!context) return new Response("Unauthorized", { status: 401 });
  if (!goatFeatureFlagsFromUser(context.user).localCodexBridge) {
    return new Response(LOCAL_CODEX_BETA_DISABLED_MESSAGE, { status: 403 });
  }

  const body = await readJsonBody<LocalCodexMessageBody>(request);
  if (!body.ok) return new Response(body.error, { status: 400 });

  const prompt = readPrompt(body.value);
  if (!prompt) return new Response("Invalid local Codex message.", { status: 400 });

  const sessionId = typeof body.value.sessionId === "string" ? body.value.sessionId.trim() : null;
  const clientMessageId =
    isUiMessage(body.value.message) && typeof body.value.message.id === "string"
      ? body.value.message.id
      : null;

  const result = await createOrSteerLocalCodexMessage({
    userWorkosId: context.user.workosUserId,
    ...(sessionId ? { sessionId } : {}),
    prompt,
    ...(clientMessageId ? { clientMessageId } : {}),
  });
  if (!result.ok) return new Response(result.error, { status: result.status });

  return NextResponse.json(result, { status: 202 });
}

function readPrompt(body: LocalCodexMessageBody) {
  if (typeof body.prompt === "string") return body.prompt.trim();
  if (!isUiMessage(body.message)) return "";
  return textFromGoatChatUiMessage(body.message);
}

function isUiMessage(value: unknown): value is GoatChatUiMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as { role?: unknown; parts?: unknown };
  return message.role === "user" && Array.isArray(message.parts);
}

async function readJsonBody<T>(request: Request) {
  try {
    return { ok: true as const, value: (await request.json()) as T };
  } catch {
    return { ok: false as const, error: "Invalid JSON body." };
  }
}

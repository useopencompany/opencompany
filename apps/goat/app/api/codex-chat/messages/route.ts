import { NextResponse } from "next/server";
import { currentGoatUser } from "@/lib/auth";
import { type GoatChatUiMessage, textFromGoatChatUiMessage } from "@/lib/chat-ui";
import { createGoatCodexChatMessage } from "@/lib/codex-chat";

export const runtime = "nodejs";

type CodexChatMessageBody = {
  sessionId?: unknown;
  prompt?: unknown;
  message?: unknown;
};

export async function POST(request: Request) {
  const context = await currentGoatUser({ optional: true });
  if (!context) return new Response("Unauthorized", { status: 401 });

  const body = await readJsonBody<CodexChatMessageBody>(request);
  if (!body.ok) return new Response(body.error, { status: 400 });

  const prompt = readPrompt(body.value);
  if (!prompt) return new Response("Invalid Codex chat message.", { status: 400 });

  const sessionId = typeof body.value.sessionId === "string" ? body.value.sessionId.trim() : null;
  const clientMessageId =
    isUiMessage(body.value.message) && typeof body.value.message.id === "string"
      ? body.value.message.id
      : null;

  const result = await createGoatCodexChatMessage({
    userWorkosId: context.user.workosUserId,
    ...(sessionId ? { sessionId } : {}),
    prompt,
    ...(clientMessageId ? { clientMessageId } : {}),
  });
  if (!result.ok) return new Response(result.error, { status: result.status });

  return NextResponse.json(result, { status: 202 });
}

function readPrompt(body: CodexChatMessageBody) {
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

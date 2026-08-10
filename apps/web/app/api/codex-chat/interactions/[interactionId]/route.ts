import { NextResponse } from "next/server";
import { currentGoatUser } from "@/lib/auth";
import { resolveGoatCodexChatInteraction } from "@/lib/codex-chat-interactions";

export const runtime = "nodejs";

type InteractionResponseBody = {
  answers?: unknown;
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ interactionId: string }> },
) {
  const context = await currentGoatUser({ optional: true });
  if (!context) return new Response("Unauthorized", { status: 401 });

  const body = await readJsonBody<InteractionResponseBody>(request);
  if (!body.ok) return new Response(body.error, { status: 400 });
  const { interactionId } = await params;
  if (!/^goat_codex_chat_interaction_[0-9a-f-]{36}$/.test(interactionId)) {
    return new Response("Codex question not found.", { status: 404 });
  }
  const result = await resolveGoatCodexChatInteraction({
    userWorkosId: context.user.workosUserId,
    interactionId,
    answers: body.value.answers,
  });
  if (!result.ok) return new Response(result.error, { status: result.status });

  return NextResponse.json({ ok: true }, { status: 202 });
}

async function readJsonBody<T>(request: Request) {
  try {
    return { ok: true as const, value: (await request.json()) as T };
  } catch {
    return { ok: false as const, error: "Invalid JSON body." };
  }
}

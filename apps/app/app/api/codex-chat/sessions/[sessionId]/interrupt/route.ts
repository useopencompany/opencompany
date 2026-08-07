import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { interruptCodexChatSession } from "@/lib/codex-chat";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const context = await currentUser({ optional: true });
  if (!context) return new Response("Unauthorized", { status: 401 });

  const { sessionId } = await params;
  const result = await interruptCodexChatSession({
    userWorkosId: context.user.workosUserId,
    chatSessionId: sessionId,
  });
  if (!result.ok)
    return new Response(result.error ?? "Unable to interrupt.", { status: result.status });

  return NextResponse.json({ ok: true }, { status: 202 });
}

import { NextResponse } from "next/server";
import { currentGoatUser } from "@/lib/auth";
import { interruptLocalCodexSessionForUser } from "@/lib/local-codex";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const context = await currentGoatUser({ optional: true });
  if (!context) return new Response("Unauthorized", { status: 401 });

  const { sessionId } = await params;
  const result = await interruptLocalCodexSessionForUser({
    userWorkosId: context.user.workosUserId,
    chatSessionId: sessionId,
  });
  if (!result.ok) return new Response(result.error, { status: result.status });

  return NextResponse.json({ ok: true }, { status: 202 });
}

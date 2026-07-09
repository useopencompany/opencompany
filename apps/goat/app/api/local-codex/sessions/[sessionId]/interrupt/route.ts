import { NextResponse } from "next/server";
import { currentGoatUser } from "@/lib/auth";
import { goatFeatureFlagsFromUser, LOCAL_CODEX_BETA_DISABLED_MESSAGE } from "@/lib/feature-flags";
import { interruptLocalCodexSessionForUser } from "@/lib/local-codex";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const context = await currentGoatUser({ optional: true });
  if (!context) return new Response("Unauthorized", { status: 401 });
  if (!goatFeatureFlagsFromUser(context.user).localCodexBridge) {
    return new Response(LOCAL_CODEX_BETA_DISABLED_MESSAGE, { status: 403 });
  }

  const { sessionId } = await params;
  const result = await interruptLocalCodexSessionForUser({
    userWorkosId: context.user.workosUserId,
    chatSessionId: sessionId,
  });
  if (!result.ok) return new Response(result.error, { status: result.status });

  return NextResponse.json({ ok: true }, { status: 202 });
}

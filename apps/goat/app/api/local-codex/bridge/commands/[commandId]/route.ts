import { NextResponse } from "next/server";
import { LOCAL_CODEX_BETA_DISABLED_MESSAGE } from "@/lib/feature-flags";
import { isLocalCodexBridgeBetaEnabledForUser } from "@/lib/feature-flags-server";
import { authenticateLocalCodexBridgeToken, completeLocalCodexCommand } from "@/lib/local-codex";

export const runtime = "nodejs";

type AckCommandBody = {
  status?: unknown;
  error?: unknown;
  codexThreadId?: unknown;
  codexTurnId?: unknown;
  worktreePath?: unknown;
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ commandId: string }> },
) {
  const bridge = await authenticateLocalCodexBridgeToken(request.headers.get("authorization"));
  if (!bridge) return new Response("Unauthorized", { status: 401 });
  if (!(await isLocalCodexBridgeBetaEnabledForUser(bridge.userWorkosId))) {
    return new Response(LOCAL_CODEX_BETA_DISABLED_MESSAGE, { status: 403 });
  }

  const body = await readJsonBody<AckCommandBody>(request);
  if (!body.ok) return new Response(body.error, { status: 400 });
  if (body.value.status !== "succeeded" && body.value.status !== "failed") {
    return new Response("Command status must be succeeded or failed.", { status: 400 });
  }

  const { commandId } = await params;
  const result = await completeLocalCodexCommand({
    bridge,
    commandId,
    status: body.value.status,
    error: typeof body.value.error === "string" ? body.value.error : null,
    codexThreadId: typeof body.value.codexThreadId === "string" ? body.value.codexThreadId : null,
    codexTurnId: typeof body.value.codexTurnId === "string" ? body.value.codexTurnId : null,
    worktreePath: typeof body.value.worktreePath === "string" ? body.value.worktreePath : null,
  });
  if (!result.ok) return new Response(result.error, { status: result.status });

  return NextResponse.json({ ok: true });
}

async function readJsonBody<T>(request: Request) {
  try {
    return { ok: true as const, value: (await request.json()) as T };
  } catch {
    return { ok: false as const, error: "Invalid JSON body." };
  }
}

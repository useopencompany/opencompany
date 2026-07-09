import { NextResponse } from "next/server";
import { LOCAL_CODEX_BETA_DISABLED_MESSAGE } from "@/lib/feature-flags";
import { isLocalCodexBridgeBetaEnabledForUser } from "@/lib/feature-flags-server";
import { authenticateLocalCodexBridgeToken, heartbeatLocalCodexBridge } from "@/lib/local-codex";

export const runtime = "nodejs";

type HeartbeatBody = {
  name?: unknown;
};

export async function POST(request: Request) {
  const bridge = await authenticateLocalCodexBridgeToken(request.headers.get("authorization"));
  if (!bridge) return new Response("Unauthorized", { status: 401 });
  if (!(await isLocalCodexBridgeBetaEnabledForUser(bridge.userWorkosId))) {
    return new Response(LOCAL_CODEX_BETA_DISABLED_MESSAGE, { status: 403 });
  }

  const body = await readJsonBody<HeartbeatBody>(request);
  if (!body.ok) return new Response(body.error, { status: 400 });

  await heartbeatLocalCodexBridge({
    bridge,
    name: typeof body.value.name === "string" ? body.value.name : null,
  });
  return NextResponse.json({ ok: true });
}

async function readJsonBody<T>(request: Request) {
  try {
    return { ok: true as const, value: (await request.json()) as T };
  } catch {
    return { ok: false as const, error: "Invalid JSON body." };
  }
}

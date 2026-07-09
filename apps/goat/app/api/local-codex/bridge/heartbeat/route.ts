import { NextResponse } from "next/server";
import { authenticateLocalCodexBridgeToken, heartbeatLocalCodexBridge } from "@/lib/local-codex";

export const runtime = "nodejs";

type HeartbeatBody = {
  name?: unknown;
};

export async function POST(request: Request) {
  const bridge = await authenticateLocalCodexBridgeToken(request.headers.get("authorization"));
  if (!bridge) return new Response("Unauthorized", { status: 401 });

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

import { NextResponse } from "next/server";
import { LOCAL_CODEX_BETA_DISABLED_MESSAGE } from "@/lib/feature-flags";
import { isLocalCodexBridgeBetaEnabledForUser } from "@/lib/feature-flags-server";
import { authenticateLocalCodexBridgeToken, recordLocalCodexBridgeEvents } from "@/lib/local-codex";

export const runtime = "nodejs";

type BridgeEventsBody = {
  localCodexSessionId?: unknown;
  localCodexTurnId?: unknown;
  commandId?: unknown;
  events?: unknown;
};

export async function POST(request: Request) {
  const bridge = await authenticateLocalCodexBridgeToken(request.headers.get("authorization"));
  if (!bridge) return new Response("Unauthorized", { status: 401 });
  if (!(await isLocalCodexBridgeBetaEnabledForUser(bridge.userWorkosId))) {
    return new Response(LOCAL_CODEX_BETA_DISABLED_MESSAGE, { status: 403 });
  }

  const body = await readJsonBody<BridgeEventsBody>(request);
  if (!body.ok) return new Response(body.error, { status: 400 });

  const localCodexSessionId =
    typeof body.value.localCodexSessionId === "string" ? body.value.localCodexSessionId : "";
  const events = Array.isArray(body.value.events) ? body.value.events.filter(isRecord) : [];
  if (!localCodexSessionId || events.length === 0) {
    return new Response("A local Codex session id and events are required.", { status: 400 });
  }

  const result = await recordLocalCodexBridgeEvents({
    bridge,
    localCodexSessionId,
    localCodexTurnId:
      typeof body.value.localCodexTurnId === "string" ? body.value.localCodexTurnId : null,
    commandId: typeof body.value.commandId === "string" ? body.value.commandId : null,
    events,
  });
  if (!result.ok) return new Response(result.error, { status: result.status });

  return NextResponse.json({ ok: true }, { status: 202 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readJsonBody<T>(request: Request) {
  try {
    return { ok: true as const, value: (await request.json()) as T };
  } catch {
    return { ok: false as const, error: "Invalid JSON body." };
  }
}

import { NextResponse } from "next/server";
import { LOCAL_CODEX_BETA_DISABLED_MESSAGE } from "@/lib/feature-flags";
import { isLocalCodexBridgeBetaEnabledForUser } from "@/lib/feature-flags-server";
import {
  authenticateLocalCodexBridgeToken,
  claimLocalCodexCommandsForBridge,
  heartbeatLocalCodexBridge,
} from "@/lib/local-codex";

export const runtime = "nodejs";
export const maxDuration = 30;

const LONG_POLL_MS = 25_000;
const POLL_INTERVAL_MS = 750;

type ClaimCommandsBody = {
  limit?: unknown;
  name?: unknown;
};

export async function POST(request: Request) {
  const bridge = await authenticateLocalCodexBridgeToken(request.headers.get("authorization"));
  if (!bridge) return new Response("Unauthorized", { status: 401 });
  if (!(await isLocalCodexBridgeBetaEnabledForUser(bridge.userWorkosId))) {
    return new Response(LOCAL_CODEX_BETA_DISABLED_MESSAGE, { status: 403 });
  }

  try {
    const body = await readJsonBody<ClaimCommandsBody>(request);
    if (!body.ok) return new Response(body.error, { status: 400 });

    await heartbeatLocalCodexBridge({
      bridge,
      name: typeof body.value.name === "string" ? body.value.name : null,
    });

    const limit = typeof body.value.limit === "number" ? body.value.limit : undefined;
    const deadline = Date.now() + LONG_POLL_MS;
    while (!request.signal.aborted) {
      const commands = await claimLocalCodexCommandsForBridge({
        bridge,
        ...(limit !== undefined ? { limit } : {}),
      });
      if (commands.length > 0 || Date.now() >= deadline) {
        return NextResponse.json({ commands });
      }
      await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())), request.signal);
    }

    return NextResponse.json({ commands: [] });
  } catch (error) {
    console.error("[goat-local-codex] failed to claim bridge commands", {
      bridgeId: bridge.id,
      error: errorMessage(error),
    });
    return new Response("Failed to claim Local Codex commands.", { status: 500 });
  }
}

async function sleep(ms: number, signal: AbortSignal) {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

async function readJsonBody<T>(request: Request) {
  try {
    return { ok: true as const, value: (await request.json()) as T };
  } catch {
    return { ok: false as const, error: "Invalid JSON body." };
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

import { currentGoatUser } from "@/lib/auth";
import { goatFeatureFlagsFromUser, LOCAL_CODEX_BETA_DISABLED_MESSAGE } from "@/lib/feature-flags";
import { createLocalCodexBridgeForUser } from "@/lib/local-codex";
import { buildLocalCodexStandaloneLauncher } from "@/lib/local-codex-standalone-launcher";

export const runtime = "nodejs";

type PairBridgeBody = {
  name?: unknown;
};

export async function POST(request: Request) {
  const context = await currentGoatUser({ optional: true });
  if (!context) return new Response("Unauthorized", { status: 401 });
  if (!goatFeatureFlagsFromUser(context.user).localCodexBridge) {
    return new Response(LOCAL_CODEX_BETA_DISABLED_MESSAGE, { status: 403 });
  }

  const body = await readJsonBody<PairBridgeBody>(request);
  if (!body.ok) return new Response(body.error, { status: 400 });

  const url = new URL(request.url);
  const name = typeof body.value.name === "string" ? body.value.name : "Local Codex bridge";
  const bridge = await createLocalCodexBridgeForUser({
    userWorkosId: context.user.workosUserId,
    name,
    baseUrl: url.origin,
  });

  const launcher = buildLocalCodexStandaloneLauncher({
    baseUrl: url.origin,
    token: bridge.token,
    name: bridge.bridge.name,
  });

  return new Response(launcher, {
    status: 201,
    headers: {
      "Content-Type": "application/x-terminal; charset=utf-8",
      "Content-Disposition": 'attachment; filename="opencompany-goat-codex-bridge.terminal"',
    },
  });
}

async function readJsonBody<T>(request: Request) {
  try {
    return { ok: true as const, value: (await request.json()) as T };
  } catch {
    return { ok: false as const, error: "Invalid JSON body." };
  }
}

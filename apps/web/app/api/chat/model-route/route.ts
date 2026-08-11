import { AutoModelRoutingError } from "@opencompany/goat-agent/application/auto-model-routing";
import { resolvePersistedAutoModelRouting } from "@opencompany/goat-agent/application/persisted-auto-model-routing";
import { createLogger } from "@opencompany/observability";
import { resolveGoatChatRequestContext } from "@/lib/chat-request-auth";

export const runtime = "nodejs";
export const maxDuration = 30;

const logger = createLogger({ service: "opencompany-goat", runtime: "chat-model-route" });

export async function POST(request: Request) {
  const auth = await resolveGoatChatRequestContext(request);
  if (!auth.ok) return auth.response;
  const parsed = await parseRequest(request);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  let resolution;
  try {
    resolution = await resolvePersistedAutoModelRouting({
      actorId: auth.context.user.workosUserId,
      workspaceId: auth.context.workspace.id,
      idempotencyKey: `web-message:${parsed.clientMessageId}`.slice(0, 200),
      clientMessageId: parsed.clientMessageId,
      prompt: parsed.prompt,
      attachmentIds: parsed.attachmentIds,
      gatewayApiKey: process.env.VERCEL_AI_GATEWAY_API_KEY?.trim(),
    });
  } catch (error) {
    if (error instanceof AutoModelRoutingError) {
      const status =
        error.code === "attachments_unavailable" ? 400 : error.code === "unavailable" ? 503 : 403;
      return Response.json({ error: error.message }, { status });
    }
    throw error;
  }
  if (resolution.source !== "routed") {
    return Response.json({
      model: resolution.model,
      tier: "replay",
      reason: resolution.source,
      outcome: "replayed",
    });
  }
  const result = resolution.routing;
  if (!result) throw new Error("Routed Auto resolution is missing diagnostics.");
  logger.info("Headless Chat model routed", {
    event: "opencompany.headless_chat_model_routed",
    tier: result.tier,
    reason: result.reason,
    outcome: result.classifier.outcome,
    duration_ms: result.classifier.durationMs,
    selected_model: result.model,
  });
  return Response.json({
    model: result.model,
    tier: result.tier,
    reason: result.reason,
    outcome: result.classifier.outcome,
  });
}

async function parseRequest(
  request: Request,
): Promise<
  | { ok: true; clientMessageId: string; prompt: string; attachmentIds: string[] }
  | { ok: false; error: string }
> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return { ok: false, error: "Invalid JSON body." };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "Invalid model-routing request." };
  }
  const body = value as Record<string, unknown>;
  const clientMessageId =
    typeof body.clientMessageId === "string" ? body.clientMessageId.trim() : "";
  if (!clientMessageId || clientMessageId.length > 256) {
    return { ok: false, error: "clientMessageId is required." };
  }
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (prompt.length > 100_000) return { ok: false, error: "prompt is too long." };
  if (!Array.isArray(body.attachmentIds) || body.attachmentIds.length > 8) {
    return { ok: false, error: "attachmentIds must be an array of at most 8 ids." };
  }
  const attachmentIds = body.attachmentIds.filter(
    (id): id is string => typeof id === "string" && Boolean(id.trim()),
  );
  if (
    attachmentIds.length !== body.attachmentIds.length ||
    new Set(attachmentIds).size !== attachmentIds.length
  ) {
    return { ok: false, error: "attachmentIds must contain unique non-empty ids." };
  }
  if (!prompt && attachmentIds.length === 0) {
    return { ok: false, error: "prompt or attachmentIds is required." };
  }
  return { ok: true, clientMessageId, prompt, attachmentIds };
}

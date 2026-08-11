import { getDb } from "@opencompany/db/client";
import {
  goatChatAttachmentUploads,
  goatChatMessages,
  goatChatSessions,
  goatCodexChatSessions,
} from "@opencompany/db/goat-schema";
import { createLogger } from "@opencompany/observability";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { resolveAutoGoatModel } from "@/lib/chat-model-router";
import { resolveGoatChatRequestContext } from "@/lib/chat-request-auth";

export const runtime = "nodejs";
export const maxDuration = 30;

const logger = createLogger({ service: "opencompany-goat", runtime: "chat-model-route" });

export async function POST(request: Request) {
  const auth = await resolveGoatChatRequestContext(request);
  if (!auth.ok) return auth.response;
  if (!auth.context.user.autoModelRoutingEnabled) {
    return Response.json({ error: "Auto model routing is not enabled." }, { status: 403 });
  }
  const parsed = await parseRequest(request);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  const [existing] = await getDb()
    .select({ model: goatChatSessions.model })
    .from(goatChatMessages)
    .innerJoin(
      goatChatSessions,
      and(
        eq(goatChatSessions.id, goatChatMessages.sessionId),
        eq(goatChatSessions.userWorkosId, auth.context.user.workosUserId),
      ),
    )
    .innerJoin(
      goatCodexChatSessions,
      and(
        eq(goatCodexChatSessions.chatSessionId, goatChatSessions.id),
        eq(goatCodexChatSessions.userWorkosId, auth.context.user.workosUserId),
        eq(goatCodexChatSessions.workspaceId, auth.context.workspace.id),
        eq(goatCodexChatSessions.engine, "opencompany"),
      ),
    )
    .where(and(eq(goatChatMessages.id, parsed.clientMessageId), eq(goatChatMessages.role, "user")))
    .limit(1);
  if (existing?.model) {
    return Response.json({
      model: existing.model,
      tier: "replay",
      reason: "existing_message",
      outcome: "replayed",
    });
  }
  const gatewayApiKey = process.env.VERCEL_AI_GATEWAY_API_KEY?.trim();
  if (!gatewayApiKey) {
    return Response.json({ error: "Chat model routing is not configured." }, { status: 503 });
  }
  const attachments = parsed.attachmentIds.length
    ? await getDb()
        .select({ id: goatChatAttachmentUploads.id, format: goatChatAttachmentUploads.format })
        .from(goatChatAttachmentUploads)
        .where(
          and(
            inArray(goatChatAttachmentUploads.id, parsed.attachmentIds),
            eq(goatChatAttachmentUploads.userWorkosId, auth.context.user.workosUserId),
            eq(goatChatAttachmentUploads.workspaceId, auth.context.workspace.id),
            or(
              isNull(goatChatAttachmentUploads.claimedAt),
              eq(goatChatAttachmentUploads.claimedMessageId, parsed.clientMessageId),
            ),
          ),
        )
        .limit(parsed.attachmentIds.length)
    : [];
  if (attachments.length !== parsed.attachmentIds.length) {
    return Response.json({ error: "One or more attachments are unavailable." }, { status: 400 });
  }
  const result = await resolveAutoGoatModel({
    prompt: parsed.prompt,
    attachments: attachments.map((attachment) => ({ kind: attachment.format })),
    gatewayApiKey,
    userWorkosId: auth.context.user.workosUserId,
    workspaceId: auth.context.workspace.id,
  });
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

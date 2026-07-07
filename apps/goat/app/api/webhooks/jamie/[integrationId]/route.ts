import { upsertGoatBrainSourceItemAndEnqueue } from "@opencompany/db/goat-brain-ingest";
import {
  BrainSourceNormalizationError,
  normalizeJamieMeetingCompletedWebhook,
} from "@opencompany/goat-brain";
import { NextResponse } from "next/server";
import {
  bindGoatJamieWebhookApiKey,
  loadGoatJamieWebhookContext,
  markGoatJamieWebhookConnected,
  verifyGoatJamieWebhookApiKey,
} from "@/lib/integrations/jamie";
import {
  GOAT_JAMIE_WEBHOOK_EVENT_HEADER,
  GOAT_JAMIE_WEBHOOK_SECRET_HEADER,
} from "@/lib/integrations/jamie-constants";
import { triggerGoatBrainIngestWake } from "@/lib/task-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ integrationId: string }> },
) {
  const { integrationId } = await context.params;
  const webhookContext = await loadGoatJamieWebhookContext(integrationId);
  if (!webhookContext) {
    return NextResponse.json({ error: "Jamie integration not found." }, { status: 404 });
  }

  const apiKey = request.headers.get(GOAT_JAMIE_WEBHOOK_SECRET_HEADER);
  const apiKeyVerification = verifyGoatJamieWebhookApiKey({
    candidate: apiKey,
    apiKeyHash: webhookContext.apiKeyHash,
    legacySecretHash: webhookContext.legacySecretHash,
  });
  if (!apiKeyVerification.valid) {
    return NextResponse.json({ error: "Invalid Jamie webhook API key." }, { status: 401 });
  }

  const event = request.headers.get(GOAT_JAMIE_WEBHOOK_EVENT_HEADER);
  if (event !== "meeting.completed") {
    return NextResponse.json({ error: "Unsupported Jamie webhook event." }, { status: 400 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const receivedAt = new Date();
  let item;
  try {
    item = normalizeJamieMeetingCompletedWebhook(payload, {
      capturedAt: receivedAt.toISOString(),
    });
  } catch (error) {
    if (error instanceof BrainSourceNormalizationError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
    }
    throw error;
  }

  if (apiKeyVerification.shouldBind) {
    await bindGoatJamieWebhookApiKey({
      integrationId: webhookContext.integrationId,
      userWorkosId: webhookContext.userWorkosId,
      apiKey: apiKeyVerification.apiKey,
      now: receivedAt,
    });
  }

  const result = await upsertGoatBrainSourceItemAndEnqueue({
    userWorkosId: webhookContext.userWorkosId,
    sourceConnectionId: webhookContext.integrationId,
    integrationId: webhookContext.integrationId,
    item,
    rawPayload: payload,
    now: receivedAt,
  });

  await markGoatJamieWebhookConnected({
    integrationId: webhookContext.integrationId,
    userWorkosId: webhookContext.userWorkosId,
    now: receivedAt,
  });

  if (result.enqueued) {
    triggerGoatBrainIngestWake().catch((error) => {
      console.warn("[goat-jamie] Failed to wake Goat Brain ingest worker", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  return NextResponse.json({
    ok: true,
    sourceItemId: result.sourceItemId,
    jobId: result.jobId,
    enqueued: result.enqueued,
  });
}

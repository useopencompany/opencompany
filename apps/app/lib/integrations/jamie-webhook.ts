import { captureIngestionQuotaAnalytics } from "@opencompany/analytics/app";
import {
  BrainSourceNormalizationError,
  normalizeJamieMeetingCompletedWebhook,
} from "@opencompany/brain";
import {
  BRAIN_AGENT_INGEST_JOB_KIND,
  upsertBrainSourceItemAndEnqueue,
} from "@opencompany/db/brain-ingest";
import {
  hasAnyBrainSourceForIntegration,
  listEnabledBrainRefsForIntegration,
} from "@opencompany/db/brain-sources";
import { getDefaultBrainForUser } from "@opencompany/db/workspaces";
import { NextResponse } from "next/server";
import {
  type JamieWebhookContext,
  markJamieWebhookConnected,
  verifyJamieWebhookApiKey,
} from "@/lib/integrations/jamie";
import {
  JAMIE_WEBHOOK_EVENT_HEADER,
  JAMIE_WEBHOOK_SECRET_HEADER,
} from "@/lib/integrations/jamie-constants";
import { triggerBrainIngestWake } from "@/lib/task-runner";

export async function handleJamieWebhookDelivery(input: {
  request: Request;
  webhookContext: JamieWebhookContext | null;
  missingContextStatus: 401 | 404;
}) {
  const { request, webhookContext } = input;
  if (!webhookContext) {
    return NextResponse.json(
      {
        error:
          input.missingContextStatus === 404
            ? "Jamie integration not found."
            : "Invalid Jamie webhook API key.",
      },
      { status: input.missingContextStatus },
    );
  }

  const apiKey = request.headers.get(JAMIE_WEBHOOK_SECRET_HEADER);
  const apiKeyVerification = verifyJamieWebhookApiKey({
    candidate: apiKey,
    apiKeyHash: webhookContext.apiKeyHash,
    legacySecretHash: webhookContext.legacySecretHash,
  });
  if (!apiKeyVerification.valid) {
    return NextResponse.json({ error: "Invalid Jamie webhook API key." }, { status: 401 });
  }

  const event = request.headers.get(JAMIE_WEBHOOK_EVENT_HEADER);
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

  // Routing: fan out to every brain that has this integration enabled as a
  // source. Integrations that were never configured per-brain keep the legacy
  // behavior (user's default brain; null pins resolution to run time). An
  // integration whose sources are all disabled persists the item but enqueues
  // nothing.
  const enabledBrainRefs = await listEnabledBrainRefsForIntegration(webhookContext.integrationId);
  let brainRefs: (string | null)[] = enabledBrainRefs;
  if (enabledBrainRefs.length === 0) {
    const configured = await hasAnyBrainSourceForIntegration(webhookContext.integrationId);
    if (!configured) {
      const defaultBrain = await getDefaultBrainForUser(webhookContext.userWorkosId);
      brainRefs = [defaultBrain?.id ?? null];
    }
  }
  const result = await upsertBrainSourceItemAndEnqueue({
    userWorkosId: webhookContext.userWorkosId,
    sourceConnectionId: webhookContext.integrationId,
    integrationId: webhookContext.integrationId,
    item,
    rawPayload: payload,
    kind: BRAIN_AGENT_INGEST_JOB_KIND,
    brainRefs,
    now: receivedAt,
  });
  captureIngestionQuotaAnalytics(result.quotaUpdates);

  await markJamieWebhookConnected({
    integrationId: webhookContext.integrationId,
    userWorkosId: webhookContext.userWorkosId,
    now: receivedAt,
  });

  if (result.enqueued) {
    triggerBrainIngestWake().catch((error) => {
      console.warn("[jamie] Failed to wake the Brain ingest worker", {
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

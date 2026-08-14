import { captureProductIngestionQuotaAnalytics } from "@opencompany/analytics/product";
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
import { getDb } from "@opencompany/db/client";
import { getDefaultBrainForUser } from "@opencompany/db/workspaces";
import {
  type JamieWebhookContext,
  markJamieWebhookConnected,
  verifyJamieWebhookApiKey,
} from "./jamie";
import { JAMIE_WEBHOOK_EVENT_HEADER, JAMIE_WEBHOOK_SECRET_HEADER } from "./jamie-constants";

type DbLike = any;

export async function handleJamieWebhookDelivery(input: {
  request: Request;
  webhookContext: JamieWebhookContext | null;
  missingContextStatus: 401 | 404;
  db?: DbLike;
}) {
  const { request, webhookContext } = input;
  const db: DbLike = input.db ?? getDb();
  if (!webhookContext) {
    return Response.json(
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
    return Response.json({ error: "Invalid Jamie webhook API key." }, { status: 401 });
  }

  const event = request.headers.get(JAMIE_WEBHOOK_EVENT_HEADER);
  if (event !== "meeting.completed") {
    return Response.json({ error: "Unsupported Jamie webhook event." }, { status: 400 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const receivedAt = new Date();
  let item;
  try {
    item = normalizeJamieMeetingCompletedWebhook(payload, {
      capturedAt: receivedAt.toISOString(),
    });
  } catch (error) {
    if (error instanceof BrainSourceNormalizationError) {
      return Response.json({ error: error.message, code: error.code }, { status: 400 });
    }
    throw error;
  }

  // Routing: fan out to every brain that has this integration enabled as a
  // source. Integrations that were never configured per-brain keep the legacy
  // behavior (user's default brain; null pins resolution to run time). An
  // integration whose sources are all disabled persists the item but enqueues
  // nothing.
  const enabledBrainRefs = await listEnabledBrainRefsForIntegration(
    webhookContext.integrationId,
    db,
  );
  let brainRefs: (string | null)[] = enabledBrainRefs;
  if (enabledBrainRefs.length === 0) {
    const configured = await hasAnyBrainSourceForIntegration(webhookContext.integrationId, db);
    if (!configured) {
      const defaultBrain = await getDefaultBrainForUser(webhookContext.userWorkosId, { db });
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
    db,
  });
  captureProductIngestionQuotaAnalytics(result.quotaUpdates);

  await markJamieWebhookConnected(
    {
      integrationId: webhookContext.integrationId,
      userWorkosId: webhookContext.userWorkosId,
      now: receivedAt,
    },
    db,
  );

  return Response.json({
    ok: true,
    sourceItemId: result.sourceItemId,
    jobId: result.jobId,
    enqueued: result.enqueued,
  });
}

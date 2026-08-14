import { captureGoatIngestionQuotaAnalytics } from "@opencompany/analytics/goat";
import { getDb } from "@opencompany/db/client";
import {
  GOAT_BRAIN_AGENT_INGEST_JOB_KIND,
  upsertGoatBrainSourceItemAndEnqueue,
} from "@opencompany/db/goat-brain-ingest";
import {
  hasAnyBrainSourceForIntegration,
  listEnabledBrainRefsForIntegration,
} from "@opencompany/db/goat-brain-sources";
import { getDefaultGoatBrainForUser } from "@opencompany/db/goat-workspaces";
import {
  BrainSourceNormalizationError,
  normalizeJamieMeetingCompletedWebhook,
} from "@opencompany/goat-brain";
import {
  type GoatJamieWebhookContext,
  markGoatJamieWebhookConnected,
  verifyGoatJamieWebhookApiKey,
} from "./jamie";
import {
  GOAT_JAMIE_WEBHOOK_EVENT_HEADER,
  GOAT_JAMIE_WEBHOOK_SECRET_HEADER,
} from "./jamie-constants";

type DbLike = any;

export async function handleGoatJamieWebhookDelivery(input: {
  request: Request;
  webhookContext: GoatJamieWebhookContext | null;
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

  const apiKey = request.headers.get(GOAT_JAMIE_WEBHOOK_SECRET_HEADER);
  const apiKeyVerification = verifyGoatJamieWebhookApiKey({
    candidate: apiKey,
    apiKeyHash: webhookContext.apiKeyHash,
    legacySecretHash: webhookContext.legacySecretHash,
  });
  if (!apiKeyVerification.valid) {
    return Response.json({ error: "Invalid Jamie webhook API key." }, { status: 401 });
  }

  const event = request.headers.get(GOAT_JAMIE_WEBHOOK_EVENT_HEADER);
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
      const defaultBrain = await getDefaultGoatBrainForUser(webhookContext.userWorkosId, { db });
      brainRefs = [defaultBrain?.id ?? null];
    }
  }
  const result = await upsertGoatBrainSourceItemAndEnqueue({
    userWorkosId: webhookContext.userWorkosId,
    sourceConnectionId: webhookContext.integrationId,
    integrationId: webhookContext.integrationId,
    item,
    rawPayload: payload,
    kind: GOAT_BRAIN_AGENT_INGEST_JOB_KIND,
    brainRefs,
    now: receivedAt,
    db,
  });
  captureGoatIngestionQuotaAnalytics(result.quotaUpdates);

  await markGoatJamieWebhookConnected(
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

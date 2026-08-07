import { createHash } from "node:crypto";
import { captureIngestionQuotaAnalytics } from "@opencompany/analytics/app";
import {
  BrainSourceNormalizationError,
  githubActivityEventType,
  normalizeGitHubActivityWebhook,
} from "@opencompany/brain";
import {
  GOAT_BRAIN_AGENT_INGEST_JOB_KIND,
  upsertBrainSourceItemAndEnqueue,
} from "@opencompany/db/brain-ingest";
import {
  type GitHubPullRequestEventInsert,
  gitHubEnabledEventTypes,
  gitHubSelectedRepoIds,
  insertGitHubPullRequestEvents,
  listEnabledGitHubBrainSourceRoutes,
  listGitHubIntegrationsForInstallation,
} from "@opencompany/db/github";
import { markIntegrationStatus } from "@opencompany/db/integrations";
import { NextResponse } from "next/server";
import { verifyGitHubWebhookSignature } from "@/lib/integrations/github-signature";
import { triggerBrainIngestWake } from "@/lib/task-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rawBody = await request.text();
  const verified = verifyGitHubWebhookSignature({
    rawBody,
    signature: request.headers.get("x-hub-signature-256"),
  });
  if (!verified) {
    return NextResponse.json({ error: "Invalid GitHub signature." }, { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const eventName = request.headers.get("x-github-event") ?? "";
  if (eventName === "ping") {
    return NextResponse.json({ ok: true });
  }

  // Pull-request delivery ids make buffering retries idempotent. Surface
  // transient failures so GitHub redelivers instead of losing activity.
  try {
    if (eventName === "installation") {
      return NextResponse.json(await handleInstallationEvent(payload));
    }
    const deliveryId =
      request.headers.get("x-github-delivery")?.trim() ||
      createHash("sha256").update(rawBody).digest("hex");
    return NextResponse.json(await handleActivityEvent(eventName, payload, deliveryId));
  } catch (error) {
    console.error("[goat-github] Failed to process GitHub event", {
      eventName,
      action: payload.action,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: "Unable to process GitHub event." }, { status: 503 });
  }
}

// App uninstalls and suspensions kill installation tokens; surface that on the
// affected integrations so the settings UI prompts a reconnect.
async function handleInstallationEvent(payload: Record<string, unknown>) {
  const action = typeof payload.action === "string" ? payload.action : "";
  if (action !== "deleted" && action !== "suspend") {
    return { ok: true, ignored: true };
  }
  const installationId = readInstallationId(payload);
  if (!installationId) return { ok: true, ignored: true };

  const integrations = await listGitHubIntegrationsForInstallation(installationId);
  let marked = 0;
  for (const integration of integrations) {
    if (integration.status === "disconnected") continue;
    await markIntegrationStatus({
      userWorkosId: integration.userWorkosId,
      integrationId: integration.id,
      provider: "github",
      status: "needs_reauth",
      statusReason:
        action === "deleted"
          ? "The GitHub App was uninstalled."
          : "The GitHub App installation was suspended.",
    });
    marked += 1;
  }
  return { ok: true, marked };
}

async function handleActivityEvent(
  eventName: string,
  payload: Record<string, unknown>,
  deliveryId: string,
) {
  let item;
  try {
    item = normalizeGitHubActivityWebhook(eventName, payload, {
      capturedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof BrainSourceNormalizationError) {
      console.warn("[goat-github] Dropping malformed GitHub event", {
        eventName,
        code: error.code,
        error: error.message,
      });
      return { ok: true, dropped: true };
    }
    throw error;
  }
  if (!item) return { ok: true, ignored: true };

  const installationId = readInstallationId(payload);
  if (!installationId) return { ok: true, dropped: true };

  const integrations = await listGitHubIntegrationsForInstallation(installationId);
  const connected = integrations.filter((integration) => integration.status === "connected");
  if (connected.length === 0) return { ok: true, dropped: true };

  const routes = await listEnabledGitHubBrainSourceRoutes(
    connected.map((integration) => integration.id),
  );
  const repoId = item.content.activity.repository.id;
  const eventType = githubActivityEventType(item.content.activity);
  const brainRefsByIntegration = new Map<string, string[]>();
  for (const route of routes) {
    if (!gitHubSelectedRepoIds(route.config).has(repoId)) continue;
    if (!gitHubEnabledEventTypes(route.config).has(eventType)) continue;
    const refs = brainRefsByIntegration.get(route.integrationId) ?? [];
    refs.push(route.brainRef);
    brainRefsByIntegration.set(route.integrationId, refs);
  }
  if (brainRefsByIntegration.size === 0) return { ok: true, dropped: true };

  if (item.content.activity.kind === "pull_request") {
    const pullRequestNumber = item.content.activity.number;
    const pullRequestEventType =
      eventType === "pull_request_opened" ||
      eventType === "pull_request_merged" ||
      eventType === "pull_request_commented"
        ? eventType
        : null;
    if (pullRequestNumber === undefined || !pullRequestEventType) {
      return { ok: true, dropped: true };
    }
    const inserts: GitHubPullRequestEventInsert[] = connected.flatMap((integration) => {
      const brainRefs = brainRefsByIntegration.get(integration.id);
      if (!brainRefs || brainRefs.length === 0) return [];
      return [
        {
          integrationId: integration.id,
          userWorkosId: integration.userWorkosId,
          installationId,
          repositoryId: repoId,
          pullRequestNumber,
          deliveryId,
          eventType: pullRequestEventType,
          payload,
          eventTime: new Date(item.occurredAt),
        },
      ];
    });
    const buffered = await insertGitHubPullRequestEvents(inserts);
    return { ok: true, buffered };
  }

  let enqueued = 0;
  for (const integration of connected) {
    const brainRefs = brainRefsByIntegration.get(integration.id);
    if (!brainRefs || brainRefs.length === 0) continue;
    const result = await upsertBrainSourceItemAndEnqueue({
      userWorkosId: integration.userWorkosId,
      sourceConnectionId: integration.id,
      integrationId: integration.id,
      item,
      rawPayload: payload,
      kind: GOAT_BRAIN_AGENT_INGEST_JOB_KIND,
      brainRefs,
    });
    captureIngestionQuotaAnalytics(result.quotaUpdates);
    enqueued += result.jobIds.length;
  }

  if (enqueued > 0) {
    triggerBrainIngestWake().catch((error) => {
      console.warn("[goat-github] Failed to wake Goat Brain ingest worker", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  return { ok: true, enqueued };
}

function readInstallationId(payload: Record<string, unknown>): string | null {
  const installation = payload.installation;
  if (!installation || typeof installation !== "object" || Array.isArray(installation)) return null;
  const id = (installation as Record<string, unknown>).id;
  if (typeof id !== "number" && typeof id !== "string") return null;
  return String(id);
}

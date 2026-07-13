import { captureGoatIngestionQuotaAnalytics } from "@opencompany/analytics/goat";
import {
  GOAT_BRAIN_AGENT_INGEST_JOB_KIND,
  upsertGoatBrainSourceItemAndEnqueue,
} from "@opencompany/db/goat-brain-ingest";
import {
  goatGitHubEnabledEventTypes,
  goatGitHubSelectedRepoIds,
  listEnabledGoatGitHubBrainSourceRoutes,
  listGoatGitHubIntegrationsForInstallation,
} from "@opencompany/db/goat-github";
import { markGoatIntegrationStatus } from "@opencompany/db/goat-integrations";
import {
  BrainSourceNormalizationError,
  githubActivityEventType,
  normalizeGitHubActivityWebhook,
} from "@opencompany/goat-brain";
import { NextResponse } from "next/server";
import { verifyGoatGitHubWebhookSignature } from "@/lib/integrations/github-signature";
import { triggerGoatBrainIngestWake } from "@/lib/task-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rawBody = await request.text();
  const verified = verifyGoatGitHubWebhookSignature({
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

  // After the signature check every path acks with 200 — a non-2xx would only
  // trigger GitHub redeliveries of payloads we already know how to handle.
  try {
    if (eventName === "installation") {
      return NextResponse.json(await handleInstallationEvent(payload));
    }
    return NextResponse.json(await handleActivityEvent(eventName, payload));
  } catch (error) {
    console.error("[goat-github] Failed to process GitHub event", {
      eventName,
      action: payload.action,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ ok: true });
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

  const integrations = await listGoatGitHubIntegrationsForInstallation(installationId);
  let marked = 0;
  for (const integration of integrations) {
    if (integration.status === "disconnected") continue;
    await markGoatIntegrationStatus({
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

async function handleActivityEvent(eventName: string, payload: Record<string, unknown>) {
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

  const integrations = await listGoatGitHubIntegrationsForInstallation(installationId);
  const connected = integrations.filter((integration) => integration.status === "connected");
  if (connected.length === 0) return { ok: true, dropped: true };

  const routes = await listEnabledGoatGitHubBrainSourceRoutes(
    connected.map((integration) => integration.id),
  );
  const repoId = item.content.activity.repository.id;
  const eventType = githubActivityEventType(item.content.activity);
  const brainRefsByIntegration = new Map<string, string[]>();
  for (const route of routes) {
    if (!goatGitHubSelectedRepoIds(route.config).has(repoId)) continue;
    if (!goatGitHubEnabledEventTypes(route.config).has(eventType)) continue;
    const refs = brainRefsByIntegration.get(route.integrationId) ?? [];
    refs.push(route.brainRef);
    brainRefsByIntegration.set(route.integrationId, refs);
  }
  if (brainRefsByIntegration.size === 0) return { ok: true, dropped: true };

  let enqueued = 0;
  for (const integration of connected) {
    const brainRefs = brainRefsByIntegration.get(integration.id);
    if (!brainRefs || brainRefs.length === 0) continue;
    const result = await upsertGoatBrainSourceItemAndEnqueue({
      userWorkosId: integration.userWorkosId,
      sourceConnectionId: integration.id,
      integrationId: integration.id,
      item,
      rawPayload: payload,
      kind: GOAT_BRAIN_AGENT_INGEST_JOB_KIND,
      brainRefs,
    });
    captureGoatIngestionQuotaAnalytics(result.quotaUpdates);
    enqueued += result.jobIds.length;
  }

  if (enqueued > 0) {
    triggerGoatBrainIngestWake().catch((error) => {
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

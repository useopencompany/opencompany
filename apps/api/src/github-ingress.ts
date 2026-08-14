import { createHash } from "node:crypto";
import { captureGoatIngestionQuotaAnalytics } from "@opencompany/analytics/goat";
import {
  GOAT_BRAIN_AGENT_INGEST_JOB_KIND,
  upsertGoatBrainSourceItemAndEnqueue,
} from "@opencompany/db/goat-brain-ingest";
import {
  type GoatGitHubPullRequestEventInsert,
  goatGitHubEnabledEventTypes,
  goatGitHubSelectedRepoIds,
  insertGoatGitHubPullRequestEvents,
  listEnabledGoatGitHubBrainSourceRoutes,
  listGoatGitHubIntegrationsForInstallation,
} from "@opencompany/db/goat-github";
import { markGoatIntegrationStatus } from "@opencompany/db/goat-integrations";
import { getGoatAppUrl } from "@opencompany/goat-agent/app-url";
import { captureGoatIntegrationAddedAnalytics } from "@opencompany/goat-agent/integrations/analytics";
import {
  appendGoatGitHubIntegrationStatus,
  buildGoatGitHubInstallUrl,
  buildGoatGitHubUserAuthorizationUrl,
  createGoatGitHubIntegrationState,
  exchangeGoatGitHubUserCode,
  getGoatGitHubInstallation,
  isGoatGitHubIntegrationConfigured,
  listGoatGitHubInstallationRepositories,
  syncGoatGitHubIntegrationRepositories,
  verifyGoatGitHubIntegrationState,
  verifyGoatGitHubUserInstallation,
} from "@opencompany/goat-agent/integrations/github";
import { verifyGoatGitHubWebhookSignature } from "@opencompany/goat-agent/integrations/github-signature";
import {
  BrainSourceNormalizationError,
  githubActivityEventType,
  normalizeGitHubActivityWebhook,
} from "@opencompany/goat-brain";
import { createLogger } from "@opencompany/observability";
import type { ApiIdentityVerifier } from "./auth";
import { type IngressSession, resolveIngressSession, sessionRedirect } from "./ingress-session";

const logger = createLogger({ service: "opencompany-api", runtime: "github-ingress" });

type DbLike = any;

// Provider ingress composition for GitHub: the App install/authorize OAuth
// dance and the activity webhook. Public URLs stay on the web origin — web
// relays the exact request here — so no remote GitHub configuration changes.
export type GitHubIngressService = {
  start(request: Request): Promise<Response>;
  callback(request: Request): Promise<Response>;
  webhook(request: Request): Promise<Response>;
};

export function createGitHubIngress(input: {
  db: DbLike;
  identify: ApiIdentityVerifier;
}): GitHubIngressService {
  return {
    start: (request) => handleStart(input, request),
    callback: (request) => handleCallback(input, request),
    webhook: (request) => handleWebhook(input, request),
  };
}

type IngressInput = { db: DbLike; identify: ApiIdentityVerifier };

async function handleStart(input: IngressInput, request: Request): Promise<Response> {
  const session = await resolveIngressSession(input, request);
  if (session.kind === "redirect") return session.response;
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") ?? "/settings";

  // GitHub App installations are workspace-owned plumbing; only admins may
  // connect them.
  if (session.role !== "admin") {
    return statusRedirect(session, returnTo, "error", "admin_required");
  }
  if (!isGoatGitHubIntegrationConfigured()) {
    return statusRedirect(session, returnTo, "error", "not_configured");
  }

  const state = createGoatGitHubIntegrationState({
    userWorkosId: session.userId,
    workspaceId: session.workspaceId,
    returnTo,
  });
  return sessionRedirect(session, buildGoatGitHubInstallUrl(state));
}

async function handleCallback(input: IngressInput, request: Request): Promise<Response> {
  const session = await resolveIngressSession(input, request);
  if (session.kind === "redirect") return session.response;
  const url = new URL(request.url);
  const stateValue = url.searchParams.get("state") ?? "";

  let state: ReturnType<typeof verifyGoatGitHubIntegrationState>;
  try {
    state = verifyGoatGitHubIntegrationState(stateValue);
  } catch {
    return sessionRedirect(
      session,
      new URL("/settings?integration=github&setup=error&reason=invalid_state", getGoatAppUrl()),
    );
  }

  if (state.userWorkosId !== session.userId) {
    return statusRedirect(session, state.returnTo, "error", "session_mismatch");
  }

  // The installation lands on the workspace the flow started in; the finishing
  // session must still be an admin of that workspace (checked against the same
  // billing-filtered visible-workspace list the retired web route used).
  const membership = session.workspaces.find((entry) => entry.workspace.id === state.workspaceId);
  if (!membership || membership.role !== "admin") {
    return statusRedirect(session, state.returnTo, "error", "admin_required");
  }

  if (!isGoatGitHubIntegrationConfigured()) {
    return statusRedirect(session, state.returnTo, "error", "not_configured");
  }

  const installationId = state.installationId ?? url.searchParams.get("installation_id");
  const code = url.searchParams.get("code");
  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    return statusRedirect(session, state.returnTo, "error", "github_denied");
  }
  if (!installationId) {
    return statusRedirect(session, state.returnTo, "error", "missing_installation_id");
  }

  if (!code) {
    const nextState = createGoatGitHubIntegrationState({
      userWorkosId: state.userWorkosId,
      workspaceId: state.workspaceId,
      returnTo: state.returnTo,
      installationId,
    });
    return sessionRedirect(session, buildGoatGitHubUserAuthorizationUrl(nextState));
  }

  try {
    const userToken = await exchangeGoatGitHubUserCode(code);
    const verifiedInstallation = await verifyGoatGitHubUserInstallation({
      userToken,
      installationId,
    });
    const installation = await getGoatGitHubInstallation({ installationId });
    const repositories = await listGoatGitHubInstallationRepositories({ installationId });

    await syncGoatGitHubIntegrationRepositories(
      {
        userWorkosId: session.userId,
        workspaceId: state.workspaceId,
        installationId,
        accountLogin: installation.account?.login ?? verifiedInstallation.account?.login ?? null,
        accountType: installation.account?.type ?? verifiedInstallation.account?.type ?? null,
        repositories,
      },
      input.db,
    );
    await captureGoatIntegrationAddedAnalytics({
      userWorkosId: session.userId,
      workspaceId: state.workspaceId,
      provider: "github",
    });

    return statusRedirect(session, state.returnTo, "connected");
  } catch (error) {
    logger.error("GitHub integration connection sync failed", {
      event: "opencompany.github_integration_callback_failed",
      error_name: error instanceof Error ? error.name : typeof error,
    });
    return statusRedirect(session, state.returnTo, "error", "connection_sync_failed");
  }
}

async function handleWebhook(input: IngressInput, request: Request): Promise<Response> {
  const rawBody = await request.text();
  const verified = verifyGoatGitHubWebhookSignature({
    rawBody,
    signature: request.headers.get("x-hub-signature-256"),
  });
  if (!verified) {
    return Response.json({ error: "Invalid GitHub signature." }, { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const eventName = request.headers.get("x-github-event") ?? "";
  if (eventName === "ping") {
    return Response.json({ ok: true });
  }

  // Pull-request delivery ids make buffering retries idempotent. Surface
  // transient failures so GitHub redelivers instead of losing activity.
  try {
    if (eventName === "installation") {
      return Response.json(await handleInstallationEvent(input.db, payload));
    }
    const deliveryId =
      request.headers.get("x-github-delivery")?.trim() ||
      createHash("sha256").update(rawBody).digest("hex");
    return Response.json(await handleActivityEvent(input.db, eventName, payload, deliveryId));
  } catch (error) {
    logger.error("Failed to process GitHub event", {
      event: "opencompany.github_webhook_failed",
      event_name: eventName,
      action: typeof payload.action === "string" ? payload.action : undefined,
      error_message: error instanceof Error ? error.message : String(error),
    });
    return Response.json({ error: "Unable to process GitHub event." }, { status: 503 });
  }
}

// App uninstalls and suspensions kill installation tokens; surface that on the
// affected integrations so the settings UI prompts a reconnect.
async function handleInstallationEvent(db: DbLike, payload: Record<string, unknown>) {
  const action = typeof payload.action === "string" ? payload.action : "";
  if (action !== "deleted" && action !== "suspend") {
    return { ok: true, ignored: true };
  }
  const installationId = readInstallationId(payload);
  if (!installationId) return { ok: true, ignored: true };

  const integrations = await listGoatGitHubIntegrationsForInstallation(installationId, db);
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
      db,
    });
    marked += 1;
  }
  return { ok: true, marked };
}

async function handleActivityEvent(
  db: DbLike,
  eventName: string,
  payload: Record<string, unknown>,
  deliveryId: string,
) {
  let item: ReturnType<typeof normalizeGitHubActivityWebhook>;
  try {
    item = normalizeGitHubActivityWebhook(eventName, payload, {
      capturedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof BrainSourceNormalizationError) {
      logger.warn("Dropping malformed GitHub event", {
        event: "opencompany.github_webhook_malformed",
        event_name: eventName,
        code: error.code,
        error_message: error.message,
      });
      return { ok: true, dropped: true };
    }
    throw error;
  }
  if (!item) return { ok: true, ignored: true };

  const installationId = readInstallationId(payload);
  if (!installationId) return { ok: true, dropped: true };

  const integrations = await listGoatGitHubIntegrationsForInstallation(installationId, db);
  const connected = integrations.filter((integration) => integration.status === "connected");
  if (connected.length === 0) return { ok: true, dropped: true };

  const routes = await listEnabledGoatGitHubBrainSourceRoutes(
    connected.map((integration) => integration.id),
    db,
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
    const inserts: GoatGitHubPullRequestEventInsert[] = connected.flatMap((integration) => {
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
    const buffered = await insertGoatGitHubPullRequestEvents(inserts, db);
    return { ok: true, buffered };
  }

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
      db,
    });
    captureGoatIngestionQuotaAnalytics(result.quotaUpdates);
    enqueued += result.jobIds.length;
  }

  return { ok: true, enqueued };
}

function statusRedirect(
  session: Extract<IngressSession, { kind: "actor" }>,
  returnTo: string,
  status: "connected" | "error",
  reason?: string,
) {
  return sessionRedirect(
    session,
    new URL(appendGoatGitHubIntegrationStatus(returnTo, status, reason), getGoatAppUrl()),
  );
}

function readInstallationId(payload: Record<string, unknown>): string | null {
  const installation = payload.installation;
  if (!installation || typeof installation !== "object" || Array.isArray(installation)) return null;
  const id = (installation as Record<string, unknown>).id;
  if (typeof id !== "number" && typeof id !== "string") return null;
  return String(id);
}

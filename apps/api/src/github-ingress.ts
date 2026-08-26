import { createHash } from "node:crypto";
import { getAppUrl } from "@opencompany/agent/app-url";
import { captureIntegrationAddedAnalytics } from "@opencompany/agent/integrations/analytics";
import {
  appendGitHubIntegrationStatus,
  buildGitHubInstallUrl,
  buildGitHubUserAuthorizationUrl,
  createGitHubIntegrationState,
  exchangeGitHubUserCode,
  getGitHubInstallation,
  isGitHubIntegrationConfigured,
  listGitHubInstallationRepositories,
  syncGitHubIntegrationRepositories,
  verifyGitHubIntegrationState,
  verifyGitHubUserInstallation,
} from "@opencompany/agent/integrations/github";
import { verifyGitHubWebhookSignature } from "@opencompany/agent/integrations/github-signature";
import { captureProductIngestionQuotaAnalytics } from "@opencompany/analytics/product";
import {
  BrainSourceNormalizationError,
  githubActivityEventType,
  normalizeGitHubActivityWebhook,
} from "@opencompany/brain";
import {
  BRAIN_AGENT_INGEST_JOB_KIND,
  upsertBrainSourceItemAndEnqueue,
} from "@opencompany/db/brain-ingest";
import {
  type GitHubPullRequestEventInsert,
  gitHubEnabledEventTypes,
  gitHubSelectedRepoIds,
  insertGitHubPullRequestEvents,
  listEnabledGitHubBrainSourceRoutes,
  listEnabledGitHubWikiSourceRoutes,
  listGitHubIntegrationsForInstallation,
} from "@opencompany/db/github";
import { markIntegrationStatus } from "@opencompany/db/integrations";
import {
  attributeWikiSourceEventClaims,
  claimWikiSourceEvents,
} from "@opencompany/db/wiki-event-claims";
import { upsertWikiSourceItemAndEnqueue } from "@opencompany/db/wiki-ingest";
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
  wakeWikiIngest?: () => Promise<unknown>;
}): GitHubIngressService {
  const wakeWikiIngest = input.wakeWikiIngest
    ? () => {
        input.wakeWikiIngest?.().catch((error) => {
          logger.warn("Wiki ingest worker wake failed after GitHub enqueue", {
            event: "opencompany.github_wiki_ingest_wake_failed",
            error,
          });
        });
      }
    : undefined;
  return {
    start: (request) => handleStart(input, request),
    callback: (request) => handleCallback(input, request),
    webhook: (request) =>
      handleWebhook({ ...input, ...(wakeWikiIngest ? { wakeWikiIngest } : {}) }, request),
  };
}

type IngressInput = {
  db: DbLike;
  identify: ApiIdentityVerifier;
  wakeWikiIngest?: () => void;
};

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
  if (!isGitHubIntegrationConfigured()) {
    return statusRedirect(session, returnTo, "error", "not_configured");
  }

  const state = createGitHubIntegrationState({
    userWorkosId: session.userId,
    workspaceId: session.workspaceId,
    returnTo,
  });
  return sessionRedirect(session, buildGitHubInstallUrl(state));
}

async function handleCallback(input: IngressInput, request: Request): Promise<Response> {
  const session = await resolveIngressSession(input, request);
  if (session.kind === "redirect") return session.response;
  const url = new URL(request.url);
  const stateValue = url.searchParams.get("state") ?? "";

  let state: ReturnType<typeof verifyGitHubIntegrationState>;
  try {
    state = verifyGitHubIntegrationState(stateValue);
  } catch {
    return sessionRedirect(
      session,
      new URL("/settings?integration=github&setup=error&reason=invalid_state", getAppUrl()),
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

  if (!isGitHubIntegrationConfigured()) {
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
    const nextState = createGitHubIntegrationState({
      userWorkosId: state.userWorkosId,
      workspaceId: state.workspaceId,
      returnTo: state.returnTo,
      installationId,
    });
    return sessionRedirect(session, buildGitHubUserAuthorizationUrl(nextState));
  }

  try {
    const userToken = await exchangeGitHubUserCode(code);
    const verifiedInstallation = await verifyGitHubUserInstallation({
      userToken,
      installationId,
    });
    const installation = await getGitHubInstallation({ installationId });
    const repositories = await listGitHubInstallationRepositories({ installationId });

    await syncGitHubIntegrationRepositories(
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
    await captureIntegrationAddedAnalytics({
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
  const verified = verifyGitHubWebhookSignature({
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
    return Response.json(
      await handleActivityEvent(input.db, eventName, payload, deliveryId, input.wakeWikiIngest),
    );
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

  const integrations = await listGitHubIntegrationsForInstallation(installationId, db);
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
  wakeWikiIngest?: () => void,
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

  const integrations = await listGitHubIntegrationsForInstallation(installationId, db);
  const connected = integrations.filter((integration) => integration.status === "connected");
  if (connected.length === 0) return { ok: true, dropped: true };

  const integrationIds = connected.map((integration) => integration.id);
  const [brainRoutes, wikiRoutes] = await Promise.all([
    listEnabledGitHubBrainSourceRoutes(integrationIds, db),
    listEnabledGitHubWikiSourceRoutes(integrationIds, db),
  ]);
  const repoId = item.content.activity.repository.id;
  const eventType = githubActivityEventType(item.content.activity);
  const brainRefsByIntegration = new Map<string, string[]>();
  for (const route of brainRoutes) {
    if (!gitHubSelectedRepoIds(route.config).has(repoId)) continue;
    if (!gitHubEnabledEventTypes(route.config).has(eventType)) continue;
    const refs = brainRefsByIntegration.get(route.integrationId) ?? [];
    refs.push(route.brainRef);
    brainRefsByIntegration.set(route.integrationId, refs);
  }
  const wikiWorkspaceIdsByIntegration = new Map<string, string[]>();
  for (const route of wikiRoutes) {
    if (!gitHubSelectedRepoIds(route.config).has(repoId)) continue;
    if (!gitHubEnabledEventTypes(route.config).has(eventType)) continue;
    const workspaceIds = wikiWorkspaceIdsByIntegration.get(route.integrationId) ?? [];
    workspaceIds.push(route.workspaceId);
    wikiWorkspaceIdsByIntegration.set(route.integrationId, workspaceIds);
  }
  if (brainRefsByIntegration.size === 0 && wikiWorkspaceIdsByIntegration.size === 0) {
    return { ok: true, dropped: true };
  }

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
      const wikiWorkspaceIds = wikiWorkspaceIdsByIntegration.get(integration.id);
      if (
        (!brainRefs || brainRefs.length === 0) &&
        (!wikiWorkspaceIds || wikiWorkspaceIds.length === 0)
      ) {
        return [];
      }
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
    const buffered = await insertGitHubPullRequestEvents(inserts, db);
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
      kind: BRAIN_AGENT_INGEST_JOB_KIND,
      brainRefs,
      db,
    });
    captureProductIngestionQuotaAnalytics(result.quotaUpdates);
    enqueued += result.jobIds.length;
  }

  let wikiEnqueued = 0;
  const eventKey = `${installationId}:${item.sourceRef}:${deliveryId}`;
  for (const integration of connected) {
    const workspaceIds = wikiWorkspaceIdsByIntegration.get(integration.id);
    if (!workspaceIds || workspaceIds.length === 0) continue;
    for (const workspaceId of new Set(workspaceIds)) {
      const persist = async (tx: DbLike) => {
        const claim = await claimWikiSourceEvents({
          workspaceId,
          sourceProvider: "github",
          eventKeys: [eventKey],
          db: tx,
        });
        if (claim.claimedCount === 0) return null;

        const result = await upsertWikiSourceItemAndEnqueue({
          workspaceId,
          sourceConnectionId: integration.id,
          integrationId: integration.id,
          item,
          rawPayload: payload,
          db: tx,
        });
        await attributeWikiSourceEventClaims({
          workspaceId,
          sourceProvider: "github",
          eventKeys: claim.claimedEventKeys,
          sourceItemId: result.sourceItemId,
          db: tx,
        });
        return result;
      };
      const result =
        typeof db.transaction === "function"
          ? await db.transaction((tx: DbLike) => persist(tx))
          : await persist(db);
      if (result?.enqueued) wikiEnqueued += 1;
    }
  }
  if (wikiEnqueued > 0) wakeWikiIngest?.();

  return { ok: true, enqueued: enqueued + wikiEnqueued };
}

function statusRedirect(
  session: Extract<IngressSession, { kind: "actor" }>,
  returnTo: string,
  status: "connected" | "error",
  reason?: string,
) {
  return sessionRedirect(
    session,
    new URL(appendGitHubIntegrationStatus(returnTo, status, reason), getAppUrl()),
  );
}

function readInstallationId(payload: Record<string, unknown>): string | null {
  const installation = payload.installation;
  if (!installation || typeof installation !== "object" || Array.isArray(installation)) return null;
  const id = (installation as Record<string, unknown>).id;
  if (typeof id !== "number" && typeof id !== "string") return null;
  return String(id);
}

import { createHash } from "node:crypto";
import { getAppUrl } from "@opencompany/agent/app-url";
import { captureConnectionAddedAnalytics } from "@opencompany/agent/integrations/analytics";
import { ExpiringOAuthReauthRequired } from "@opencompany/agent/integrations/expiring-oauth-access-token";
import { verifyGitHubWebhookSignature } from "@opencompany/agent/integrations/github-signature";
import {
  appendGitHubUserIntegrationStatus,
  buildGitHubUserInstallUrl,
  createGitHubUserIntegrationState,
  exchangeGitHubAppUserCode,
  fetchGitHubUserIdentity,
  GitHubUserAccessAuthError,
  GitHubUserAccessRateLimitError,
  isGitHubUserIntegrationConfigured,
  listGitHubUserRepositoryAccess,
  resolveGitHubUserInstallTarget,
  verifyGitHubAppUserInstallation,
  verifyGitHubUserIntegrationState,
} from "@opencompany/agent/integrations/github-user";
import {
  GITHUB_PULL_REQUEST_OPENED_EVENT,
  githubPullRequestWorkflowEventContext,
  listGitHubUserIntegrationsForInstallation,
} from "@opencompany/db/github-user";
import { connectGitHubUserIntegration } from "@opencompany/db/integrations";
import {
  enqueueWorkflowEventRuns,
  listWorkflowEventTriggerRoutes,
} from "@opencompany/db/workflow-event-routes";
import { createLogger } from "@opencompany/observability";
import type { ApiIdentityVerifier } from "./auth";
import { ApiError, errorResponse } from "./errors";
import { type IngressSession, resolveIngressSession, sessionRedirect } from "./ingress-session";

const logger = createLogger({ service: "opencompany-api", runtime: "github-user-ingress" });

type DbLike = any;

export type GitHubUserIngressService = {
  start(request: Request): Promise<Response>;
  callback(request: Request): Promise<Response>;
  installations(request: Request, requestId: string): Promise<Response>;
  webhook(request: Request): Promise<Response>;
};

type RefreshPluginRegistrations = (input: {
  userWorkosId: string;
  workspaceIds: string[];
}) => Promise<void>;

type GitHubUserIngressInput = {
  db: DbLike;
  identify: ApiIdentityVerifier;
  refreshPluginRegistrations?: RefreshPluginRegistrations;
};

export function createGitHubUserIngress(input: GitHubUserIngressInput): GitHubUserIngressService {
  return {
    start: (request) => handleStart(input, request),
    callback: (request) => handleCallback(input, request),
    installations: (request, requestId) => handleInstallations(input, request, requestId),
    webhook: (request) => handleWebhook(input, request),
  };
}

type GitHubPullRequestWebhookEnvelope = {
  action?: unknown;
  installation?: { id?: unknown };
  pull_request?: Record<string, unknown>;
  repository?: Record<string, unknown>;
};

async function handleWebhook(input: GitHubUserIngressInput, request: Request): Promise<Response> {
  const rawBody = await request.text();
  if (
    !verifyGitHubWebhookSignature({
      rawBody,
      signature: request.headers.get("x-hub-signature-256"),
    })
  ) {
    return Response.json({ error: "Invalid GitHub signature." }, { status: 401 });
  }

  if (request.headers.get("x-github-event") !== "pull_request") {
    return Response.json({ ok: true, ignored: true });
  }

  let envelope: GitHubPullRequestWebhookEnvelope;
  try {
    envelope = JSON.parse(rawBody) as GitHubPullRequestWebhookEnvelope;
  } catch {
    return Response.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  try {
    return Response.json(await handlePullRequestEvent(input.db, envelope, request, rawBody));
  } catch (error) {
    logger.error("Failed to process GitHub pull request event", {
      event: "opencompany.github_pull_request_event_failed",
      action: typeof envelope.action === "string" ? envelope.action : null,
      error_message: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { error: "GitHub event processing failed; retry this delivery." },
      { status: 503 },
    );
  }
}

async function handlePullRequestEvent(
  db: DbLike,
  envelope: GitHubPullRequestWebhookEnvelope,
  request: Request,
  rawBody: string,
) {
  const action = githubReviewablePullRequestAction(envelope);
  if (!action) return { ok: true, ignored: true };

  const installationId = githubInstallationId(envelope.installation?.id);
  const pullRequest = envelope.pull_request;
  const repository = envelope.repository;
  if (!installationId || !pullRequest || !repository) return { ok: true, dropped: true };

  const integrations = await listGitHubUserIntegrationsForInstallation(installationId, db);
  if (integrations.length === 0) return { ok: true, dropped: true };

  const routes = (
    await listWorkflowEventTriggerRoutes({ provider: "github", integrations }, db)
  ).filter((route) => route.event === GITHUB_PULL_REQUEST_OPENED_EVENT);
  if (routes.length === 0) return { ok: true, workflowRuns: 0 };

  const deliveryId =
    request.headers.get("x-github-delivery")?.trim() ||
    createHash("sha256").update(rawBody).digest("hex");
  const workflowRuns = await enqueueWorkflowEventRuns(
    {
      routes,
      deliveryId,
      eventAt: githubPullRequestEventTime(pullRequest, action),
      context: githubPullRequestWorkflowEventContext(pullRequest, repository, action),
    },
    db,
  );
  return { ok: true, workflowRuns };
}

function githubReviewablePullRequestAction(
  envelope: GitHubPullRequestWebhookEnvelope,
): "opened" | "ready_for_review" | null {
  if (envelope.pull_request?.draft !== false) return null;
  return envelope.action === "opened" || envelope.action === "ready_for_review"
    ? envelope.action
    : null;
}

function githubInstallationId(value: unknown) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^\d+$/u.test(value)) return value;
  return null;
}

function githubPullRequestEventTime(
  pullRequest: Record<string, unknown>,
  action: "opened" | "ready_for_review",
) {
  const value = pullRequest[action === "opened" ? "created_at" : "updated_at"];
  if (typeof value !== "string") return new Date();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

async function handleStart(input: GitHubUserIngressInput, request: Request): Promise<Response> {
  const session = await resolveIngressSession(input, request);
  if (session.kind === "redirect") return session.response;
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") ?? "/settings";
  const owner = url.searchParams.get("owner")?.trim();

  if (!isGitHubUserIntegrationConfigured()) {
    return statusRedirect(session, returnTo, "error", "not_configured");
  }

  const state = createGitHubUserIntegrationState({
    userWorkosId: session.userId,
    returnTo,
  });
  let suggestedTargetId: string | undefined;
  if (owner) {
    try {
      suggestedTargetId = await resolveGitHubUserInstallTarget({
        userWorkosId: session.userId,
        owner,
        db: input.db,
        signal: request.signal,
      });
    } catch (error) {
      logger.warn("GitHub install target could not be resolved", {
        event: "opencompany.github_user_install_target_unavailable",
        error_message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return sessionRedirect(
    session,
    buildGitHubUserInstallUrl(state, suggestedTargetId ? { suggestedTargetId } : {}),
  );
}

async function handleInstallations(
  input: GitHubUserIngressInput,
  request: Request,
  requestId: string,
): Promise<Response> {
  const session = await resolveIngressSession(input, request);
  if (session.kind === "redirect") return session.response;
  const url = new URL(request.url);
  const owner = url.searchParams.get("owner")?.trim();
  const repo = url.searchParams.get("repo")?.trim();
  try {
    const access = await listGitHubUserRepositoryAccess({
      userWorkosId: session.userId,
      ...(owner ? { owner } : {}),
      ...(repo ? { repo } : {}),
      db: input.db,
      signal: request.signal,
    });
    return Response.json(access, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    const reconnectRequired =
      error instanceof GitHubUserAccessAuthError || error instanceof ExpiringOAuthReauthRequired;
    const rateLimited = error instanceof GitHubUserAccessRateLimitError;
    logger.warn("GitHub repository access lookup failed", {
      event: "opencompany.github_user_repository_access_failed",
      reconnect_required: reconnectRequired,
      rate_limited: rateLimited,
      error_message: error instanceof Error ? error.message : String(error),
    });
    const apiError = reconnectRequired
      ? new ApiError(
          409,
          "authentication_required",
          "Reconnect GitHub in Settings to inspect repository access.",
        )
      : rateLimited
        ? new ApiError(
            429,
            "rate_limited",
            "GitHub temporarily rate-limited the repository access check. Try again later.",
            true,
            error.retryAfterSeconds
              ? { "Retry-After": String(error.retryAfterSeconds) }
              : undefined,
          )
        : new ApiError(
            503,
            "unavailable",
            "GitHub repository access could not be checked. Try again.",
            true,
          );
    const response = errorResponse(apiError, requestId);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  }
}

async function handleCallback(input: GitHubUserIngressInput, request: Request): Promise<Response> {
  const session = await resolveIngressSession(input, request);
  if (session.kind === "redirect") return session.response;
  const url = new URL(request.url);
  const stateValue = url.searchParams.get("state") ?? "";

  let state: ReturnType<typeof verifyGitHubUserIntegrationState>;
  try {
    state = verifyGitHubUserIntegrationState(stateValue);
  } catch {
    return sessionRedirect(
      session,
      new URL("/settings?integration=github_user&setup=error&reason=invalid_state", getAppUrl()),
    );
  }

  if (state.userWorkosId !== session.userId) {
    return statusRedirect(session, state.returnTo, "error", "session_mismatch");
  }
  if (!isGitHubUserIntegrationConfigured()) {
    return statusRedirect(session, state.returnTo, "error", "not_configured");
  }
  if (url.searchParams.get("error")) {
    return statusRedirect(session, state.returnTo, "error", "github_user_denied");
  }
  const code = url.searchParams.get("code");
  if (!code) {
    return statusRedirect(session, state.returnTo, "error", "missing_code");
  }
  const installationId = url.searchParams.get("installation_id")?.trim();
  if (!installationId) {
    return statusRedirect(session, state.returnTo, "error", "missing_installation_id");
  }
  const setupAction = url.searchParams.get("setup_action");
  if (setupAction !== "install" && setupAction !== "update") {
    return statusRedirect(session, state.returnTo, "error", "invalid_installation_action");
  }

  try {
    const tokens = await exchangeGitHubAppUserCode(code);
    try {
      await verifyGitHubAppUserInstallation({
        accessToken: tokens.accessToken,
        installationId,
      });
    } catch (error) {
      logger.warn("GitHub App installation was not available to the authorized user", {
        event: "opencompany.github_user_installation_not_authorized",
        error_message: error instanceof Error ? error.message : String(error),
      });
      return statusRedirect(session, state.returnTo, "error", "installation_not_authorized");
    }
    const identity = await fetchGitHubUserIdentity(tokens.accessToken);
    const connection = await connectGitHubUserIntegration({
      userWorkosId: session.userId,
      githubUserId: identity.id,
      login: identity.login,
      name: identity.name,
      email: identity.email,
      installationId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
      tokenType: tokens.tokenType,
      db: input.db,
    });
    await captureConnectionAddedAnalytics({
      connectionId: connection.integrationId,
      userWorkosId: session.userId,
      workspaceId: session.workspaceId,
      provider: "github_user",
    });
    await refreshAfterConnection(input, session);
    return statusRedirect(session, state.returnTo, "connected");
  } catch (error) {
    logger.warn("GitHub user connection failed", {
      event: "opencompany.github_user_callback_failed",
      error_message: error instanceof Error ? error.message : String(error),
    });
    return statusRedirect(session, state.returnTo, "error", "connection_sync_failed");
  }
}

async function refreshAfterConnection(
  input: GitHubUserIngressInput,
  session: Extract<IngressSession, { kind: "actor" }>,
) {
  if (!input.refreshPluginRegistrations) return;
  try {
    await input.refreshPluginRegistrations({
      userWorkosId: session.userId,
      workspaceIds: session.workspaces.map((entry) => entry.workspace.id),
    });
  } catch (error) {
    logger.warn("Plugin discovery refresh after GitHub connection failed", {
      event: "opencompany.github_user_plugin_refresh_failed",
      error_message: error instanceof Error ? error.message : String(error),
    });
  }
}

function statusRedirect(
  session: Extract<IngressSession, { kind: "actor" }>,
  returnTo: string,
  status: "connected" | "error",
  reason?: string,
) {
  return sessionRedirect(
    session,
    new URL(appendGitHubUserIntegrationStatus(returnTo, status, reason), getAppUrl()),
  );
}

import { createHash } from "node:crypto";
import { connectGoatLinearIngestIntegration } from "@opencompany/db/goat-integrations";
import {
  type GoatLinearIssueEventInsert,
  goatLinearEventTypeFor,
  goatLinearRouteMatchesEvent,
  goatLinearSelectedTeamIds,
  insertGoatLinearIssueEvents,
  listEnabledGoatLinearBrainSourceRoutes,
  listGoatLinearIntegrationsForOrganization,
} from "@opencompany/db/goat-linear";
import type { GoatLinearEventAction, GoatLinearEventEntityType } from "@opencompany/db/goat-schema";
import { getGoatAppUrl } from "@opencompany/goat-agent/app-url";
import {
  appendGoatLinearIngestStatus,
  buildGoatLinearAuthorizationUrl,
  createGoatLinearIngestState,
  exchangeGoatLinearCode,
  fetchGoatLinearIdentity,
  isGoatLinearIngestConfigured,
  verifyGoatLinearIngestState,
} from "@opencompany/goat-agent/integrations/linear-ingest";
import { verifyGoatLinearWebhookSignature } from "@opencompany/goat-agent/integrations/linear-signature";
import { createLogger } from "@opencompany/observability";
import type { ApiIdentityVerifier } from "./auth";
import { type IngressSession, resolveIngressSession, sessionRedirect } from "./ingress-session";

const logger = createLogger({ service: "opencompany-api", runtime: "linear-ingress" });

type DbLike = any;

// Provider ingress composition for the Linear Brain-ingestion connection: the
// OAuth connect flow and the webhook that buffers issue/comment events for the
// runner's flush worker. The Linear MCP connector shares provider "linear" but
// keys on the linear_mcp sentinel and remains with the remote-MCP slice.
export type LinearIngressService = {
  start(request: Request): Promise<Response>;
  callback(request: Request): Promise<Response>;
  webhook(request: Request): Promise<Response>;
};

export function createLinearIngress(input: {
  db: DbLike;
  identify: ApiIdentityVerifier;
}): LinearIngressService {
  return {
    start: (request) => handleStart(input, request),
    callback: (request) => handleCallback(input, request),
    webhook: (request) => handleWebhook(input, request),
  };
}

type IngressInput = { db: DbLike; identify: ApiIdentityVerifier };

// Issue-update keys that carry no durable knowledge on their own. An update
// whose changed fields are all in this set (plus updatedAt, which Linear sends
// on every update) is board-reordering noise and is dropped.
const NOISE_UPDATED_FROM_KEYS = new Set([
  "updatedAt",
  "sortOrder",
  "boardOrder",
  "prioritySortOrder",
  "subIssueSortOrder",
  "reactionData",
]);

type LinearWebhookEnvelope = {
  action?: string;
  type?: string;
  createdAt?: string;
  organizationId?: string;
  webhookTimestamp?: number;
  webhookId?: string;
  url?: string;
  actor?: { id?: string; name?: string; type?: string };
  data?: Record<string, unknown>;
  updatedFrom?: Record<string, unknown>;
};

async function handleStart(input: IngressInput, request: Request): Promise<Response> {
  const session = await resolveIngressSession(input, request);
  if (session.kind === "redirect") return session.response;
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") ?? "/settings";

  if (!isGoatLinearIngestConfigured()) {
    return statusRedirect(session, returnTo, "error", "not_configured");
  }

  const state = createGoatLinearIngestState({
    userWorkosId: session.userId,
    returnTo,
  });
  return sessionRedirect(session, buildGoatLinearAuthorizationUrl(state));
}

async function handleCallback(input: IngressInput, request: Request): Promise<Response> {
  const session = await resolveIngressSession(input, request);
  if (session.kind === "redirect") return session.response;
  const url = new URL(request.url);
  const stateValue = url.searchParams.get("state") ?? "";

  let state: ReturnType<typeof verifyGoatLinearIngestState>;
  try {
    state = verifyGoatLinearIngestState(stateValue);
  } catch {
    return sessionRedirect(
      session,
      new URL("/settings?integration=linear&setup=error&reason=invalid_state", getGoatAppUrl()),
    );
  }

  if (state.userWorkosId !== session.userId) {
    return statusRedirect(session, state.returnTo, "error", "session_mismatch");
  }
  if (!isGoatLinearIngestConfigured()) {
    return statusRedirect(session, state.returnTo, "error", "not_configured");
  }
  if (url.searchParams.get("error")) {
    return statusRedirect(session, state.returnTo, "error", "linear_denied");
  }
  const code = url.searchParams.get("code");
  if (!code) {
    return statusRedirect(session, state.returnTo, "error", "missing_code");
  }

  try {
    const oauth = await exchangeGoatLinearCode(code);
    const identity = await fetchGoatLinearIdentity(oauth.accessToken);

    await connectGoatLinearIngestIntegration({
      userWorkosId: session.userId,
      organizationId: identity.organizationId,
      organizationName: identity.organizationName,
      organizationUrlKey: identity.organizationUrlKey,
      viewerId: identity.viewerId,
      viewerName: identity.viewerName,
      viewerEmail: identity.viewerEmail,
      accessToken: oauth.accessToken,
      scopes: oauth.scopes,
      db: input.db,
    });

    return statusRedirect(session, state.returnTo, "connected");
  } catch (error) {
    logger.warn("Linear ingest connection failed", {
      event: "goat.linear_ingest_callback_failed",
      error_message: error instanceof Error ? error.message : String(error),
    });
    return statusRedirect(session, state.returnTo, "error", "connection_sync_failed");
  }
}

async function handleWebhook(input: IngressInput, request: Request): Promise<Response> {
  const rawBody = await request.text();

  let envelope: LinearWebhookEnvelope;
  try {
    envelope = JSON.parse(rawBody) as LinearWebhookEnvelope;
  } catch {
    return Response.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const verified = verifyGoatLinearWebhookSignature({
    rawBody,
    signature: request.headers.get("linear-signature"),
    webhookTimestampMs:
      typeof envelope.webhookTimestamp === "number" ? envelope.webhookTimestamp : null,
  });
  if (!verified) {
    return Response.json({ error: "Invalid Linear signature." }, { status: 401 });
  }

  // Linear pauses webhooks for apps that keep failing, so after the signature
  // check every path acks with 200 — errors are logged, not surfaced.
  try {
    return Response.json(await handleLinearEvent(input.db, envelope, request, rawBody));
  } catch (error) {
    logger.error("Failed to process Linear event", {
      event: "goat.linear_event_failed",
      event_type: envelope.type,
      action: envelope.action,
      error_message: error instanceof Error ? error.message : String(error),
    });
  }

  return Response.json({ ok: true });
}

async function handleLinearEvent(
  db: DbLike,
  envelope: LinearWebhookEnvelope,
  request: Request,
  rawBody: string,
) {
  const organizationId = envelope.organizationId?.trim();
  const data = envelope.data;
  if (!organizationId || !data) return { ok: true, ignored: true };

  const entityType = linearEntityType(envelope.type);
  const action = linearEventAction(envelope.action);
  if (!entityType || !action) return { ok: true, ignored: true };
  // Comment deletions carry no durable knowledge.
  if (entityType === "comment" && action === "remove") return { ok: true, dropped: true };
  if (entityType === "issue" && action === "update" && isNoiseIssueUpdate(envelope.updatedFrom)) {
    return { ok: true, dropped: true };
  }
  const eventType = goatLinearEventTypeFor({
    entityType,
    action,
    updatedFrom: envelope.updatedFrom ?? null,
  });
  if (!eventType) return { ok: true, ignored: true };

  const issueId =
    entityType === "issue"
      ? asString(data.id)
      : (asString(data.issueId) ?? asString(asRecord(data.issue)?.id));
  if (!issueId) return { ok: true, dropped: true };

  const teamId =
    asString(data.teamId) ??
    asString(asRecord(data.team)?.id) ??
    asString(asRecord(data.issue)?.teamId);
  const issueTitle =
    entityType === "issue" ? asString(data.title) : asString(asRecord(data.issue)?.title);

  const integrations = await listGoatLinearIntegrationsForOrganization(organizationId, db);
  const connected = integrations.filter((integration) => integration.status === "connected");
  if (connected.length === 0) return { ok: true, dropped: true };

  const routes = await listEnabledGoatLinearBrainSourceRoutes(
    connected.map((integration) => integration.id),
    db,
  );
  // With a known team the selection is exact; comment events may not carry the
  // team, so any integration with a selection buffers and the flush worker
  // re-filters against the live issue's team.
  const matchedIntegrationIds = new Set(
    routes
      .filter((route) => {
        const selected = goatLinearSelectedTeamIds(route.config);
        if (selected.size === 0) return false;
        if (!goatLinearRouteMatchesEvent(route.config, eventType)) return false;
        return teamId ? selected.has(teamId) : true;
      })
      .map((route) => route.integrationId),
  );
  if (matchedIntegrationIds.size === 0) return { ok: true, dropped: true };

  const deliveryId =
    request.headers.get("linear-delivery")?.trim() ||
    (envelope.webhookId && envelope.webhookTimestamp
      ? `${envelope.webhookId}:${envelope.webhookTimestamp}`
      : createHash("sha256").update(rawBody).digest("hex"));
  const eventTime = envelope.createdAt ? new Date(envelope.createdAt) : new Date();

  const inserts: GoatLinearIssueEventInsert[] = connected
    .filter((integration) => matchedIntegrationIds.has(integration.id))
    .map((integration) => ({
      integrationId: integration.id,
      userWorkosId: integration.userWorkosId,
      organizationId,
      teamId: teamId ?? null,
      issueId,
      deliveryId,
      entityType,
      action,
      issueTitle: issueTitle ?? null,
      actorName: envelope.actor?.name?.trim() || null,
      payload: {
        action: envelope.action,
        type: envelope.type,
        createdAt: envelope.createdAt,
        url: envelope.url,
        actor: envelope.actor,
        data,
        ...(envelope.updatedFrom ? { updatedFrom: envelope.updatedFrom } : {}),
      },
      eventTime: Number.isNaN(eventTime.getTime()) ? new Date() : eventTime,
    }));

  const buffered = await insertGoatLinearIssueEvents(inserts, db);
  return { ok: true, buffered };
}

function linearEntityType(type: string | undefined): GoatLinearEventEntityType | null {
  if (type === "Issue") return "issue";
  if (type === "Comment") return "comment";
  return null;
}

function linearEventAction(action: string | undefined): GoatLinearEventAction | null {
  if (action === "create" || action === "update" || action === "remove") return action;
  return null;
}

function isNoiseIssueUpdate(updatedFrom: Record<string, unknown> | undefined) {
  if (!updatedFrom) return false;
  const keys = Object.keys(updatedFrom);
  return keys.length > 0 && keys.every((key) => NOISE_UPDATED_FROM_KEYS.has(key));
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function statusRedirect(
  session: Extract<IngressSession, { kind: "actor" }>,
  returnTo: string,
  status: "connected" | "error",
  reason?: string,
) {
  return sessionRedirect(
    session,
    new URL(appendGoatLinearIngestStatus(returnTo, status, reason), getGoatAppUrl()),
  );
}

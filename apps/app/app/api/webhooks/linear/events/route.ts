import { createHash } from "node:crypto";
import {
  type GoatLinearIssueEventInsert,
  goatLinearEventTypeFor,
  goatLinearRouteMatchesEvent,
  goatLinearSelectedTeamIds,
  insertGoatLinearIssueEvents,
  listEnabledGoatLinearBrainSourceRoutes,
  listGoatLinearIntegrationsForOrganization,
} from "@opencompany/db/linear";
import type { GoatLinearEventAction, GoatLinearEventEntityType } from "@opencompany/db/schema";
import { NextResponse } from "next/server";
import { verifyGoatLinearWebhookSignature } from "@/lib/integrations/linear-signature";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

export async function POST(request: Request) {
  const rawBody = await request.text();

  let envelope: LinearWebhookEnvelope;
  try {
    envelope = JSON.parse(rawBody) as LinearWebhookEnvelope;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const verified = verifyGoatLinearWebhookSignature({
    rawBody,
    signature: request.headers.get("linear-signature"),
    webhookTimestampMs:
      typeof envelope.webhookTimestamp === "number" ? envelope.webhookTimestamp : null,
  });
  if (!verified) {
    return NextResponse.json({ error: "Invalid Linear signature." }, { status: 401 });
  }

  // Linear pauses webhooks for apps that keep failing, so after the signature
  // check every path acks with 200 — errors are logged, not surfaced.
  try {
    return NextResponse.json(await handleLinearEvent(envelope, request, rawBody));
  } catch (error) {
    console.error("[goat-linear] Failed to process Linear event", {
      eventType: envelope.type,
      action: envelope.action,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return NextResponse.json({ ok: true });
}

async function handleLinearEvent(
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

  const integrations = await listGoatLinearIntegrationsForOrganization(organizationId);
  const connected = integrations.filter((integration) => integration.status === "connected");
  if (connected.length === 0) return { ok: true, dropped: true };

  const routes = await listEnabledGoatLinearBrainSourceRoutes(
    connected.map((integration) => integration.id),
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

  const buffered = await insertGoatLinearIssueEvents(inserts);
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

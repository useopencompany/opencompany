import { randomUUID } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import { markIntegrationStatus, saveIntegrationCredential } from "@opencompany/db/integrations";
import {
  POSTHOG_EVENTS_CREDENTIAL_KIND,
  POSTHOG_EVENTS_EXTERNAL_ID,
  POSTHOG_PROVIDER,
  resetPostHogEventSyncState,
} from "@opencompany/db/posthog-events";
import { integrations } from "@opencompany/db/product-schema";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import type { PostHogEventsProviderState } from "../integration-state";
import { captureConnectionAddedAnalytics } from "./analytics";

type DbLike = any;

export type PostHogRegion = "us" | "eu";

export type PostHogEventsCredentialPayload = {
  apiKey: string;
  projectId: string;
  region: PostHogRegion;
  createdAt: string;
};

export const POSTHOG_API_ORIGINS: Record<PostHogRegion, string> = {
  us: "https://us.posthog.com",
  eu: "https://eu.posthog.com",
};

export function isPostHogRegion(value: string): value is PostHogRegion {
  return value === "us" || value === "eu";
}

export function isValidPostHogApiKey(value: string) {
  return /^phx_[A-Za-z0-9_-]{10,4000}$/.test(value);
}

export function isValidPostHogProjectId(value: string) {
  return /^[1-9][0-9]{0,19}$/.test(value);
}

export function posthogProjectApiUrl(region: PostHogRegion, projectId: string, path: string) {
  if (!isValidPostHogProjectId(projectId) || !path.startsWith("/")) {
    throw new Error("Invalid PostHog project request.");
  }
  return `${POSTHOG_API_ORIGINS[region]}/api/projects/${projectId}${path}`;
}

export type PostHogConnectionValidation = { ok: true } | { ok: false; error: string };

export async function validatePostHogEventsConnection(input: {
  apiKey: string;
  projectId: string;
  region: PostHogRegion;
  signal?: AbortSignal;
}): Promise<PostHogConnectionValidation> {
  const timeout = AbortSignal.timeout(15_000);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  const requests: Array<[string, RequestInit]> = [
    [
      posthogProjectApiUrl(input.region, input.projectId, "/event_definitions/?limit=1"),
      { headers: { Authorization: `Bearer ${input.apiKey}` }, signal },
    ],
    [
      posthogProjectApiUrl(input.region, input.projectId, "/query/"),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: { kind: "HogQLQuery", query: "SELECT 1 LIMIT 1" } }),
        signal,
      },
    ],
  ];
  for (const [url, init] of requests) {
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      if (input.signal?.aborted) throw error;
      return { ok: false, error: "Could not reach PostHog. Try again in a moment." };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        error:
          "PostHog rejected this key. Use a personal API key with event definition read and query read access.",
      };
    }
    if (response.status === 404) {
      return { ok: false, error: "PostHog could not find that project in the selected region." };
    }
    if (!response.ok) {
      return { ok: false, error: `PostHog returned an unexpected error (${response.status}).` };
    }
  }
  return { ok: true };
}

export type PostHogEventDefinitionListResult =
  | { ok: true; events: Array<{ id: string; name: string }>; partial: boolean }
  | { ok: false; reason: "unauthorized" | "unavailable"; error: string };

const EVENT_DEFINITIONS_PAGE_LIMIT = 100;
const EVENT_DEFINITIONS_MAX_PAGES = 5;
const EVENT_NAME_MAX_LENGTH = 512;

export async function listPostHogEventDefinitions(input: {
  credential: PostHogEventsCredentialPayload;
  signal?: AbortSignal;
}): Promise<PostHogEventDefinitionListResult> {
  const events = new Map<string, { id: string; name: string }>();
  let offset = 0;
  for (let page = 0; page < EVENT_DEFINITIONS_MAX_PAGES; page += 1) {
    const path = `/event_definitions/?limit=${EVENT_DEFINITIONS_PAGE_LIMIT}&offset=${offset}&ordering=-last_seen_at`;
    let response: Response;
    try {
      const timeout = AbortSignal.timeout(15_000);
      response = await fetch(
        posthogProjectApiUrl(input.credential.region, input.credential.projectId, path),
        {
          headers: { Authorization: `Bearer ${input.credential.apiKey}` },
          signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
        },
      );
    } catch (error) {
      if (input.signal?.aborted) throw error;
      return { ok: false, reason: "unavailable", error: "Could not load PostHog events." };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        reason: "unauthorized",
        error: "PostHog rejected the saved personal API key.",
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        reason: "unavailable",
        error: `PostHog returned an unexpected error (${response.status}).`,
      };
    }
    let body: { results?: unknown[]; next?: unknown };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      return {
        ok: false,
        reason: "unavailable",
        error: "PostHog returned an unreadable event list.",
      };
    }
    const results = Array.isArray(body.results) ? body.results : [];
    for (const value of results) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const name = (value as Record<string, unknown>).name;
      if (typeof name === "string" && name.trim() && name.length <= EVENT_NAME_MAX_LENGTH) {
        events.set(name, { id: name, name });
      }
    }
    if (!body.next || results.length < EVENT_DEFINITIONS_PAGE_LIMIT) {
      return { ok: true, events: [...events.values()], partial: false };
    }
    offset += EVENT_DEFINITIONS_PAGE_LIMIT;
  }
  return { ok: true, events: [...events.values()], partial: true };
}

export async function connectPostHogEventsIntegration(input: {
  userWorkosId: string;
  apiKey: string;
  projectId: string;
  region: PostHogRegion;
  now?: Date;
  db?: DbLike;
}): Promise<{ integrationId: string }> {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const connectionLabel = `Project ${input.projectId} · ${input.region.toUpperCase()}`;
  const [integration] = await db
    .insert(integrations)
    .values({
      id: `gint_${randomUUID().replaceAll("-", "")}`,
      userWorkosId: input.userWorkosId,
      provider: POSTHOG_PROVIDER,
      externalId: POSTHOG_EVENTS_EXTERNAL_ID,
      accountName: `PostHog project ${input.projectId}`,
      connectionLabel,
      accountType: "posthog_events_api_key",
      status: "connected",
      statusReason: null,
      scopes: ["event_definition:read", "query:read"],
      lastSyncedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [integrations.userWorkosId, integrations.provider, integrations.externalId],
      targetWhere: sql`${integrations.workspaceId} IS NULL`,
      set: {
        accountName: `PostHog project ${input.projectId}`,
        connectionLabel,
        status: "connected",
        statusReason: null,
        scopes: ["event_definition:read", "query:read"],
        lastSyncedAt: now,
        updatedAt: now,
      },
    })
    .returning({ id: integrations.id });
  if (!integration) throw new Error("Could not persist the PostHog event connection.");

  try {
    await saveIntegrationCredential({
      userWorkosId: input.userWorkosId,
      integrationId: integration.id,
      provider: POSTHOG_PROVIDER,
      kind: POSTHOG_EVENTS_CREDENTIAL_KIND,
      payload: {
        apiKey: input.apiKey,
        projectId: input.projectId,
        region: input.region,
        createdAt: now.toISOString(),
      } satisfies PostHogEventsCredentialPayload,
      expiresAt: null,
      db,
      now,
    });
  } catch (error) {
    await markIntegrationStatus({
      userWorkosId: input.userWorkosId,
      integrationId: integration.id,
      provider: POSTHOG_PROVIDER,
      status: "sync_failed",
      statusReason: "Failed to save the PostHog personal API key.",
      db,
      now,
    });
    throw error;
  }
  await resetPostHogEventSyncState(
    { integrationId: integration.id, userWorkosId: input.userWorkosId, now },
    db,
  );
  await captureConnectionAddedAnalytics({
    connectionId: integration.id,
    userWorkosId: input.userWorkosId,
    provider: POSTHOG_PROVIDER,
  });
  return { integrationId: integration.id };
}

export async function getPostHogEventsIntegrationState(
  userWorkosId: string,
  db: DbLike = getDb(),
): Promise<PostHogEventsProviderState> {
  const [row] = await db
    .select({
      id: integrations.id,
      status: integrations.status,
      connectionLabel: integrations.connectionLabel,
      statusReason: integrations.statusReason,
    })
    .from(integrations)
    .where(
      and(
        eq(integrations.userWorkosId, userWorkosId),
        eq(integrations.provider, POSTHOG_PROVIDER),
        eq(integrations.externalId, POSTHOG_EVENTS_EXTERNAL_ID),
        ne(integrations.status, "disconnected"),
      ),
    )
    .orderBy(desc(integrations.updatedAt))
    .limit(1);
  if (!row) {
    return {
      provider: "posthog",
      connected: false,
      status: "not_connected",
      integrationId: null,
      projectId: null,
      region: null,
      connectionLabel: null,
      statusReason: null,
    };
  }
  const match = /^Project ([0-9]+) · (US|EU)$/.exec(row.connectionLabel ?? "");
  return {
    provider: "posthog",
    connected: row.status === "connected",
    status: row.status,
    integrationId: row.id,
    projectId: match?.[1] ?? null,
    region: match?.[2]?.toLowerCase() === "eu" ? "eu" : match ? "us" : null,
    connectionLabel: row.connectionLabel,
    statusReason: row.statusReason,
  };
}

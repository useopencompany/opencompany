import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import { goatIntegrations } from "@opencompany/db/schema";
import { and, desc, eq } from "drizzle-orm";
import type { GoatHubspotSourceProviderState } from "@/lib/integration-state";
import { getGoatAppUrl } from "@/lib/workos";

export type GoatHubspotIngestStatePayload = {
  userWorkosId: string;
  returnTo: string;
  expiresAt: number;
  nonce: string;
};

export type GoatHubspotOAuthResult = {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date | null;
};

export type GoatHubspotIdentity = {
  portalId: string;
  hubDomain: string | null;
  userEmail: string | null;
  scopes: string[];
};

const HUBSPOT_PROVIDER = "hubspot" as const;
const HUBSPOT_OAUTH_TOKEN_ENDPOINT = "https://api.hubapi.com/oauth/2026-03/token";
const HUBSPOT_OAUTH_INTROSPECT_ENDPOINT = "https://api.hubapi.com/oauth/2026-03/token/introspect";
const HUBSPOT_API_TIMEOUT_MS = 10_000;
const HUBSPOT_INGEST_ENVS = [
  "HUBSPOT_CLIENT_ID",
  "HUBSPOT_CLIENT_SECRET",
  "HUBSPOT_STATE_SECRET",
] as const;

// Read-only CRM scopes: the app reads contacts, companies, and deals to route
// and enrich ingestion. Writes never happen through this connection. The list
// must exactly match the scopes configured on the HubSpot app.
export const HUBSPOT_INGEST_SCOPES = [
  "crm.objects.contacts.read",
  "crm.objects.companies.read",
  "crm.objects.deals.read",
  "oauth",
] as const;

export function isGoatHubspotIngestConfigured() {
  return HUBSPOT_INGEST_ENVS.every((name) => Boolean(process.env[name]?.trim()));
}

// The HubSpot brain-source connection state for the acting user (most recently
// updated portal connection).
export async function getGoatHubspotSourceIntegrationState(
  userWorkosId: string,
): Promise<GoatHubspotSourceProviderState> {
  const [row] = await getDb()
    .select({
      id: goatIntegrations.id,
      status: goatIntegrations.status,
      accountEmail: goatIntegrations.accountEmail,
      connectionLabel: goatIntegrations.connectionLabel,
      statusReason: goatIntegrations.statusReason,
    })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.userWorkosId, userWorkosId),
        eq(goatIntegrations.provider, HUBSPOT_PROVIDER),
      ),
    )
    .orderBy(desc(goatIntegrations.updatedAt))
    .limit(1);

  if (!row || row.status === "disconnected") {
    return {
      provider: HUBSPOT_PROVIDER,
      connected: false,
      status: "not_connected",
      integrationId: null,
      accountEmail: null,
      hubDomain: null,
      statusReason: null,
    };
  }

  return {
    provider: HUBSPOT_PROVIDER,
    connected: row.status === "connected",
    status: row.status,
    integrationId: row.id,
    accountEmail: row.accountEmail,
    hubDomain: row.connectionLabel,
    statusReason: row.statusReason,
  };
}

export function createGoatHubspotIngestState(
  input: Omit<GoatHubspotIngestStatePayload, "expiresAt" | "nonce">,
) {
  const payload: GoatHubspotIngestStatePayload = {
    ...input,
    returnTo: sanitizeReturnTo(input.returnTo),
    expiresAt: Date.now() + 10 * 60 * 1000,
    nonce: randomUUID(),
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${signStateBody(body)}`;
}

export function verifyGoatHubspotIngestState(state: string): GoatHubspotIngestStatePayload {
  const [body, signature] = state.split(".");
  if (!body || !signature || !safeEqual(signature, signStateBody(body))) {
    throw new Error("Invalid HubSpot integration state.");
  }

  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
  if (!isGoatHubspotIngestStatePayload(payload)) {
    throw new Error("Invalid HubSpot integration state payload.");
  }
  if (payload.expiresAt < Date.now()) {
    throw new Error("HubSpot integration state expired.");
  }

  return {
    ...payload,
    returnTo: sanitizeReturnTo(payload.returnTo),
  };
}

export function buildGoatHubspotAuthorizationUrl(state: string) {
  const url = new URL("https://app.hubspot.com/oauth/authorize");
  url.searchParams.set("client_id", requiredEnv("HUBSPOT_CLIENT_ID"));
  url.searchParams.set("redirect_uri", goatHubspotIngestCallbackUrl());
  url.searchParams.set("scope", HUBSPOT_INGEST_SCOPES.join(" "));
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeGoatHubspotCode(code: string): Promise<GoatHubspotOAuthResult> {
  const response = await fetch(HUBSPOT_OAUTH_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(HUBSPOT_API_TIMEOUT_MS),
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: goatHubspotIngestCallbackUrl(),
      client_id: requiredEnv("HUBSPOT_CLIENT_ID"),
      client_secret: requiredEnv("HUBSPOT_CLIENT_SECRET"),
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(`HubSpot token exchange failed with ${response.status}.`);
  }

  const result = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  const accessToken = result.access_token?.trim();
  const refreshToken = result.refresh_token?.trim();
  if (!accessToken || !refreshToken) {
    throw new Error("HubSpot did not return access and refresh tokens.");
  }
  return {
    accessToken,
    refreshToken,
    expiresAt:
      typeof result.expires_in === "number"
        ? new Date(Date.now() + result.expires_in * 1000)
        : null,
  };
}

export async function fetchGoatHubspotIdentity(accessToken: string): Promise<GoatHubspotIdentity> {
  const response = await fetch(HUBSPOT_OAUTH_INTROSPECT_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(HUBSPOT_API_TIMEOUT_MS),
    body: new URLSearchParams({
      client_id: requiredEnv("HUBSPOT_CLIENT_ID"),
      client_secret: requiredEnv("HUBSPOT_CLIENT_SECRET"),
      token_type_hint: "access_token",
      token: accessToken,
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(`HubSpot token introspection failed with ${response.status}.`);
  }

  const result = (await response.json()) as {
    active?: boolean;
    hub_id?: number;
    hub_domain?: string;
    user?: string;
    scopes?: string[];
  };
  if (result.active !== true) {
    throw new Error("HubSpot returned an inactive access token.");
  }
  const hubId = result.hub_id;
  if (typeof hubId !== "number" || !Number.isFinite(hubId)) {
    throw new Error("HubSpot did not return the portal id.");
  }

  return {
    portalId: String(hubId),
    hubDomain: result.hub_domain?.trim() || null,
    userEmail: result.user?.trim() || null,
    scopes: Array.isArray(result.scopes) ? result.scopes.filter(Boolean) : [],
  };
}

export function appendGoatHubspotIngestStatus(
  returnTo: string,
  status: "connected" | "error",
  reason?: string,
) {
  const url = new URL(sanitizeReturnTo(returnTo), getGoatAppUrl());
  url.searchParams.set("integration", HUBSPOT_PROVIDER);
  url.searchParams.set("setup", status);
  if (status === "error" && reason) url.searchParams.set("reason", reason);
  return `${url.pathname}${url.search}`;
}

function goatHubspotIngestCallbackUrl() {
  return `${getGoatAppUrl()}/api/integrations/hubspot/callback`;
}

function isGoatHubspotIngestStatePayload(value: unknown): value is GoatHubspotIngestStatePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.userWorkosId === "string" &&
    typeof record.returnTo === "string" &&
    typeof record.expiresAt === "number" &&
    typeof record.nonce === "string"
  );
}

function sanitizeReturnTo(value: string) {
  if (!value.startsWith("/") || value.startsWith("//")) return "/settings";
  return value;
}

function signStateBody(body: string) {
  return createHmac("sha256", requiredEnv("HUBSPOT_STATE_SECRET")).update(body).digest("base64url");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for Goat HubSpot integration.`);
  return value;
}

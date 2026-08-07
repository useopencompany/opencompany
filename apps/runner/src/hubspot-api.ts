import {
  loadIntegrationCredential,
  markIntegrationStatus,
  refreshIntegrationCredential,
} from "@opencompany/db/integrations";
import type { HubspotObjectType } from "@opencompany/db/schema";
import { createLogger } from "@opencompany/observability";
import { getDb } from "./db";
import type { RunnerEnv } from "./env";

// Read-only HubSpot CRM helpers for the flush worker's prompt enrichment (live
// object snapshot with names and associations). Enrichment failures must never
// fail a flush: the worker falls back to the buffered webhook payloads.
//
// Unlike Linear, HubSpot access tokens are short-lived (~30 minutes); the
// stored refresh token rotates them through the same credential + status stack
// the Google integrations use, so needs_reauth marking behaves identically.

const logger = createLogger({ service: "opencompany-runner", runtime: "goat-hubspot-api" });

const TOKEN_ENDPOINT = "https://api.hubapi.com/oauth/2026-03/token";
const HUBSPOT_API_TIMEOUT_MS = 10_000;
const REFRESH_SKEW_MS = 60_000;
const SNAPSHOT_ASSOCIATION_LIMIT = 5;
const SNAPSHOT_PROPERTY_VALUE_MAX_CHARS = 2_000;

const OBJECT_TYPE_PLURAL: Record<HubspotObjectType, string> = {
  contact: "contacts",
  company: "companies",
  deal: "deals",
};

// HubSpot record-page object type ids (contact 0-1, company 0-2, deal 0-3).
const OBJECT_TYPE_URL_ID: Record<HubspotObjectType, string> = {
  contact: "0-1",
  company: "0-2",
  deal: "0-3",
};

const SNAPSHOT_PROPERTIES: Record<HubspotObjectType, readonly string[]> = {
  contact: [
    "firstname",
    "lastname",
    "email",
    "jobtitle",
    "phone",
    "company",
    "lifecyclestage",
    "hs_lead_status",
    "city",
    "country",
    "createdate",
    "hs_lastmodifieddate",
  ],
  company: [
    "name",
    "domain",
    "industry",
    "description",
    "numberofemployees",
    "annualrevenue",
    "lifecyclestage",
    "city",
    "country",
    "type",
    "createdate",
    "hs_lastmodifieddate",
  ],
  deal: [
    "dealname",
    "amount",
    "dealstage",
    "pipeline",
    "closedate",
    "dealtype",
    "description",
    "createdate",
    "hs_lastmodifieddate",
  ],
};

export type HubspotObjectSnapshot = {
  name: string | null;
  url: string;
  properties: Record<string, string>;
  lifecycleStage?: string;
  stage?: string;
  pipeline?: string;
  amount?: string;
  closeDate?: string;
  associatedCompanies?: string[];
  associatedContacts?: string[];
  createdAt?: string;
  updatedAt?: string;
};

type StoredHubspotTokens = {
  access_token?: string;
  refresh_token?: string;
};

export async function getHubspotAccessToken(input: {
  env: RunnerEnv;
  userWorkosId: string;
  integrationId: string;
  forceRefresh?: boolean;
}): Promise<string | null> {
  const credential = await loadIntegrationCredential({
    userWorkosId: input.userWorkosId,
    integrationId: input.integrationId,
    provider: "hubspot",
    kind: "oauth_token",
    db: getDb(),
  }).catch((error) => {
    logger.warn("HubSpot credential load failed", {
      event: "opencompany.goat_hubspot_credential_load_failed",
      integration_id: input.integrationId,
      error,
    });
    return null;
  });
  if (!credential) return null;

  const tokens = credential.payload as StoredHubspotTokens;
  const expired = credential.expiresAt
    ? credential.expiresAt.getTime() - REFRESH_SKEW_MS <= Date.now()
    : true;
  if (!input.forceRefresh && !expired && tokens.access_token) return tokens.access_token;
  if (!tokens.refresh_token) {
    await markHubspotNeedsReauth(input, "Stored HubSpot credentials have no refresh token.");
    return null;
  }

  return refreshHubspotAccessToken(input, tokens);
}

async function refreshHubspotAccessToken(
  input: { env: RunnerEnv; userWorkosId: string; integrationId: string },
  tokens: StoredHubspotTokens,
): Promise<string | null> {
  if (!input.env.hubspotOAuthClientId || !input.env.hubspotOAuthClientSecret) {
    logger.warn("HubSpot OAuth is not configured on the runner", {
      event: "opencompany.goat_hubspot_oauth_not_configured",
    });
    return null;
  }

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(HUBSPOT_API_TIMEOUT_MS),
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: input.env.hubspotOAuthClientId,
      client_secret: input.env.hubspotOAuthClientSecret,
      refresh_token: tokens.refresh_token ?? "",
    }).toString(),
  });

  if (!response.ok) {
    // 400 = HubSpot refused the refresh token (uninstalled app, revoked
    // grant); transient failures keep the credential untouched.
    if (response.status === 400) {
      await markHubspotNeedsReauth(input, "HubSpot refused the refresh token.");
      return null;
    }
    logger.warn("HubSpot token refresh failed", {
      event: "opencompany.goat_hubspot_token_refresh_failed",
      integration_id: input.integrationId,
      status: response.status,
    });
    return null;
  }

  const result = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!result.access_token) return null;

  await refreshIntegrationCredential({
    userWorkosId: input.userWorkosId,
    integrationId: input.integrationId,
    provider: "hubspot",
    kind: "oauth_token",
    payload: {
      access_token: result.access_token,
      refresh_token: result.refresh_token ?? tokens.refresh_token,
    },
    expiresAt:
      typeof result.expires_in === "number"
        ? new Date(Date.now() + result.expires_in * 1000)
        : null,
    db: getDb(),
  });

  return result.access_token;
}

async function markHubspotNeedsReauth(
  input: { userWorkosId: string; integrationId: string },
  reason: string,
) {
  await markIntegrationStatus({
    userWorkosId: input.userWorkosId,
    integrationId: input.integrationId,
    provider: "hubspot",
    status: "needs_reauth",
    statusReason: reason,
    db: getDb(),
  }).catch((error) => {
    logger.warn("HubSpot needs_reauth marking failed", {
      event: "opencompany.goat_hubspot_needs_reauth_mark_failed",
      integration_id: input.integrationId,
      error,
    });
  });
}

// Returns null when the object is gone or unreadable (deleted record, revoked
// token); the caller then normalizes from the buffered events instead.
export async function fetchHubspotObjectSnapshot(input: {
  token: string;
  portalId: string;
  objectType: HubspotObjectType;
  objectId: string;
}): Promise<HubspotObjectSnapshot | null> {
  try {
    const plural = OBJECT_TYPE_PLURAL[input.objectType];
    const url = new URL(
      `https://api.hubapi.com/crm/v3/objects/${plural}/${encodeURIComponent(input.objectId)}`,
    );
    url.searchParams.set("properties", SNAPSHOT_PROPERTIES[input.objectType].join(","));
    if (input.objectType === "deal") {
      url.searchParams.set("associations", "companies,contacts");
    }
    const record = (await hubspotApiRequest({ token: input.token, url: url.toString() })) as {
      properties?: Record<string, unknown>;
      associations?: Record<string, { results?: Array<{ id?: string }> }>;
      createdAt?: string;
      updatedAt?: string;
    } | null;
    if (!record) return null;

    const properties: Record<string, string> = {};
    for (const [key, value] of Object.entries(record.properties ?? {})) {
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      if (!trimmed) continue;
      properties[key] = trimmed.slice(0, SNAPSHOT_PROPERTY_VALUE_MAX_CHARS);
    }

    const associatedCompanies =
      input.objectType === "deal"
        ? await resolveAssociationNames({
            token: input.token,
            objectType: "company",
            ids: associationIds(record.associations, "companies"),
          })
        : undefined;
    const associatedContacts =
      input.objectType === "deal"
        ? await resolveAssociationNames({
            token: input.token,
            objectType: "contact",
            ids: associationIds(record.associations, "contacts"),
          })
        : undefined;

    return {
      name: snapshotName(input.objectType, properties),
      url: `https://app.hubspot.com/contacts/${input.portalId}/record/${OBJECT_TYPE_URL_ID[input.objectType]}/${input.objectId}`,
      properties,
      ...(properties.lifecyclestage ? { lifecycleStage: properties.lifecyclestage } : {}),
      ...(properties.dealstage ? { stage: properties.dealstage } : {}),
      ...(properties.pipeline ? { pipeline: properties.pipeline } : {}),
      ...(properties.amount ? { amount: properties.amount } : {}),
      ...(properties.closedate ? { closeDate: properties.closedate } : {}),
      ...(associatedCompanies && associatedCompanies.length > 0 ? { associatedCompanies } : {}),
      ...(associatedContacts && associatedContacts.length > 0 ? { associatedContacts } : {}),
      ...(record.createdAt ? { createdAt: record.createdAt } : {}),
      ...(record.updatedAt ? { updatedAt: record.updatedAt } : {}),
    };
  } catch (error) {
    logger.warn("HubSpot object snapshot fetch failed", {
      event: "opencompany.goat_hubspot_snapshot_failed",
      object_type: input.objectType,
      object_id: input.objectId,
      error,
    });
    return null;
  }
}

function associationIds(
  associations: Record<string, { results?: Array<{ id?: string }> }> | undefined,
  key: string,
): string[] {
  const results = associations?.[key]?.results ?? [];
  const ids: string[] = [];
  for (const entry of results) {
    if (typeof entry.id === "string" && entry.id && !ids.includes(entry.id)) ids.push(entry.id);
    if (ids.length >= SNAPSHOT_ASSOCIATION_LIMIT) break;
  }
  return ids;
}

async function resolveAssociationNames(input: {
  token: string;
  objectType: HubspotObjectType;
  ids: string[];
}): Promise<string[] | undefined> {
  if (input.ids.length === 0) return undefined;
  try {
    const plural = OBJECT_TYPE_PLURAL[input.objectType];
    const nameProperties =
      input.objectType === "company" ? ["name", "domain"] : ["firstname", "lastname", "email"];
    const result = (await hubspotApiRequest({
      token: input.token,
      url: `https://api.hubapi.com/crm/v3/objects/${plural}/batch/read`,
      method: "POST",
      body: {
        inputs: input.ids.map((id) => ({ id })),
        properties: nameProperties,
      },
    })) as { results?: Array<{ properties?: Record<string, unknown> }> } | null;
    const names = (result?.results ?? []).flatMap((entry) => {
      const properties: Record<string, string> = {};
      for (const [key, value] of Object.entries(entry.properties ?? {})) {
        if (typeof value === "string" && value.trim()) properties[key] = value.trim();
      }
      const name = snapshotName(input.objectType, properties);
      return name ? [name] : [];
    });
    return names.length > 0 ? names : undefined;
  } catch {
    // Association names are prompt garnish; the snapshot stands without them.
    return undefined;
  }
}

function snapshotName(
  objectType: HubspotObjectType,
  properties: Record<string, string>,
): string | null {
  if (objectType === "contact") {
    const fullName = [properties.firstname, properties.lastname].filter(Boolean).join(" ").trim();
    return fullName || properties.email || null;
  }
  if (objectType === "company") {
    return properties.name || properties.domain || null;
  }
  return properties.dealname || null;
}

async function hubspotApiRequest(input: {
  token: string;
  url: string;
  method?: string;
  body?: unknown;
}): Promise<unknown> {
  const response = await fetch(input.url, {
    method: input.method ?? "GET",
    headers: {
      Authorization: `Bearer ${input.token}`,
      ...(input.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    signal: AbortSignal.timeout(HUBSPOT_API_TIMEOUT_MS),
    ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`HubSpot API request failed with ${response.status}.`);
  }
  return await response.json();
}

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import { GOAT_LINEAR_MCP_EXTERNAL_ID } from "@opencompany/db/goat-linear";
import { goatIntegrations } from "@opencompany/db/goat-schema";
import { and, desc, eq, ne } from "drizzle-orm";
import { getGoatAppUrl } from "../app-url";
import type { GoatLinearSourceProviderState } from "../integration-state";

export type GoatLinearIngestStatePayload = {
  userWorkosId: string;
  returnTo: string;
  expiresAt: number;
  nonce: string;
};

export type GoatLinearOAuthResult = {
  accessToken: string;
  scopes: string[];
};

export type GoatLinearIdentity = {
  organizationId: string;
  organizationName: string | null;
  organizationUrlKey: string | null;
  viewerId: string | null;
  viewerName: string | null;
  viewerEmail: string | null;
};

const LINEAR_PROVIDER = "linear" as const;
const GOAT_LINEAR_INGEST_ENVS = [
  "GOAT_LINEAR_CLIENT_ID",
  "GOAT_LINEAR_CLIENT_SECRET",
  "GOAT_LINEAR_WEBHOOK_SECRET",
  "GOAT_LINEAR_STATE_SECRET",
] as const;

// Read-only scope: the app reads issues, comments, and teams to route and
// enrich ingestion. Writes never happen through this connection.
export const GOAT_LINEAR_INGEST_SCOPES = ["read"] as const;

export function isGoatLinearIngestConfigured() {
  return GOAT_LINEAR_INGEST_ENVS.every((name) => Boolean(process.env[name]?.trim()));
}

// The ingestion connection only; the Linear MCP connector shares provider
// "linear" but keys external_id on the "linear_mcp" sentinel and is excluded.
export async function getGoatLinearSourceIntegrationState(
  userWorkosId: string,
): Promise<GoatLinearSourceProviderState> {
  const [row] = await getDb()
    .select({
      id: goatIntegrations.id,
      status: goatIntegrations.status,
      accountName: goatIntegrations.accountName,
      connectionLabel: goatIntegrations.connectionLabel,
      statusReason: goatIntegrations.statusReason,
    })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.userWorkosId, userWorkosId),
        eq(goatIntegrations.provider, LINEAR_PROVIDER),
        ne(goatIntegrations.externalId, GOAT_LINEAR_MCP_EXTERNAL_ID),
      ),
    )
    .orderBy(desc(goatIntegrations.updatedAt))
    .limit(1);

  if (!row || row.status === "disconnected") {
    return {
      provider: LINEAR_PROVIDER,
      connected: false,
      status: "not_connected",
      integrationId: null,
      accountName: null,
      organizationName: null,
      statusReason: null,
    };
  }

  return {
    provider: LINEAR_PROVIDER,
    connected: row.status === "connected",
    status: row.status,
    integrationId: row.id,
    accountName: row.accountName,
    organizationName: row.connectionLabel,
    statusReason: row.statusReason,
  };
}

export function createGoatLinearIngestState(
  input: Omit<GoatLinearIngestStatePayload, "expiresAt" | "nonce">,
) {
  const payload: GoatLinearIngestStatePayload = {
    ...input,
    returnTo: sanitizeReturnTo(input.returnTo),
    expiresAt: Date.now() + 10 * 60 * 1000,
    nonce: randomUUID(),
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${signStateBody(body)}`;
}

export function verifyGoatLinearIngestState(state: string): GoatLinearIngestStatePayload {
  const [body, signature] = state.split(".");
  if (!body || !signature || !safeEqual(signature, signStateBody(body))) {
    throw new Error("Invalid Linear integration state.");
  }

  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
  if (!isGoatLinearIngestStatePayload(payload)) {
    throw new Error("Invalid Linear integration state payload.");
  }
  if (payload.expiresAt < Date.now()) {
    throw new Error("Linear integration state expired.");
  }

  return {
    ...payload,
    returnTo: sanitizeReturnTo(payload.returnTo),
  };
}

export function buildGoatLinearAuthorizationUrl(state: string) {
  const url = new URL("https://linear.app/oauth/authorize");
  url.searchParams.set("client_id", requiredEnv("GOAT_LINEAR_CLIENT_ID"));
  url.searchParams.set("redirect_uri", goatLinearIngestCallbackUrl());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOAT_LINEAR_INGEST_SCOPES.join(","));
  url.searchParams.set("state", state);
  url.searchParams.set("actor", "user");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

export async function exchangeGoatLinearCode(code: string): Promise<GoatLinearOAuthResult> {
  const response = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: goatLinearIngestCallbackUrl(),
      client_id: requiredEnv("GOAT_LINEAR_CLIENT_ID"),
      client_secret: requiredEnv("GOAT_LINEAR_CLIENT_SECRET"),
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(`Linear token exchange failed with ${response.status}.`);
  }

  const result = (await response.json()) as { access_token?: string; scope?: string };
  const accessToken = result.access_token?.trim();
  if (!accessToken) {
    throw new Error("Linear did not return an access token.");
  }
  return {
    accessToken,
    scopes: (result.scope ?? "").split(/[\s,]+/).filter(Boolean),
  };
}

export async function fetchGoatLinearIdentity(accessToken: string): Promise<GoatLinearIdentity> {
  const data = await linearGraphqlRequest<{
    viewer?: { id?: string; name?: string; displayName?: string; email?: string };
    organization?: { id?: string; name?: string; urlKey?: string };
  }>({
    token: accessToken,
    query: `query GoatLinearIdentity {
      viewer { id name displayName email }
      organization { id name urlKey }
    }`,
  });

  const organizationId = data.organization?.id?.trim();
  if (!organizationId) {
    throw new Error("Linear did not return the workspace organization.");
  }

  return {
    organizationId,
    organizationName: data.organization?.name?.trim() || null,
    organizationUrlKey: data.organization?.urlKey?.trim() || null,
    viewerId: data.viewer?.id?.trim() || null,
    viewerName: data.viewer?.name?.trim() || data.viewer?.displayName?.trim() || null,
    viewerEmail: data.viewer?.email?.trim() || null,
  };
}

export function appendGoatLinearIngestStatus(
  returnTo: string,
  status: "connected" | "error",
  reason?: string,
) {
  const url = new URL(sanitizeReturnTo(returnTo), getGoatAppUrl());
  url.searchParams.set("integration", LINEAR_PROVIDER);
  url.searchParams.set("setup", status);
  if (status === "error" && reason) url.searchParams.set("reason", reason);
  return `${url.pathname}${url.search}`;
}

export async function linearGraphqlRequest<T>(input: {
  token: string;
  query: string;
  variables?: Record<string, unknown>;
}): Promise<T> {
  const response = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.token}`,
    },
    body: JSON.stringify({
      query: input.query,
      ...(input.variables ? { variables: input.variables } : {}),
    }),
  });
  if (!response.ok) {
    throw new Error(`Linear GraphQL request failed with ${response.status}.`);
  }

  const result = (await response.json()) as {
    data?: T;
    errors?: Array<{ message?: string }>;
  };
  if (result.errors && result.errors.length > 0) {
    throw new Error(`Linear GraphQL returned ${result.errors[0]?.message ?? "an unknown error"}.`);
  }
  if (!result.data) {
    throw new Error("Linear GraphQL returned no data.");
  }
  return result.data;
}

function goatLinearIngestCallbackUrl() {
  return `${getGoatAppUrl()}/api/integrations/linear-ingest/callback`;
}

function isGoatLinearIngestStatePayload(value: unknown): value is GoatLinearIngestStatePayload {
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
  return createHmac("sha256", requiredEnv("GOAT_LINEAR_STATE_SECRET"))
    .update(body)
    .digest("base64url");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for Goat Linear integration.`);
  return value;
}

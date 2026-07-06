import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  auth,
  type OAuthClientInformation,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthTokens,
} from "@ai-sdk/mcp";
import { getDb } from "@opencompany/db/client";
import {
  loadGoatIntegrationCredential,
  saveGoatIntegrationCredential,
} from "@opencompany/db/goat-integrations";
import { goatIntegrations } from "@opencompany/db/goat-schema";
import { and, desc, eq } from "drizzle-orm";
import { getGoatAppUrl } from "@/lib/workos";

export const GOAT_LINEAR_MCP_ENDPOINT_URL = "https://mcp.linear.app/mcp";
const GOAT_LINEAR_PROVIDER = "linear" as const;
const GOAT_LINEAR_CREDENTIAL_KIND = "oauth_token" as const;
const LINEAR_EXTERNAL_ID = "linear_mcp";
const STATE_TTL_MS = 10 * 60 * 1000;

export type GoatLinearProviderState = {
  provider: typeof GOAT_LINEAR_PROVIDER;
  connected: boolean;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected" | "not_connected";
  accountName: string | null;
  statusReason: string | null;
};

type GoatLinearOAuthPayload = {
  clientInformation?: OAuthClientInformation;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  state?: string;
};

type GoatLinearState = {
  userWorkosId: string;
  integrationId: string;
  returnTo: string;
  expiresAt: number;
  nonce: string;
};

export async function getGoatLinearIntegrationState(
  userWorkosId: string,
): Promise<GoatLinearProviderState> {
  const [row] = await getDb()
    .select({
      status: goatIntegrations.status,
      accountName: goatIntegrations.accountName,
      statusReason: goatIntegrations.statusReason,
    })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.userWorkosId, userWorkosId),
        eq(goatIntegrations.provider, GOAT_LINEAR_PROVIDER),
      ),
    )
    .orderBy(desc(goatIntegrations.updatedAt))
    .limit(1);

  if (!row || row.status === "disconnected") {
    return {
      provider: GOAT_LINEAR_PROVIDER,
      connected: false,
      status: "not_connected",
      accountName: null,
      statusReason: null,
    };
  }

  return {
    provider: GOAT_LINEAR_PROVIDER,
    connected: row.status === "connected",
    status: row.status,
    accountName: row.accountName,
    statusReason: row.statusReason,
  };
}

export async function startGoatLinearMcpOAuth(input: { userWorkosId: string; returnTo: string }) {
  const integration = await upsertGoatLinearIntegration({
    userWorkosId: input.userWorkosId,
    status: "needs_reauth",
    statusReason: "Linear MCP authorization started.",
  });
  const state = createState({
    userWorkosId: input.userWorkosId,
    integrationId: integration.id,
    returnTo: input.returnTo,
  });
  let authorizationUrl: string | null = null;

  const provider = createLinearClientProvider({
    userWorkosId: input.userWorkosId,
    integrationId: integration.id,
    payload: await loadLinearPayload({
      userWorkosId: input.userWorkosId,
      integrationId: integration.id,
    }),
    state,
    onAuthorizationUrl: (url) => {
      authorizationUrl = url.toString();
    },
  });

  const result = await auth(provider, { serverUrl: GOAT_LINEAR_MCP_ENDPOINT_URL });
  if (result === "AUTHORIZED") {
    await markGoatLinearConnected(integration.id, input.userWorkosId);
    return { status: "connected" as const, redirectUrl: null };
  }
  if (!authorizationUrl) {
    throw new Error("Linear did not return an MCP authorization URL.");
  }
  return { status: "redirect" as const, redirectUrl: authorizationUrl };
}

export async function completeGoatLinearMcpOAuth(input: {
  userWorkosId: string;
  integrationId: string;
  code: string;
  state: string;
}) {
  const provider = createLinearClientProvider({
    userWorkosId: input.userWorkosId,
    integrationId: input.integrationId,
    payload: await loadLinearPayload(input),
  });

  const result = await auth(provider, {
    serverUrl: GOAT_LINEAR_MCP_ENDPOINT_URL,
    authorizationCode: input.code,
    callbackState: input.state,
  });
  if (result !== "AUTHORIZED") {
    throw new Error("Linear MCP authorization was not completed.");
  }

  await markGoatLinearConnected(input.integrationId, input.userWorkosId);
}

export function verifyGoatLinearMcpState(state: string): GoatLinearState {
  const [body, signature] = state.split(".");
  if (!body || !signature || !safeEqual(signature, signStateBody(body))) {
    throw new Error("Invalid Linear MCP state.");
  }

  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
  if (!isGoatLinearState(payload)) throw new Error("Invalid Linear MCP state payload.");
  if (payload.expiresAt < Date.now()) throw new Error("Linear MCP state expired.");

  return { ...payload, returnTo: sanitizeReturnTo(payload.returnTo) };
}

export function appendGoatLinearMcpStatus(
  returnTo: string,
  status: "connected" | "error",
  reason?: string,
) {
  const url = new URL(sanitizeReturnTo(returnTo), getGoatAppUrl());
  url.searchParams.set("integration", GOAT_LINEAR_PROVIDER);
  url.searchParams.set("setup", status);
  if (status === "error" && reason) url.searchParams.set("reason", reason);
  return `${url.pathname}${url.search}`;
}

function createState(input: Omit<GoatLinearState, "expiresAt" | "nonce">) {
  const payload: GoatLinearState = {
    ...input,
    returnTo: sanitizeReturnTo(input.returnTo),
    expiresAt: Date.now() + STATE_TTL_MS,
    nonce: randomUUID(),
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${signStateBody(body)}`;
}

async function upsertGoatLinearIntegration(input: {
  userWorkosId: string;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected";
  statusReason: string | null;
}) {
  const now = new Date();
  const [integration] = await getDb()
    .insert(goatIntegrations)
    .values({
      id: `gint_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      userWorkosId: input.userWorkosId,
      provider: GOAT_LINEAR_PROVIDER,
      externalId: LINEAR_EXTERNAL_ID,
      connectionLabel: "Linear",
      accountName: "Linear",
      accountType: "mcp_server",
      status: input.status,
      statusReason: input.statusReason,
      scopes: [],
      lastSyncedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        goatIntegrations.userWorkosId,
        goatIntegrations.provider,
        goatIntegrations.externalId,
      ],
      set: {
        connectionLabel: "Linear",
        accountName: "Linear",
        accountType: "mcp_server",
        status: input.status,
        statusReason: input.statusReason,
        lastSyncedAt: now,
        updatedAt: now,
      },
    })
    .returning({ id: goatIntegrations.id });

  if (!integration) throw new Error("Could not persist Goat Linear integration.");
  return integration;
}

async function markGoatLinearConnected(integrationId: string, userWorkosId: string) {
  await getDb()
    .update(goatIntegrations)
    .set({
      status: "connected",
      statusReason: null,
      connectionLabel: "Linear",
      accountName: "Linear",
      accountType: "mcp_server",
      lastSyncedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(goatIntegrations.id, integrationId),
        eq(goatIntegrations.userWorkosId, userWorkosId),
        eq(goatIntegrations.provider, GOAT_LINEAR_PROVIDER),
      ),
    );
}

async function loadLinearPayload(input: { userWorkosId: string; integrationId: string }) {
  const credential = await loadGoatIntegrationCredential({
    userWorkosId: input.userWorkosId,
    integrationId: input.integrationId,
    provider: GOAT_LINEAR_PROVIDER,
    kind: GOAT_LINEAR_CREDENTIAL_KIND,
  });
  return credential ? parsePayload(credential.payload) : {};
}

function createLinearClientProvider(input: {
  userWorkosId: string;
  integrationId: string;
  payload: GoatLinearOAuthPayload;
  state?: string;
  onAuthorizationUrl?: (url: URL) => void;
}): OAuthClientProvider {
  let payload = input.payload;

  async function persist(next: GoatLinearOAuthPayload) {
    payload = next;
    await saveGoatIntegrationCredential({
      userWorkosId: input.userWorkosId,
      integrationId: input.integrationId,
      provider: GOAT_LINEAR_PROVIDER,
      kind: GOAT_LINEAR_CREDENTIAL_KIND,
      payload: { ...next },
    });
  }

  return {
    get redirectUrl() {
      return `${getGoatAppUrl()}/api/integrations/linear/callback`;
    },
    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: "OpenCompany Goat",
        redirect_uris: [`${getGoatAppUrl()}/api/integrations/linear/callback`],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      };
    },
    clientInformation: () => payload.clientInformation,
    saveClientInformation: async (clientInformation) => {
      await persist({ ...payload, clientInformation });
    },
    tokens: () => payload.tokens,
    saveTokens: async (tokens) => {
      await persist({ ...payload, tokens });
    },
    state: () => input.state ?? payload.state ?? "",
    saveState: async (state) => {
      await persist({ ...payload, state });
    },
    storedState: () => payload.state,
    saveCodeVerifier: async (codeVerifier) => {
      await persist({ ...payload, codeVerifier });
    },
    codeVerifier: () => {
      if (!payload.codeVerifier) throw new Error("Linear MCP OAuth verifier is missing.");
      return payload.codeVerifier;
    },
    redirectToAuthorization: (authorizationUrl) => {
      input.onAuthorizationUrl?.(authorizationUrl);
    },
    invalidateCredentials: async (scope) => {
      if (scope === "all") {
        await persist({});
      } else if (scope === "tokens") {
        await persist(omitPayload(payload, ["tokens"]));
      } else if (scope === "verifier") {
        await persist(omitPayload(payload, ["codeVerifier", "state"]));
      } else if (scope === "client") {
        await persist(omitPayload(payload, ["clientInformation"]));
      }
    },
  };
}

function parsePayload(value: Record<string, unknown>): GoatLinearOAuthPayload {
  const payload: GoatLinearOAuthPayload = {};
  if (isOAuthClientInformation(value.clientInformation)) {
    payload.clientInformation = value.clientInformation;
  }
  if (isOAuthTokens(value.tokens)) payload.tokens = value.tokens;
  if (typeof value.codeVerifier === "string") payload.codeVerifier = value.codeVerifier;
  if (typeof value.state === "string") payload.state = value.state;
  return payload;
}

function omitPayload<TKey extends keyof GoatLinearOAuthPayload>(
  payload: GoatLinearOAuthPayload,
  keys: TKey[],
) {
  const next = { ...payload };
  for (const key of keys) delete next[key];
  return next;
}

function sanitizeReturnTo(value: string) {
  if (!value.startsWith("/") || value.startsWith("//")) return "/settings";
  return value;
}

function signStateBody(body: string) {
  return createHmac("sha256", requiredEnv("MCP_OAUTH_STATE_SECRET"))
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
  if (!value) throw new Error(`${name} is required for Linear MCP OAuth.`);
  return value;
}

function isGoatLinearState(value: unknown): value is GoatLinearState {
  if (!isRecord(value)) return false;
  return (
    typeof value.userWorkosId === "string" &&
    typeof value.integrationId === "string" &&
    typeof value.returnTo === "string" &&
    typeof value.expiresAt === "number" &&
    typeof value.nonce === "string"
  );
}

function isOAuthClientInformation(value: unknown): value is OAuthClientInformation {
  if (!isRecord(value) || typeof value.client_id !== "string") return false;
  return value.client_secret === undefined || typeof value.client_secret === "string";
}

function isOAuthTokens(value: unknown): value is OAuthTokens {
  if (!isRecord(value)) return false;
  return (
    typeof value.access_token === "string" &&
    typeof value.token_type === "string" &&
    (value.expires_in === undefined || typeof value.expires_in === "number") &&
    (value.scope === undefined || typeof value.scope === "string") &&
    (value.refresh_token === undefined || typeof value.refresh_token === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

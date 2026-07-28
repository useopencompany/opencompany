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
import {
  type GoatIntegrationProvider,
  type GoatIntegrationStatus,
  goatIntegrations,
} from "@opencompany/db/goat-schema";
import { and, desc, eq, sql } from "drizzle-orm";
import { getGoatAppUrl } from "../app-url";
import { captureGoatIntegrationAddedAnalytics } from "./analytics";

const STATE_TTL_MS = 10 * 60 * 1000;
const CREDENTIAL_KIND = "oauth_token" as const;

export type GoatRemoteMcpProviderState<TProvider extends GoatIntegrationProvider> = {
  provider: TProvider;
  connected: boolean;
  status: GoatIntegrationStatus | "not_connected";
  integrationId: string | null;
  accountName: string | null;
  statusReason: string | null;
  capabilityModes: Record<string, unknown>;
};

type GoatRemoteMcpOAuthPayload = {
  clientInformation?: OAuthClientInformation;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  state?: string;
};

type GoatRemoteMcpState = {
  provider?: GoatIntegrationProvider;
  userWorkosId: string;
  integrationId: string;
  returnTo: string;
  expiresAt: number;
  nonce: string;
};

type GoatRemoteMcpIntegrationConfig<TProvider extends GoatIntegrationProvider> = {
  provider: TProvider;
  displayName: string;
  endpointUrl: string;
  externalId: string;
  storedScopes: readonly string[];
  authScope?: string;
  acceptLegacyStateWithoutProvider?: boolean;
};

export function createGoatRemoteMcpIntegration<const TProvider extends GoatIntegrationProvider>(
  config: GoatRemoteMcpIntegrationConfig<TProvider>,
) {
  const callbackUrl = () =>
    `${getGoatAppUrl()}/api/integrations/${config.provider.replaceAll("_", "-")}/callback`;

  async function getState(userWorkosId: string): Promise<GoatRemoteMcpProviderState<TProvider>> {
    const [row] = await getDb()
      .select({
        id: goatIntegrations.id,
        status: goatIntegrations.status,
        accountName: goatIntegrations.accountName,
        statusReason: goatIntegrations.statusReason,
        capabilityModes: goatIntegrations.capabilityModes,
      })
      .from(goatIntegrations)
      .where(
        and(
          eq(goatIntegrations.userWorkosId, userWorkosId),
          eq(goatIntegrations.provider, config.provider),
          eq(goatIntegrations.externalId, config.externalId),
        ),
      )
      .orderBy(desc(goatIntegrations.updatedAt))
      .limit(1);

    if (!row || row.status === "disconnected") {
      return {
        provider: config.provider,
        connected: false,
        status: "not_connected",
        integrationId: null,
        accountName: null,
        statusReason: null,
        capabilityModes: {},
      };
    }

    return {
      provider: config.provider,
      connected: row.status === "connected",
      status: row.status,
      integrationId: row.id,
      accountName: row.accountName,
      statusReason: row.statusReason,
      capabilityModes: row.capabilityModes,
    };
  }

  async function loadWorkerConnection(input: {
    userWorkosId: string;
    onAuthorizationRequired: () => never;
  }): Promise<
    | { ok: false; reason: "not_connected" | "needs_reauth" }
    | { ok: true; integrationId: string; authProvider: OAuthClientProvider }
  > {
    const [row] = await getDb()
      .select({ id: goatIntegrations.id, status: goatIntegrations.status })
      .from(goatIntegrations)
      .where(
        and(
          eq(goatIntegrations.userWorkosId, input.userWorkosId),
          eq(goatIntegrations.provider, config.provider),
          eq(goatIntegrations.externalId, config.externalId),
        ),
      )
      .orderBy(desc(goatIntegrations.updatedAt))
      .limit(1);

    if (!row || row.status !== "connected") return { ok: false, reason: "not_connected" };

    const payload = await loadPayload({
      userWorkosId: input.userWorkosId,
      integrationId: row.id,
    });
    if (!payload.clientInformation || !payload.tokens) {
      return { ok: false, reason: "needs_reauth" };
    }

    return {
      ok: true,
      integrationId: row.id,
      authProvider: createClientProvider({
        userWorkosId: input.userWorkosId,
        integrationId: row.id,
        payload,
        onAuthorizationUrl: () => input.onAuthorizationRequired(),
      }),
    };
  }

  async function start(input: { userWorkosId: string; returnTo: string }) {
    const integration = await upsertIntegration({
      userWorkosId: input.userWorkosId,
      status: "needs_reauth",
      statusReason: `${config.displayName} MCP authorization started.`,
    });
    const state = createState({
      provider: config.provider,
      userWorkosId: input.userWorkosId,
      integrationId: integration.id,
      returnTo: input.returnTo,
    });
    let authorizationUrl: string | null = null;

    const provider = createClientProvider({
      userWorkosId: input.userWorkosId,
      integrationId: integration.id,
      payload: await loadPayload({
        userWorkosId: input.userWorkosId,
        integrationId: integration.id,
      }),
      state,
      onAuthorizationUrl: (url) => {
        authorizationUrl = url.toString();
      },
    });

    const result = await auth(provider, { serverUrl: config.endpointUrl });
    if (result === "AUTHORIZED") {
      await markConnected(integration.id, input.userWorkosId);
      return { status: "connected" as const, redirectUrl: null };
    }
    if (!authorizationUrl) {
      throw new Error(`${config.displayName} did not return an MCP authorization URL.`);
    }
    return { status: "redirect" as const, redirectUrl: authorizationUrl };
  }

  async function complete(input: {
    userWorkosId: string;
    integrationId: string;
    code: string;
    state: string;
  }) {
    const provider = createClientProvider({
      userWorkosId: input.userWorkosId,
      integrationId: input.integrationId,
      payload: await loadPayload(input),
    });

    const result = await auth(provider, {
      serverUrl: config.endpointUrl,
      authorizationCode: input.code,
      callbackState: input.state,
    });
    if (result !== "AUTHORIZED") {
      throw new Error(`${config.displayName} MCP authorization was not completed.`);
    }

    await markConnected(input.integrationId, input.userWorkosId);
  }

  function createState(input: Omit<GoatRemoteMcpState, "expiresAt" | "nonce">) {
    const payload: GoatRemoteMcpState = {
      ...input,
      returnTo: sanitizeReturnTo(input.returnTo),
      expiresAt: Date.now() + STATE_TTL_MS,
      nonce: randomUUID(),
    };
    const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    return `${body}.${signStateBody(body)}`;
  }

  function verifyState(state: string): GoatRemoteMcpState {
    const [body, signature] = state.split(".");
    if (!body || !signature || !safeEqual(signature, signStateBody(body))) {
      throw new Error(`Invalid ${config.displayName} MCP state.`);
    }

    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
    if (!isGoatRemoteMcpState(payload)) {
      throw new Error(`Invalid ${config.displayName} MCP state payload.`);
    }
    if (
      (payload.provider && payload.provider !== config.provider) ||
      (!payload.provider && !config.acceptLegacyStateWithoutProvider)
    ) {
      throw new Error(`Invalid ${config.displayName} MCP provider state.`);
    }
    if (payload.expiresAt < Date.now()) {
      throw new Error(`${config.displayName} MCP state expired.`);
    }

    return { ...payload, returnTo: sanitizeReturnTo(payload.returnTo) };
  }

  function appendStatus(returnTo: string, status: "connected" | "error", reason?: string) {
    const url = new URL(sanitizeReturnTo(returnTo), getGoatAppUrl());
    url.searchParams.set("integration", config.provider);
    url.searchParams.set("setup", status);
    if (status === "error" && reason) url.searchParams.set("reason", reason);
    return `${url.pathname}${url.search}`;
  }

  async function upsertIntegration(input: {
    userWorkosId: string;
    status: GoatIntegrationStatus;
    statusReason: string | null;
  }) {
    const now = new Date();
    const [integration] = await getDb()
      .insert(goatIntegrations)
      .values({
        id: `gint_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
        userWorkosId: input.userWorkosId,
        provider: config.provider,
        externalId: config.externalId,
        connectionLabel: config.displayName,
        accountName: config.displayName,
        accountType: "mcp_server",
        status: input.status,
        statusReason: input.statusReason,
        scopes: [...config.storedScopes],
        lastSyncedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          goatIntegrations.userWorkosId,
          goatIntegrations.provider,
          goatIntegrations.externalId,
        ],
        targetWhere: sql`${goatIntegrations.workspaceId} IS NULL`,
        set: {
          connectionLabel: config.displayName,
          accountName: config.displayName,
          accountType: "mcp_server",
          status: input.status,
          statusReason: input.statusReason,
          scopes: [...config.storedScopes],
          lastSyncedAt: now,
          updatedAt: now,
        },
      })
      .returning({ id: goatIntegrations.id });

    if (!integration) {
      throw new Error(`Could not persist Goat ${config.displayName} integration.`);
    }
    return integration;
  }

  async function markConnected(integrationId: string, userWorkosId: string) {
    await getDb()
      .update(goatIntegrations)
      .set({
        status: "connected",
        statusReason: null,
        connectionLabel: config.displayName,
        accountName: config.displayName,
        accountType: "mcp_server",
        scopes: [...config.storedScopes],
        lastSyncedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(goatIntegrations.id, integrationId),
          eq(goatIntegrations.userWorkosId, userWorkosId),
          eq(goatIntegrations.provider, config.provider),
        ),
      );
    await captureGoatIntegrationAddedAnalytics({
      userWorkosId,
      provider: config.provider,
    });
  }

  async function loadPayload(input: { userWorkosId: string; integrationId: string }) {
    const credential = await loadGoatIntegrationCredential({
      userWorkosId: input.userWorkosId,
      integrationId: input.integrationId,
      provider: config.provider,
      kind: CREDENTIAL_KIND,
    });
    return credential ? parsePayload(credential.payload) : {};
  }

  function createClientProvider(input: {
    userWorkosId: string;
    integrationId: string;
    payload: GoatRemoteMcpOAuthPayload;
    state?: string;
    onAuthorizationUrl?: (url: URL) => void;
  }): OAuthClientProvider {
    let payload = input.payload;

    async function persist(next: GoatRemoteMcpOAuthPayload) {
      payload = next;
      await saveGoatIntegrationCredential({
        userWorkosId: input.userWorkosId,
        integrationId: input.integrationId,
        provider: config.provider,
        kind: CREDENTIAL_KIND,
        payload: { ...next },
      });
    }

    return {
      get redirectUrl() {
        return callbackUrl();
      },
      get clientMetadata(): OAuthClientMetadata {
        return {
          client_name: "OpenCompany Goat",
          redirect_uris: [callbackUrl()],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          ...(config.authScope ? { scope: config.authScope } : {}),
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
        if (!payload.codeVerifier) {
          throw new Error(`${config.displayName} MCP OAuth verifier is missing.`);
        }
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

  return {
    getState,
    loadWorkerConnection,
    start,
    complete,
    verifyState,
    appendStatus,
  };
}

function parsePayload(value: Record<string, unknown>): GoatRemoteMcpOAuthPayload {
  const payload: GoatRemoteMcpOAuthPayload = {};
  if (isOAuthClientInformation(value.clientInformation)) {
    payload.clientInformation = value.clientInformation;
  }
  if (isOAuthTokens(value.tokens)) payload.tokens = value.tokens;
  if (typeof value.codeVerifier === "string") payload.codeVerifier = value.codeVerifier;
  if (typeof value.state === "string") payload.state = value.state;
  return payload;
}

function omitPayload<TKey extends keyof GoatRemoteMcpOAuthPayload>(
  payload: GoatRemoteMcpOAuthPayload,
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
  return createHmac("sha256", requiredStateSecret()).update(body).digest("base64url");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function requiredStateSecret() {
  const value = process.env.MCP_OAUTH_STATE_SECRET?.trim();
  if (!value) throw new Error("MCP_OAUTH_STATE_SECRET is required for remote MCP OAuth.");
  return value;
}

function isGoatRemoteMcpState(value: unknown): value is GoatRemoteMcpState {
  if (!isRecord(value)) return false;
  return (
    (value.provider === undefined || typeof value.provider === "string") &&
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

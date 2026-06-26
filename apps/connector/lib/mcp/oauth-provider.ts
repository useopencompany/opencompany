import {
  auth,
  type OAuthClientInformation,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthTokens,
} from "@ai-sdk/mcp";
import type { ConnectorMcpCredentialKind } from "@opencompany/db/schema";
import { getConnectorAppUrl } from "@/lib/workos";
import { loadConnectorMcpCredential, saveConnectorMcpCredential } from "./credential-storage";
import {
  type ConnectorMcpOAuthState,
  createConnectorMcpOAuthState,
  sanitizeConnectorMcpReturnTo,
  verifyConnectorMcpOAuthState,
} from "./oauth-state";

export type ConnectorMcpOAuthSetupFailureReason =
  | "invalid_state"
  | "session_mismatch"
  | "missing_code"
  | "token_exchange_failed"
  | "start_failed"
  | `${string}_denied`;

export type ConnectorMcpOAuthPayload = {
  clientInformation?: OAuthClientInformation;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  state?: string;
};

export type ConnectorMcpOAuthContext = {
  organizationId: string;
  serverId: string;
};

export type ConnectorMcpOAuthProviderConfig = {
  key: string;
  displayName: string;
  endpointUrl: string;
  credentialKind: ConnectorMcpCredentialKind;
};

export function createConnectorMcpOAuthProvider(config: ConnectorMcpOAuthProviderConfig) {
  const { key, displayName, endpointUrl, credentialKind } = config;

  function callbackUrl() {
    return `${getConnectorAppUrl()}/api/mcp/${key}/callback`;
  }

  function appendSetupStatus(
    returnTo: string,
    status: "connected" | "error",
    reason?: ConnectorMcpOAuthSetupFailureReason,
  ) {
    const url = new URL(sanitizeConnectorMcpReturnTo(returnTo), getConnectorAppUrl());
    url.searchParams.set("mcp", key);
    url.searchParams.set("setup", status);
    if (status === "error" && reason) url.searchParams.set("reason", reason);
    return `${url.pathname}${url.search}`;
  }

  function createState(input: Omit<ConnectorMcpOAuthState, "expiresAt" | "nonce">) {
    return createConnectorMcpOAuthState(input);
  }

  function verifyState(state: string) {
    return verifyConnectorMcpOAuthState(state);
  }

  function parsePayload(value: Record<string, unknown>): ConnectorMcpOAuthPayload {
    const payload: ConnectorMcpOAuthPayload = {};
    if (isOAuthClientInformation(value.clientInformation)) {
      payload.clientInformation = value.clientInformation;
    }
    if (isOAuthTokens(value.tokens)) payload.tokens = value.tokens;
    if (typeof value.codeVerifier === "string") payload.codeVerifier = value.codeVerifier;
    if (typeof value.state === "string") payload.state = value.state;
    return payload;
  }

  async function loadPayload(context: ConnectorMcpOAuthContext): Promise<ConnectorMcpOAuthPayload> {
    const credential = await loadConnectorMcpCredential({ ...context, kind: credentialKind });
    if (!credential) return {};
    return parsePayload(credential.payload);
  }

  async function start(input: {
    organizationId: string;
    userId: string;
    serverId: string;
    returnTo: string;
  }) {
    const state = createState({
      organizationId: input.organizationId,
      userId: input.userId,
      returnTo: input.returnTo,
    });
    let authorizationUrl: string | null = null;
    const provider = createClientProvider({
      organizationId: input.organizationId,
      serverId: input.serverId,
      payload: await loadPayload(input),
      state,
      onAuthorizationUrl: (url) => {
        authorizationUrl = url.toString();
      },
    });

    const result = await auth(provider, { serverUrl: endpointUrl });
    if (result === "AUTHORIZED") {
      return { status: "connected" as const, redirectUrl: null };
    }
    if (!authorizationUrl) {
      throw new Error(`${displayName} did not return an MCP authorization URL.`);
    }
    return { status: "redirect" as const, redirectUrl: authorizationUrl };
  }

  async function complete(input: {
    organizationId: string;
    serverId: string;
    code: string;
    state: string;
  }) {
    const provider = createClientProvider({
      organizationId: input.organizationId,
      serverId: input.serverId,
      payload: await loadPayload(input),
    });

    const result = await auth(provider, {
      serverUrl: endpointUrl,
      authorizationCode: input.code,
      callbackState: input.state,
    });

    if (result !== "AUTHORIZED") {
      throw new Error(`${displayName} MCP authorization was not completed.`);
    }
  }

  function startFailureStatusReason(errorMessage: string) {
    if (errorMessage.includes("CONNECTOR_CREDENTIAL_ENCRYPTION_KEY")) {
      return `Set CONNECTOR_CREDENTIAL_ENCRYPTION_KEY to a base64-encoded 32-byte key, then reconnect ${displayName}.`;
    }
    return `${displayName} MCP authorization could not start.`;
  }

  function createClientProvider(input: {
    organizationId: string;
    serverId: string;
    payload: ConnectorMcpOAuthPayload;
    state?: string;
    onAuthorizationUrl?: (url: URL) => void;
  }): OAuthClientProvider {
    let payload = input.payload;
    const context = {
      organizationId: input.organizationId,
      serverId: input.serverId,
    };

    async function persist(next: ConnectorMcpOAuthPayload) {
      payload = next;
      await saveConnectorMcpCredential({
        ...context,
        kind: credentialKind,
        payload: { ...next },
      });
    }

    return {
      get redirectUrl() {
        return callbackUrl();
      },
      get clientMetadata(): OAuthClientMetadata {
        return {
          client_name: "Connector",
          redirect_uris: [callbackUrl()],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        };
      },
      clientInformation: () => payload.clientInformation,
      saveClientInformation: async (clientInformation: OAuthClientInformation) => {
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
        if (!payload.codeVerifier) throw new Error(`${displayName} MCP OAuth verifier is missing.`);
        return payload.codeVerifier;
      },
      redirectToAuthorization: (authorizationUrl) => {
        input.onAuthorizationUrl?.(authorizationUrl);
      },
      invalidateCredentials: async (scope) => {
        if (scope === "all") {
          await persist({});
        } else if (scope === "tokens") {
          await persist(omitOAuthPayload(payload, ["tokens"]));
        } else if (scope === "verifier") {
          await persist(omitOAuthPayload(payload, ["codeVerifier", "state"]));
        } else if (scope === "client") {
          await persist(omitOAuthPayload(payload, ["clientInformation"]));
        }
      },
    };
  }

  return {
    key,
    displayName,
    endpointUrl,
    credentialKind,
    callbackUrl,
    appendSetupStatus,
    createState,
    verifyState,
    start,
    complete,
    startFailureStatusReason,
  };
}

function omitOAuthPayload<K extends keyof ConnectorMcpOAuthPayload>(
  payload: ConnectorMcpOAuthPayload,
  keys: K[],
) {
  const next = { ...payload };
  for (const key of keys) {
    delete next[key];
  }
  return next;
}

function isOAuthClientInformation(value: unknown): value is OAuthClientInformation {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof (value as { client_id?: unknown }).client_id === "string",
  );
}

function isOAuthTokens(value: unknown): value is OAuthTokens {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof (value as { access_token?: unknown }).access_token === "string",
  );
}

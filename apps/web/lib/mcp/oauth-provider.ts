import {
  auth,
  type OAuthClientInformation,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthTokens,
} from "@ai-sdk/mcp";
import type { WorkspaceMcpCredentialKind } from "@opencompany/db/schema";
import { getAppUrl } from "@/lib/billing/stripe";
import { loadMcpCredential, saveMcpCredential } from "@/lib/mcp/credential-storage";
import type { McpProviderKey } from "@/lib/mcp/data";
import {
  createMcpOAuthState,
  type McpOAuthState,
  sanitizeReturnTo,
  verifyMcpOAuthState,
} from "@/lib/mcp/oauth-state";

// Generic MCP OAuth provider factory. Every provider (Linear, Slack, PostHog, Better Stack,
// Braintrust, …) shares the exact same flow: HMAC-signed state round-trip, PKCE token
// exchange via @ai-sdk/mcp `auth`, and encrypted credential persistence. A new provider is
// a config object in oauth-providers.ts — not another module.

export type McpOAuthSetupFailureReason =
  | "invalid_state"
  | "session_mismatch"
  | "missing_code"
  | "token_exchange_failed"
  | "start_failed"
  | `${string}_denied`;

export type McpOAuthStatePayload = McpOAuthState;

export type McpOAuthPayload = {
  clientInformation?: OAuthClientInformation;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  state?: string;
};

export type McpOAuthContext = {
  workspaceId: string;
  serverId: string;
};

export type McpOAuthProviderConfig = {
  /** Provider key — also the URL segment (`/api/mcp/<key>/…`) and `?mcp=<key>` query value. */
  key: McpProviderKey;
  /** Human-readable name used in status reasons and error messages, e.g. "Better Stack". */
  displayName: string;
  /** MCP server endpoint the OAuth flow authorizes against. */
  endpointUrl: string;
  /** Credential kind under which the OAuth payload is stored. */
  credentialKind: WorkspaceMcpCredentialKind;
  /** Space-separated OAuth scope requested at authorization time (Slack). */
  authScope?: string;
  /**
   * Env-backed static client credentials (Slack). When set, dynamic client registration is
   * disabled and client information is never persisted to credential storage — the client
   * secret must stay out of the database.
   */
  staticClientInformation?: () => OAuthClientInformation;
  /**
   * Provider-specific env vars surfaced in the server status reason when the start flow
   * fails because one of them is missing (Slack client id/secret).
   */
  startFailureEnvHints?: readonly string[];
};

export type McpOAuthProvider = ReturnType<typeof createMcpOAuthProvider>;

export function createMcpOAuthProvider(config: McpOAuthProviderConfig) {
  const { key, displayName, endpointUrl, credentialKind } = config;

  function callbackUrl() {
    return `${getAppUrl()}/api/mcp/${key}/callback`;
  }

  function appendSetupStatus(
    returnTo: string,
    status: "connected" | "error",
    reason?: McpOAuthSetupFailureReason,
  ) {
    const url = new URL(sanitizeReturnTo(returnTo), getAppUrl());
    url.searchParams.set("mcp", key);
    url.searchParams.set("setup", status);
    if (status === "error" && reason) url.searchParams.set("reason", reason);
    return `${url.pathname}${url.search}`;
  }

  function createState(input: Omit<McpOAuthStatePayload, "expiresAt" | "nonce">) {
    return createMcpOAuthState(input);
  }

  function verifyState(state: string): McpOAuthStatePayload {
    return verifyMcpOAuthState(state);
  }

  function parsePayload(value: Record<string, unknown>): McpOAuthPayload {
    const payload: McpOAuthPayload = {};
    if (!config.staticClientInformation && isOAuthClientInformation(value.clientInformation)) {
      payload.clientInformation = value.clientInformation;
    }
    if (isOAuthTokens(value.tokens)) payload.tokens = value.tokens;
    if (typeof value.codeVerifier === "string") payload.codeVerifier = value.codeVerifier;
    if (typeof value.state === "string") payload.state = value.state;
    return payload;
  }

  async function loadPayload(context: McpOAuthContext): Promise<McpOAuthPayload> {
    const credential = await loadMcpCredential({ ...context, kind: credentialKind });
    if (!credential) return {};
    return parsePayload(credential.payload);
  }

  async function start(input: {
    workspaceId: string;
    userId: string;
    serverId: string;
    returnTo: string;
  }) {
    const state = createState({
      workspaceId: input.workspaceId,
      userId: input.userId,
      returnTo: input.returnTo,
    });
    let authorizationUrl: string | null = null;
    const provider = createClientProvider({
      workspaceId: input.workspaceId,
      serverId: input.serverId,
      payload: await loadPayload(input),
      state,
      onAuthorizationUrl: (url) => {
        authorizationUrl = url.toString();
      },
    });

    const result = await auth(provider, {
      serverUrl: endpointUrl,
      ...(config.authScope ? { scope: config.authScope } : {}),
    });
    if (result === "AUTHORIZED") {
      return { status: "connected" as const, redirectUrl: null };
    }
    if (!authorizationUrl) {
      throw new Error(`${displayName} did not return an MCP authorization URL.`);
    }
    return { status: "redirect" as const, redirectUrl: authorizationUrl };
  }

  async function complete(input: {
    workspaceId: string;
    serverId: string;
    code: string;
    state: string;
  }) {
    const provider = createClientProvider({
      workspaceId: input.workspaceId,
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
    if (errorMessage.includes("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY")) {
      return `Set INTEGRATION_CREDENTIAL_ENCRYPTION_KEY to a base64-encoded 32-byte key, then reconnect ${displayName}.`;
    }
    for (const envVar of config.startFailureEnvHints ?? []) {
      if (errorMessage.includes(envVar)) return `Set ${envVar}, then reconnect ${displayName}.`;
    }
    return `${displayName} MCP authorization could not start.`;
  }

  function createClientProvider(input: {
    workspaceId: string;
    serverId: string;
    payload: McpOAuthPayload;
    state?: string;
    onAuthorizationUrl?: (url: URL) => void;
  }): OAuthClientProvider {
    let payload = input.payload;
    const context = {
      workspaceId: input.workspaceId,
      serverId: input.serverId,
    };

    async function persist(next: McpOAuthPayload) {
      payload = next;
      await saveMcpCredential({
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
          client_name: "OpenCompany",
          redirect_uris: [callbackUrl()],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          ...(config.authScope ? { scope: config.authScope } : {}),
        };
      },
      clientInformation: () =>
        config.staticClientInformation
          ? config.staticClientInformation()
          : payload.clientInformation,
      // Dynamic client registration only: providers with env-backed client credentials
      // must never persist them.
      ...(config.staticClientInformation
        ? {}
        : {
            saveClientInformation: async (clientInformation: OAuthClientInformation) => {
              await persist({ ...payload, clientInformation });
            },
          }),
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
        } else if (scope === "client" && !config.staticClientInformation) {
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
    deniedReason: `${key}_denied` as const,
    callbackUrl,
    appendSetupStatus,
    createState,
    verifyState,
    parsePayload,
    loadPayload,
    start,
    complete,
    startFailureStatusReason,
  };
}

function omitOAuthPayload<TKey extends keyof McpOAuthPayload>(
  payload: McpOAuthPayload,
  keys: TKey[],
) {
  const next = { ...payload };
  for (const key of keys) delete next[key];
  return next;
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

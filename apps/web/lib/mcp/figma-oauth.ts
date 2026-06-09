import {
  auth,
  type OAuthClientInformation,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthTokens,
} from "@ai-sdk/mcp";
import { getAppUrl } from "@/lib/billing/stripe";
import { loadMcpCredential, saveMcpCredential } from "@/lib/mcp/credential-storage";
import { FIGMA_MCP_ENDPOINT_URL, FIGMA_MCP_OAUTH_CREDENTIAL_KIND } from "@/lib/mcp/data";
import {
  createMcpOAuthState,
  type McpOAuthState,
  sanitizeReturnTo,
  verifyMcpOAuthState,
} from "@/lib/mcp/oauth-state";

export type FigmaMcpSetupFailureReason =
  | "invalid_state"
  | "session_mismatch"
  | "figma_denied"
  | "missing_code"
  | "token_exchange_failed"
  | "start_failed";

export type FigmaMcpOAuthStatePayload = McpOAuthState;

export type FigmaMcpOAuthPayload = {
  clientInformation?: OAuthClientInformation;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  state?: string;
};

export type FigmaMcpOAuthContext = {
  workspaceId: string;
  serverId: string;
};

export function figmaMcpOAuthCredentialKind() {
  return FIGMA_MCP_OAUTH_CREDENTIAL_KIND;
}

export function figmaMcpCallbackUrl() {
  return `${getAppUrl()}/api/mcp/figma/callback`;
}

export function appendFigmaMcpSetupStatus(
  returnTo: string,
  status: "connected" | "error",
  reason?: FigmaMcpSetupFailureReason,
) {
  const url = new URL(sanitizeReturnTo(returnTo), getAppUrl());
  url.searchParams.set("mcp", "figma");
  url.searchParams.set("setup", status);
  if (status === "error" && reason) url.searchParams.set("reason", reason);
  return `${url.pathname}${url.search}`;
}

export function createFigmaMcpOAuthState(
  input: Omit<FigmaMcpOAuthStatePayload, "expiresAt" | "nonce">,
) {
  return createMcpOAuthState(input);
}

export function verifyFigmaMcpOAuthState(state: string): FigmaMcpOAuthStatePayload {
  return verifyMcpOAuthState(state);
}

export async function loadFigmaMcpOAuthPayload(context: FigmaMcpOAuthContext) {
  const credential = await loadMcpCredential({
    ...context,
    kind: FIGMA_MCP_OAUTH_CREDENTIAL_KIND,
  });
  if (!credential) return {};
  return parseFigmaMcpOAuthPayload(credential.payload);
}

export async function startFigmaMcpOAuth(input: {
  workspaceId: string;
  userId: string;
  serverId: string;
  returnTo: string;
}) {
  const state = createFigmaMcpOAuthState({
    workspaceId: input.workspaceId,
    userId: input.userId,
    returnTo: input.returnTo,
  });
  let authorizationUrl: string | null = null;
  const provider = createFigmaMcpOAuthProvider({
    workspaceId: input.workspaceId,
    serverId: input.serverId,
    payload: await loadFigmaMcpOAuthPayload(input),
    state,
    onAuthorizationUrl: (url) => {
      authorizationUrl = url.toString();
    },
  });

  const result = await auth(provider, { serverUrl: FIGMA_MCP_ENDPOINT_URL });
  if (result === "AUTHORIZED") {
    return { status: "connected" as const, redirectUrl: null };
  }
  if (!authorizationUrl) throw new Error("Figma did not return an MCP authorization URL.");
  return { status: "redirect" as const, redirectUrl: authorizationUrl };
}

export async function completeFigmaMcpOAuth(input: {
  workspaceId: string;
  serverId: string;
  code: string;
  state: string;
}) {
  const provider = createFigmaMcpOAuthProvider({
    workspaceId: input.workspaceId,
    serverId: input.serverId,
    payload: await loadFigmaMcpOAuthPayload(input),
  });

  const result = await auth(provider, {
    serverUrl: FIGMA_MCP_ENDPOINT_URL,
    authorizationCode: input.code,
    callbackState: input.state,
  });

  if (result !== "AUTHORIZED") throw new Error("Figma MCP authorization was not completed.");
}

function createFigmaMcpOAuthProvider(input: {
  workspaceId: string;
  serverId: string;
  payload: FigmaMcpOAuthPayload;
  state?: string;
  onAuthorizationUrl?: (url: URL) => void;
}): OAuthClientProvider {
  let payload = input.payload;
  const context = {
    workspaceId: input.workspaceId,
    serverId: input.serverId,
  };

  async function persist(next: FigmaMcpOAuthPayload) {
    payload = next;
    await saveMcpCredential({
      ...context,
      kind: FIGMA_MCP_OAUTH_CREDENTIAL_KIND,
      payload: { ...next },
    });
  }

  return {
    get redirectUrl() {
      return figmaMcpCallbackUrl();
    },
    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: "OpenCompany",
        redirect_uris: [figmaMcpCallbackUrl()],
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
      if (!payload.codeVerifier) throw new Error("Figma MCP OAuth verifier is missing.");
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

function parseFigmaMcpOAuthPayload(value: Record<string, unknown>): FigmaMcpOAuthPayload {
  const payload: FigmaMcpOAuthPayload = {};
  if (isOAuthClientInformation(value.clientInformation)) {
    payload.clientInformation = value.clientInformation;
  }
  if (isOAuthTokens(value.tokens)) payload.tokens = value.tokens;
  if (typeof value.codeVerifier === "string") payload.codeVerifier = value.codeVerifier;
  if (typeof value.state === "string") payload.state = value.state;
  return payload;
}

function omitOAuthPayload<TKey extends keyof FigmaMcpOAuthPayload>(
  payload: FigmaMcpOAuthPayload,
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

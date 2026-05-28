import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  auth,
  type OAuthClientInformation,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthTokens,
} from "@ai-sdk/mcp";
import { getAppUrl } from "@/lib/billing/stripe";
import { loadMcpCredential, saveMcpCredential } from "@/lib/mcp/credential-storage";
import { LINEAR_MCP_ENDPOINT_URL, LINEAR_MCP_OAUTH_CREDENTIAL_KIND } from "@/lib/mcp/data";

const DEFAULT_RETURN_TO = "/settings";
const STATE_TTL_MS = 10 * 60 * 1000;

export type LinearMcpSetupFailureReason =
  | "invalid_state"
  | "session_mismatch"
  | "linear_denied"
  | "missing_code"
  | "token_exchange_failed"
  | "start_failed";

export type LinearMcpOAuthStatePayload = {
  workspaceId: string;
  userId: string;
  returnTo: string;
  expiresAt: number;
  nonce: string;
};

export type LinearMcpOAuthPayload = {
  clientInformation?: OAuthClientInformation;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  state?: string;
};

export type LinearMcpOAuthContext = {
  workspaceId: string;
  serverId: string;
};

export function linearMcpOAuthCredentialKind() {
  return LINEAR_MCP_OAUTH_CREDENTIAL_KIND;
}

export function linearMcpCallbackUrl() {
  return `${getAppUrl()}/api/mcp/linear/callback`;
}

export function appendLinearMcpSetupStatus(
  returnTo: string,
  status: "connected" | "error",
  reason?: LinearMcpSetupFailureReason,
) {
  const url = new URL(sanitizeReturnTo(returnTo), getAppUrl());
  url.searchParams.set("mcp", "linear");
  url.searchParams.set("setup", status);
  if (status === "error" && reason) url.searchParams.set("reason", reason);
  return `${url.pathname}${url.search}`;
}

export function createLinearMcpOAuthState(
  input: Omit<LinearMcpOAuthStatePayload, "expiresAt" | "nonce">,
) {
  const payload: LinearMcpOAuthStatePayload = {
    ...input,
    returnTo: sanitizeReturnTo(input.returnTo),
    expiresAt: Date.now() + STATE_TTL_MS,
    nonce: randomUUID(),
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = signStateBody(body);
  return `${body}.${signature}`;
}

export function verifyLinearMcpOAuthState(state: string): LinearMcpOAuthStatePayload {
  const [body, signature] = state.split(".");
  if (!body || !signature) throw new Error("Invalid Linear MCP OAuth state.");

  const expected = signStateBody(body);
  if (!safeEqual(signature, expected)) throw new Error("Invalid Linear MCP OAuth state signature.");

  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
  if (!isLinearMcpOAuthStatePayload(payload)) {
    throw new Error("Invalid Linear MCP OAuth state payload.");
  }
  if (payload.expiresAt < Date.now()) throw new Error("Linear MCP OAuth state expired.");

  return {
    ...payload,
    returnTo: sanitizeReturnTo(payload.returnTo),
  };
}

export async function loadLinearMcpOAuthPayload(context: LinearMcpOAuthContext) {
  const credential = await loadMcpCredential({
    ...context,
    kind: LINEAR_MCP_OAUTH_CREDENTIAL_KIND,
  });
  if (!credential) return {};
  return parseLinearMcpOAuthPayload(credential.payload);
}

export async function startLinearMcpOAuth(input: {
  workspaceId: string;
  userId: string;
  serverId: string;
  returnTo: string;
}) {
  const state = createLinearMcpOAuthState({
    workspaceId: input.workspaceId,
    userId: input.userId,
    returnTo: input.returnTo,
  });
  let authorizationUrl: string | null = null;
  const provider = createLinearMcpOAuthProvider({
    workspaceId: input.workspaceId,
    serverId: input.serverId,
    payload: await loadLinearMcpOAuthPayload(input),
    state,
    onAuthorizationUrl: (url) => {
      authorizationUrl = url.toString();
    },
  });

  const result = await auth(provider, { serverUrl: LINEAR_MCP_ENDPOINT_URL });
  if (result === "AUTHORIZED") {
    return { status: "connected" as const, redirectUrl: null };
  }
  if (!authorizationUrl) throw new Error("Linear did not return an MCP authorization URL.");
  return { status: "redirect" as const, redirectUrl: authorizationUrl };
}

export async function completeLinearMcpOAuth(input: {
  workspaceId: string;
  serverId: string;
  code: string;
  state: string;
}) {
  const provider = createLinearMcpOAuthProvider({
    workspaceId: input.workspaceId,
    serverId: input.serverId,
    payload: await loadLinearMcpOAuthPayload(input),
  });

  const result = await auth(provider, {
    serverUrl: LINEAR_MCP_ENDPOINT_URL,
    authorizationCode: input.code,
    callbackState: input.state,
  });

  if (result !== "AUTHORIZED") throw new Error("Linear MCP authorization was not completed.");
}

function createLinearMcpOAuthProvider(input: {
  workspaceId: string;
  serverId: string;
  payload: LinearMcpOAuthPayload;
  state?: string;
  onAuthorizationUrl?: (url: URL) => void;
}): OAuthClientProvider {
  let payload = input.payload;
  const context = {
    workspaceId: input.workspaceId,
    serverId: input.serverId,
  };

  async function persist(next: LinearMcpOAuthPayload) {
    payload = next;
    await saveMcpCredential({
      ...context,
      kind: LINEAR_MCP_OAUTH_CREDENTIAL_KIND,
      payload: { ...next },
    });
  }

  return {
    get redirectUrl() {
      return linearMcpCallbackUrl();
    },
    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: "OpenCompany",
        redirect_uris: [linearMcpCallbackUrl()],
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
        await persist(omitOAuthPayload(payload, ["tokens"]));
      } else if (scope === "verifier") {
        await persist(omitOAuthPayload(payload, ["codeVerifier", "state"]));
      } else if (scope === "client") {
        await persist(omitOAuthPayload(payload, ["clientInformation"]));
      }
    },
  };
}

function parseLinearMcpOAuthPayload(value: Record<string, unknown>): LinearMcpOAuthPayload {
  const payload: LinearMcpOAuthPayload = {};
  if (isOAuthClientInformation(value.clientInformation)) {
    payload.clientInformation = value.clientInformation;
  }
  if (isOAuthTokens(value.tokens)) payload.tokens = value.tokens;
  if (typeof value.codeVerifier === "string") payload.codeVerifier = value.codeVerifier;
  if (typeof value.state === "string") payload.state = value.state;
  return payload;
}

function omitOAuthPayload<TKey extends keyof LinearMcpOAuthPayload>(
  payload: LinearMcpOAuthPayload,
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

function isLinearMcpOAuthStatePayload(value: unknown): value is LinearMcpOAuthStatePayload {
  if (!isRecord(value)) return false;
  return (
    typeof value.workspaceId === "string" &&
    typeof value.userId === "string" &&
    typeof value.returnTo === "string" &&
    typeof value.expiresAt === "number" &&
    typeof value.nonce === "string"
  );
}

function sanitizeReturnTo(value: string) {
  if (!value.startsWith("/") || value.startsWith("//")) return DEFAULT_RETURN_TO;
  return value;
}

function signStateBody(body: string) {
  return createHmac("sha256", stateSecret()).update(body).digest("base64url");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function stateSecret() {
  const raw = process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (!raw) throw new Error("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY is required for MCP OAuth.");
  return raw;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

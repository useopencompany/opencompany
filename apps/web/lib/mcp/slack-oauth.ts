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
import { SLACK_MCP_ENDPOINT_URL, SLACK_MCP_OAUTH_CREDENTIAL_KIND } from "@/lib/mcp/data";

const DEFAULT_RETURN_TO = "/settings";
const STATE_TTL_MS = 10 * 60 * 1000;
const SLACK_READ_SCOPES = [
  "search:read.public",
  "search:read.private",
  "search:read.mpim",
  "search:read.im",
  "search:read.files",
  "search:read.users",
  "channels:history",
  "groups:history",
  "mpim:history",
  "im:history",
  "files:read",
  "emoji:read",
  "users:read",
  "users:read.email",
  "channels:read",
  "groups:read",
  "mpim:read",
];

export type SlackMcpSetupFailureReason =
  | "invalid_state"
  | "session_mismatch"
  | "slack_denied"
  | "missing_code"
  | "token_exchange_failed"
  | "start_failed";

export type SlackMcpOAuthStatePayload = {
  workspaceId: string;
  userId: string;
  returnTo: string;
  expiresAt: number;
  nonce: string;
};

export type SlackMcpOAuthPayload = {
  tokens?: OAuthTokens;
  codeVerifier?: string;
  state?: string;
};

export type SlackMcpOAuthContext = {
  workspaceId: string;
  serverId: string;
};

export function slackMcpOAuthCredentialKind() {
  return SLACK_MCP_OAUTH_CREDENTIAL_KIND;
}

export function slackMcpCallbackUrl() {
  return `${getAppUrl()}/api/mcp/slack/callback`;
}

export function appendSlackMcpSetupStatus(
  returnTo: string,
  status: "connected" | "error",
  reason?: SlackMcpSetupFailureReason,
) {
  const url = new URL(sanitizeReturnTo(returnTo), getAppUrl());
  url.searchParams.set("mcp", "slack");
  url.searchParams.set("setup", status);
  if (status === "error" && reason) url.searchParams.set("reason", reason);
  return `${url.pathname}${url.search}`;
}

export function createSlackMcpOAuthState(
  input: Omit<SlackMcpOAuthStatePayload, "expiresAt" | "nonce">,
) {
  const payload: SlackMcpOAuthStatePayload = {
    ...input,
    returnTo: sanitizeReturnTo(input.returnTo),
    expiresAt: Date.now() + STATE_TTL_MS,
    nonce: randomUUID(),
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = signStateBody(body);
  return `${body}.${signature}`;
}

export function verifySlackMcpOAuthState(state: string): SlackMcpOAuthStatePayload {
  const [body, signature] = state.split(".");
  if (!body || !signature) throw new Error("Invalid Slack MCP OAuth state.");

  const expected = signStateBody(body);
  if (!safeEqual(signature, expected)) throw new Error("Invalid Slack MCP OAuth state signature.");

  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
  if (!isSlackMcpOAuthStatePayload(payload)) {
    throw new Error("Invalid Slack MCP OAuth state payload.");
  }
  if (payload.expiresAt < Date.now()) throw new Error("Slack MCP OAuth state expired.");

  return {
    ...payload,
    returnTo: sanitizeReturnTo(payload.returnTo),
  };
}

export async function loadSlackMcpOAuthPayload(context: SlackMcpOAuthContext) {
  const credential = await loadMcpCredential({
    ...context,
    kind: SLACK_MCP_OAUTH_CREDENTIAL_KIND,
  });
  if (!credential) return {};
  return parseSlackMcpOAuthPayload(credential.payload);
}

export async function startSlackMcpOAuth(input: {
  workspaceId: string;
  userId: string;
  serverId: string;
  returnTo: string;
}) {
  const state = createSlackMcpOAuthState({
    workspaceId: input.workspaceId,
    userId: input.userId,
    returnTo: input.returnTo,
  });
  let authorizationUrl: string | null = null;
  const provider = createSlackMcpOAuthProvider({
    workspaceId: input.workspaceId,
    serverId: input.serverId,
    payload: await loadSlackMcpOAuthPayload(input),
    state,
    onAuthorizationUrl: (url) => {
      authorizationUrl = url.toString();
    },
  });

  const result = await auth(provider, {
    serverUrl: SLACK_MCP_ENDPOINT_URL,
    scope: SLACK_READ_SCOPES.join(" "),
  });
  if (result === "AUTHORIZED") {
    return { status: "connected" as const, redirectUrl: null };
  }
  if (!authorizationUrl) throw new Error("Slack did not return an MCP authorization URL.");
  return { status: "redirect" as const, redirectUrl: authorizationUrl };
}

export async function completeSlackMcpOAuth(input: {
  workspaceId: string;
  serverId: string;
  code: string;
  state: string;
}) {
  const provider = createSlackMcpOAuthProvider({
    workspaceId: input.workspaceId,
    serverId: input.serverId,
    payload: await loadSlackMcpOAuthPayload(input),
  });

  const result = await auth(provider, {
    serverUrl: SLACK_MCP_ENDPOINT_URL,
    authorizationCode: input.code,
    callbackState: input.state,
  });

  if (result !== "AUTHORIZED") throw new Error("Slack MCP authorization was not completed.");
}

function createSlackMcpOAuthProvider(input: {
  workspaceId: string;
  serverId: string;
  payload: SlackMcpOAuthPayload;
  state?: string;
  onAuthorizationUrl?: (url: URL) => void;
}): OAuthClientProvider {
  let payload = input.payload;
  const context = {
    workspaceId: input.workspaceId,
    serverId: input.serverId,
  };

  async function persist(next: SlackMcpOAuthPayload) {
    payload = next;
    await saveMcpCredential({
      ...context,
      kind: SLACK_MCP_OAUTH_CREDENTIAL_KIND,
      payload: { ...next },
    });
  }

  return {
    get redirectUrl() {
      return slackMcpCallbackUrl();
    },
    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: "OpenCompany",
        redirect_uris: [slackMcpCallbackUrl()],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: SLACK_READ_SCOPES.join(" "),
      };
    },
    clientInformation: () => slackClientInformation(),
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
      if (!payload.codeVerifier) throw new Error("Slack MCP OAuth verifier is missing.");
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
      }
    },
  };
}

function slackClientInformation(): OAuthClientInformation {
  return {
    client_id: requiredEnv("SLACK_MCP_CLIENT_ID"),
    client_secret: requiredEnv("SLACK_MCP_CLIENT_SECRET"),
  };
}

function parseSlackMcpOAuthPayload(value: Record<string, unknown>): SlackMcpOAuthPayload {
  const payload: SlackMcpOAuthPayload = {};
  if (isOAuthTokens(value.tokens)) payload.tokens = value.tokens;
  if (typeof value.codeVerifier === "string") payload.codeVerifier = value.codeVerifier;
  if (typeof value.state === "string") payload.state = value.state;
  return payload;
}

function omitOAuthPayload<TKey extends keyof SlackMcpOAuthPayload>(
  payload: SlackMcpOAuthPayload,
  keys: TKey[],
) {
  const next = { ...payload };
  for (const key of keys) delete next[key];
  return next;
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

function isSlackMcpOAuthStatePayload(value: unknown): value is SlackMcpOAuthStatePayload {
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

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for Slack MCP OAuth.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

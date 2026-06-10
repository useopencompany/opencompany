import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

// Signed, short-lived state for MCP OAuth round-trips, shared by every MCP provider
// (Linear, Slack, …). Signed with MCP_OAUTH_STATE_SECRET — a secret dedicated to this
// purpose, distinct from the credential encryption key.

const DEFAULT_RETURN_TO = "/company/settings";
const STATE_TTL_MS = 10 * 60 * 1000;
const STATE_SECRET_ENV = "MCP_OAUTH_STATE_SECRET";

export type McpOAuthStateInput = {
  workspaceId: string;
  userId: string;
  returnTo: string;
};

export type McpOAuthState = McpOAuthStateInput & {
  expiresAt: number;
  nonce: string;
};

export function sanitizeReturnTo(value: string) {
  if (!value.startsWith("/") || value.startsWith("//")) return DEFAULT_RETURN_TO;
  return value;
}

export function createMcpOAuthState(input: McpOAuthStateInput): string {
  const payload: McpOAuthState = {
    ...input,
    returnTo: sanitizeReturnTo(input.returnTo),
    expiresAt: Date.now() + STATE_TTL_MS,
    nonce: randomUUID(),
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${signStateBody(body)}`;
}

export function verifyMcpOAuthState(state: string): McpOAuthState {
  const [body, signature] = state.split(".");
  if (!body || !signature) throw new Error("Invalid MCP OAuth state.");

  const expected = signStateBody(body);
  if (!safeEqual(signature, expected)) throw new Error("Invalid MCP OAuth state signature.");

  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
  if (!isMcpOAuthState(payload)) {
    throw new Error("Invalid MCP OAuth state payload.");
  }
  if (payload.expiresAt < Date.now()) throw new Error("MCP OAuth state expired.");

  return {
    ...payload,
    returnTo: sanitizeReturnTo(payload.returnTo),
  };
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
  const raw = process.env[STATE_SECRET_ENV]?.trim();
  if (!raw) throw new Error(`${STATE_SECRET_ENV} is required for MCP OAuth.`);
  return raw;
}

function isMcpOAuthState(value: unknown): value is McpOAuthState {
  if (!isRecord(value)) return false;
  return (
    typeof value.workspaceId === "string" &&
    typeof value.userId === "string" &&
    typeof value.returnTo === "string" &&
    typeof value.expiresAt === "number" &&
    typeof value.nonce === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

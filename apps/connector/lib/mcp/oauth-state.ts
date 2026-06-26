import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const DEFAULT_RETURN_TO = "/setup";
const STATE_TTL_MS = 10 * 60 * 1000;
const STATE_SECRET_ENV = "CONNECTOR_MCP_OAUTH_STATE_SECRET";

export type ConnectorMcpOAuthStateInput = {
  organizationId: string;
  userId: string;
  returnTo: string;
};

export type ConnectorMcpOAuthState = ConnectorMcpOAuthStateInput & {
  expiresAt: number;
  nonce: string;
};

export function sanitizeConnectorMcpReturnTo(value: string) {
  if (!value.startsWith("/") || value.startsWith("//")) return DEFAULT_RETURN_TO;
  return value;
}

export function createConnectorMcpOAuthState(input: ConnectorMcpOAuthStateInput): string {
  const payload: ConnectorMcpOAuthState = {
    ...input,
    returnTo: sanitizeConnectorMcpReturnTo(input.returnTo),
    expiresAt: Date.now() + STATE_TTL_MS,
    nonce: randomUUID(),
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${signStateBody(body)}`;
}

export function verifyConnectorMcpOAuthState(state: string): ConnectorMcpOAuthState {
  const [body, signature] = state.split(".");
  if (!body || !signature) throw new Error("Invalid Connector MCP OAuth state.");

  const expected = signStateBody(body);
  if (!safeEqual(signature, expected)) {
    throw new Error("Invalid Connector MCP OAuth state signature.");
  }

  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
  if (!isConnectorMcpOAuthState(payload)) {
    throw new Error("Invalid Connector MCP OAuth state payload.");
  }
  if (payload.expiresAt < Date.now()) throw new Error("Connector MCP OAuth state expired.");

  return {
    ...payload,
    returnTo: sanitizeConnectorMcpReturnTo(payload.returnTo),
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
  if (!raw) throw new Error(`${STATE_SECRET_ENV} is required for Connector MCP OAuth.`);
  return raw;
}

function isConnectorMcpOAuthState(value: unknown): value is ConnectorMcpOAuthState {
  if (!isRecord(value)) return false;
  return (
    typeof value.organizationId === "string" &&
    typeof value.userId === "string" &&
    typeof value.returnTo === "string" &&
    typeof value.expiresAt === "number" &&
    typeof value.nonce === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

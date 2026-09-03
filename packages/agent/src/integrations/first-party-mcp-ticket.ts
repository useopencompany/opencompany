import { createHmac, timingSafeEqual } from "node:crypto";
import type { RemoteMcpOperation } from "../actions/remote-mcp";

const TICKET_VERSION = 1;
const TICKET_TTL_MS = 60_000;
const MAX_TICKET_CHARS = 4_096;

export type FirstPartyMcpTicketPayload<Audience extends string> = {
  v: 1;
  aud: Audience;
  userWorkosId: string;
  workspaceId: string;
  integrationId: string;
  registrationId: string;
  operation: RemoteMcpOperation;
  expiresAt: number;
};

export function createFirstPartyMcpTicket<Audience extends string>(input: {
  audience: Audience;
  signingContext: string;
  userWorkosId: string;
  workspaceId: string;
  integrationId: string;
  registrationId: string;
  operation: RemoteMcpOperation;
  secret: string;
  now?: number;
  ttlMs?: number;
}) {
  const payload = {
    v: TICKET_VERSION,
    aud: input.audience,
    userWorkosId: input.userWorkosId,
    workspaceId: input.workspaceId,
    integrationId: input.integrationId,
    registrationId: input.registrationId,
    operation: input.operation,
    expiresAt: (input.now ?? Date.now()) + (input.ttlMs ?? TICKET_TTL_MS),
  } satisfies FirstPartyMcpTicketPayload<Audience>;
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return {
    ticket: `${encodedPayload}.${sign(encodedPayload, input.secret, input.signingContext)}`,
    expiresAt: payload.expiresAt,
  };
}

export function verifyFirstPartyMcpTicket<Audience extends string>(input: {
  ticket: string;
  secret: string;
  audience: Audience;
  signingContext: string;
  now?: number;
}): FirstPartyMcpTicketPayload<Audience> | null {
  if (!input.ticket || input.ticket.length > MAX_TICKET_CHARS) return null;
  const separator = input.ticket.lastIndexOf(".");
  if (separator <= 0) return null;

  const encodedPayload = input.ticket.slice(0, separator);
  const suppliedSignature = input.ticket.slice(separator + 1);
  if (!safeEqual(sign(encodedPayload, input.secret, input.signingContext), suppliedSignature)) {
    return null;
  }

  try {
    const value = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Partial<
      FirstPartyMcpTicketPayload<Audience>
    >;
    if (
      value.v !== TICKET_VERSION ||
      value.aud !== input.audience ||
      !boundedString(value.userWorkosId, 256) ||
      !boundedString(value.workspaceId, 256) ||
      !boundedString(value.integrationId, 256) ||
      !boundedString(value.registrationId, 256) ||
      typeof value.expiresAt !== "number" ||
      !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt <= (input.now ?? Date.now()) ||
      !validOperation(value.operation)
    ) {
      return null;
    }
    return value as FirstPartyMcpTicketPayload<Audience>;
  } catch {
    return null;
  }
}

function validOperation(value: unknown): value is RemoteMcpOperation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const operation = value as Record<string, unknown>;
  if (operation.type === "tools/list") return Object.keys(operation).length === 1;
  return (
    operation.type === "tools/call" &&
    Object.keys(operation).every((key) => ["type", "tool", "capability"].includes(key)) &&
    boundedString(operation.tool, 128) !== null &&
    (operation.capability === "read" ||
      operation.capability === "query" ||
      operation.capability === "draft" ||
      operation.capability === "write")
  );
}

function boundedString(value: unknown, maxChars: number) {
  return typeof value === "string" && value.length > 0 && value.length <= maxChars ? value : null;
}

function sign(value: string, secret: string, signingContext: string) {
  return createHmac("sha256", secret)
    .update(signingContext)
    .update("\0")
    .update(value)
    .digest("base64url");
}

function safeEqual(expected: string, actual: string) {
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

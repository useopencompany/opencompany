import { createHmac, timingSafeEqual } from "node:crypto";

// External engines run inside the sandbox and initiate MCP calls themselves. The raw
// RUNNER_INTERNAL_TOKEN must never enter that sandbox: handing an engine the broad,
// multi-route token
// would let a leaked ticket reach the brain-capture and task-runner routes too. This
// ticket is a narrow, short-lived capability bound to one persisted session, Run,
// Attempt, and lease. It carries no Actor or workspace identity and grants no access
// to other runner routes, the same way createCodingWorkspaceTicket scopes preview access.
const TICKET_VERSION = 2;

export type ExternalEngineGatewayLegacyTicketPayload = {
  v: 1;
  codexChatSessionId: string;
  codexChatTurnId: string;
  expiresAt: number;
};

export type ExternalEngineGatewayTicketPayload = {
  v: 2;
  codexChatSessionId: string;
  codexChatTurnId: string;
  attemptId: string;
  leaseId: string;
  expiresAt: number;
};

export type VerifiedExternalEngineGatewayTicket =
  | ExternalEngineGatewayLegacyTicketPayload
  | ExternalEngineGatewayTicketPayload;

export function createExternalEngineGatewayTicket(input: {
  codexChatSessionId: string;
  codexChatTurnId: string;
  attemptId: string;
  leaseId: string;
  secret: string;
  now?: number;
  ttlMs?: number;
}) {
  const expiresAt = (input.now ?? Date.now()) + (input.ttlMs ?? 60 * 60_000);
  const encodedPayload = Buffer.from(
    JSON.stringify({
      v: TICKET_VERSION,
      codexChatSessionId: input.codexChatSessionId,
      codexChatTurnId: input.codexChatTurnId,
      attemptId: input.attemptId,
      leaseId: input.leaseId,
      expiresAt,
    } satisfies ExternalEngineGatewayTicketPayload),
  ).toString("base64url");
  const signature = sign(encodedPayload, input.secret);

  return { ticket: `${encodedPayload}.${signature}`, expiresAt };
}

export function verifyExternalEngineGatewayTicket(input: {
  ticket: string;
  secret: string;
  now?: number;
}): VerifiedExternalEngineGatewayTicket | null {
  if (!input.ticket || input.ticket.length > 4_096) return null;
  const separator = input.ticket.lastIndexOf(".");
  if (separator <= 0) return null;

  const encodedPayload = input.ticket.slice(0, separator);
  const suppliedSignature = input.ticket.slice(separator + 1);
  if (!safeEqual(sign(encodedPayload, input.secret), suppliedSignature)) return null;

  try {
    const value = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as Partial<VerifiedExternalEngineGatewayTicket>;
    if (
      (value.v !== 1 && value.v !== TICKET_VERSION) ||
      typeof value.codexChatSessionId !== "string" ||
      !value.codexChatSessionId ||
      typeof value.codexChatTurnId !== "string" ||
      !value.codexChatTurnId ||
      typeof value.expiresAt !== "number" ||
      !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt <= (input.now ?? Date.now())
    ) {
      return null;
    }
    if (
      value.v === TICKET_VERSION &&
      (typeof value.attemptId !== "string" ||
        !value.attemptId ||
        typeof value.leaseId !== "string" ||
        !value.leaseId)
    ) {
      return null;
    }
    return value as VerifiedExternalEngineGatewayTicket;
  } catch {
    return null;
  }
}

function sign(value: string, secret: string) {
  // Keep the original HMAC domain separator so already-minted v1/v2 capabilities
  // remain valid through a rolling deployment.
  return createHmac("sha256", secret)
    .update("goat-claude-action-gateway-ticket")
    .update("\0")
    .update(value)
    .digest("base64url");
}

function safeEqual(expected: string, actual: string) {
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

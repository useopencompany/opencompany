import { createHmac, timingSafeEqual } from "node:crypto";

// Claude Code's `claude` process runs inside the sandbox and can only call custom
// tools over MCP, which it initiates itself — unlike Codex, where dynamic tool calls
// round-trip through the trusted runner host process and the raw RUNNER_INTERNAL_TOKEN
// never enters the sandbox. Handing the sandboxed agent that broad, multi-route token
// would let a leaked ticket reach the brain-capture and task-runner routes too. This
// ticket is a narrow, short-lived capability bound to one turn: it proves the caller
// was minted by the runner for this codexChatSessionId/codexChatTurnId pair and
// nothing else, the same way createGoatCodingWorkspaceTicket scopes preview access.
const TICKET_VERSION = 1;

type GoatClaudeActionGatewayTicketPayload = {
  v: 1;
  codexChatSessionId: string;
  codexChatTurnId: string;
  expiresAt: number;
};

export function createGoatClaudeActionGatewayTicket(input: {
  codexChatSessionId: string;
  codexChatTurnId: string;
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
      expiresAt,
    } satisfies GoatClaudeActionGatewayTicketPayload),
  ).toString("base64url");
  const signature = sign(encodedPayload, input.secret);

  return { ticket: `${encodedPayload}.${signature}`, expiresAt };
}

export function verifyGoatClaudeActionGatewayTicket(input: {
  ticket: string;
  secret: string;
  now?: number;
}): GoatClaudeActionGatewayTicketPayload | null {
  const separator = input.ticket.lastIndexOf(".");
  if (separator <= 0) return null;

  const encodedPayload = input.ticket.slice(0, separator);
  const suppliedSignature = input.ticket.slice(separator + 1);
  if (!safeEqual(sign(encodedPayload, input.secret), suppliedSignature)) return null;

  try {
    const value = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as Partial<GoatClaudeActionGatewayTicketPayload>;
    if (
      value.v !== TICKET_VERSION ||
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
    return value as GoatClaudeActionGatewayTicketPayload;
  } catch {
    return null;
  }
}

function sign(value: string, secret: string) {
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

import { createHmac, timingSafeEqual } from "node:crypto";

const DICTATION_TICKET_VERSION = 1;

type GoatDictationTicketPayload = {
  v: 1;
  userWorkosId: string;
  expiresAt: number;
};

export function createGoatDictationTicket(input: {
  userWorkosId: string;
  secret: string;
  now?: number;
  ttlMs?: number;
}) {
  const expiresAt = (input.now ?? Date.now()) + (input.ttlMs ?? 60_000);
  const encodedPayload = Buffer.from(
    JSON.stringify({
      v: DICTATION_TICKET_VERSION,
      userWorkosId: input.userWorkosId,
      expiresAt,
    } satisfies GoatDictationTicketPayload),
  ).toString("base64url");
  const signature = sign("goat-dictation-ticket", encodedPayload, input.secret);

  return { ticket: `${encodedPayload}.${signature}`, expiresAt };
}

export function verifyGoatDictationTicket(input: {
  ticket: string;
  secret: string;
  now?: number;
}): GoatDictationTicketPayload | null {
  const separator = input.ticket.lastIndexOf(".");
  if (separator <= 0) return null;

  const encodedPayload = input.ticket.slice(0, separator);
  const suppliedSignature = input.ticket.slice(separator + 1);
  if (!safeEqual(sign("goat-dictation-ticket", encodedPayload, input.secret), suppliedSignature)) {
    return null;
  }

  try {
    const value = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as Partial<GoatDictationTicketPayload>;
    if (
      value.v !== DICTATION_TICKET_VERSION ||
      typeof value.userWorkosId !== "string" ||
      !value.userWorkosId ||
      typeof value.expiresAt !== "number" ||
      !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt <= (input.now ?? Date.now())
    ) {
      return null;
    }
    return value as GoatDictationTicketPayload;
  } catch {
    return null;
  }
}

function sign(namespace: string, value: string, secret: string) {
  return createHmac("sha256", secret)
    .update(namespace)
    .update("\0")
    .update(value)
    .digest("base64url");
}

function safeEqual(expected: string, actual: string) {
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

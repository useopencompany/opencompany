import { createHmac, timingSafeEqual } from "node:crypto";

export type SessionStreamTokenPayload = {
  sessionId: string;
  userId: string;
  expiresAt: number;
};

export function createSessionStreamToken(payload: SessionStreamTokenPayload, secret: string) {
  const body = base64UrlEncode(JSON.stringify(payload));
  const signature = sign(body, secret);
  return `${body}.${signature}`;
}

export function verifySessionStreamToken(token: string, secret: string): SessionStreamTokenPayload {
  const [body, signature] = token.split(".");
  if (!body || !signature) {
    throw new Error("Invalid stream token.");
  }

  const expected = sign(body, secret);
  if (!safeEqual(signature, expected)) {
    throw new Error("Invalid stream token signature.");
  }

  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
  if (!isPayload(payload)) {
    throw new Error("Invalid stream token payload.");
  }

  if (payload.expiresAt < Date.now()) {
    throw new Error("Stream token has expired.");
  }

  return payload;
}

function sign(body: string, secret: string) {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function isPayload(value: unknown): value is SessionStreamTokenPayload {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.sessionId === "string" &&
    typeof record.userId === "string" &&
    typeof record.expiresAt === "number"
  );
}

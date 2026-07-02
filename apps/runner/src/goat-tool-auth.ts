import { createHmac, timingSafeEqual } from "node:crypto";

export type GoatToolTokenPayload = {
  taskId: string;
  userWorkosId: string;
  expiresAt: number;
};

export function createGoatToolToken(input: {
  taskId: string;
  userWorkosId: string;
  secret: string;
  expiresInMs: number;
}) {
  const payload: GoatToolTokenPayload = {
    taskId: input.taskId,
    userWorkosId: input.userWorkosId,
    expiresAt: Date.now() + input.expiresInMs,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${signBody(body, input.secret)}`;
}

export function verifyGoatToolToken(input: {
  token: string;
  secret: string;
  taskId: string;
}): GoatToolTokenPayload {
  const [body, signature] = input.token.split(".");
  if (!body || !signature || !safeEqual(signature, signBody(body, input.secret))) {
    throw new Error("Invalid Goat tool token.");
  }

  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
  if (!isGoatToolTokenPayload(payload) || payload.taskId !== input.taskId) {
    throw new Error("Invalid Goat tool token payload.");
  }
  if (payload.expiresAt < Date.now()) {
    throw new Error("Goat tool token expired.");
  }
  return payload;
}

function signBody(body: string, secret: string) {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isGoatToolTokenPayload(value: unknown): value is GoatToolTokenPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.taskId === "string" &&
    typeof record.userWorkosId === "string" &&
    typeof record.expiresAt === "number"
  );
}

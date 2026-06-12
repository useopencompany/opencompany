import { createHmac, timingSafeEqual } from "node:crypto";
import {
  assertResendResponse,
  getResendClient,
  isResendNotFoundError,
  type ResendEmailClient,
  trimmed,
} from "@/lib/email/client";

const UNSUBSCRIBE_TOKEN_VERSION = 1;
const SIGNATURE_ALGORITHM = "sha256";

type EmailUnsubscribeType = "signup_welcome";

type EmailUnsubscribeTokenPayload = {
  v: typeof UNSUBSCRIBE_TOKEN_VERSION;
  email: string;
  type: EmailUnsubscribeType;
};

function getAppUrl() {
  const explicit = trimmed(process.env.NEXT_PUBLIC_APP_URL);
  if (explicit) return explicit.replace(/\/$/, "");

  const redirectUri = trimmed(process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI);
  if (redirectUri) return new URL(redirectUri).origin;

  return "http://localhost:3000";
}

function getEmailSecret() {
  const apiKey = trimmed(process.env.RESEND_API_KEY);
  if (!apiKey) throw new Error("RESEND_API_KEY is required for email unsubscribe links.");
  return apiKey;
}

function encodeJson(value: EmailUnsubscribeTokenPayload) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeJson(value: string): unknown {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function signPayload(encodedPayload: string, secret: string) {
  return createHmac(SIGNATURE_ALGORITHM, secret).update(encodedPayload).digest("base64url");
}

function equalSignatures(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function parsePayload(value: unknown): EmailUnsubscribeTokenPayload {
  if (!value || typeof value !== "object") throw new Error("Invalid unsubscribe token.");

  const payload = value as Record<string, unknown>;
  if (payload.v !== UNSUBSCRIBE_TOKEN_VERSION) throw new Error("Invalid unsubscribe token.");
  if (payload.type !== "signup_welcome") throw new Error("Invalid unsubscribe token.");
  if (typeof payload.email !== "string" || !payload.email.includes("@")) {
    throw new Error("Invalid unsubscribe token.");
  }

  return {
    v: UNSUBSCRIBE_TOKEN_VERSION,
    type: "signup_welcome",
    email: payload.email,
  };
}

export function createEmailUnsubscribeToken(input: {
  email: string;
  type: EmailUnsubscribeType;
  secret?: string;
}) {
  const email = input.email.trim().toLowerCase();
  if (!email.includes("@")) throw new Error("A valid email is required for unsubscribe links.");

  const payload = encodeJson({
    v: UNSUBSCRIBE_TOKEN_VERSION,
    email,
    type: input.type,
  });
  const signature = signPayload(payload, input.secret ?? getEmailSecret());

  return `${payload}.${signature}`;
}

export function verifyEmailUnsubscribeToken(token: string, secret = getEmailSecret()) {
  const [encodedPayload, signature, extra] = token.split(".");
  if (!encodedPayload || !signature || extra) throw new Error("Invalid unsubscribe token.");

  const expectedSignature = signPayload(encodedPayload, secret);
  if (!equalSignatures(signature, expectedSignature)) throw new Error("Invalid unsubscribe token.");

  return parsePayload(decodeJson(encodedPayload));
}

export function createEmailUnsubscribeUrl(input: {
  email: string;
  type: EmailUnsubscribeType;
  baseUrl?: string;
  secret?: string;
}) {
  const url = new URL("/api/email/unsubscribe", input.baseUrl ?? getAppUrl());
  url.searchParams.set(
    "token",
    createEmailUnsubscribeToken({
      email: input.email,
      type: input.type,
      ...(input.secret ? { secret: input.secret } : {}),
    }),
  );
  return url.toString();
}

export async function unsubscribeResendContact(input: {
  token: string;
  client?: ResendEmailClient;
}) {
  const payload = verifyEmailUnsubscribeToken(input.token);
  const client = input.client ?? getResendClient(getEmailSecret());

  const updateResponse = await client.contacts.update({
    email: payload.email,
    unsubscribed: true,
  });

  if (!updateResponse.error) {
    return {
      status: "unsubscribed" as const,
      email: payload.email,
      contactId: updateResponse.data.id,
    };
  }

  if (!isResendNotFoundError(updateResponse.error)) {
    throw new Error(`Unable to unsubscribe Resend contact: ${updateResponse.error.message}`);
  }

  const createResponse = await client.contacts.create({
    email: payload.email,
    unsubscribed: true,
  });

  const contact = assertResendResponse(createResponse, "Unable to create unsubscribed contact");

  return {
    status: "unsubscribed" as const,
    email: payload.email,
    contactId: contact.id,
  };
}

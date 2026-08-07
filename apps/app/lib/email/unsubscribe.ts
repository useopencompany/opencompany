import { createHmac, timingSafeEqual } from "node:crypto";
import { skipPendingGoatOnboardingEmailsForEmail } from "@opencompany/db/onboarding-emails";
import { getGoatAppUrl } from "@/lib/app-url";
import { trimmed } from "@/lib/email/client";

// Signed one-click unsubscribe, mirrored from apps/web/lib/email/unsubscribe.ts.
// The token is an HMAC over {email, type} using RESEND_API_KEY as the signing
// secret (same convention as web — it never leaves the server). Unsubscribing
// stops the remaining onboarding sequence for that address; there is no Resend
// contact to flip because Goat does not sync contacts/segments.

const UNSUBSCRIBE_TOKEN_VERSION = 1;
const SIGNATURE_ALGORITHM = "sha256";

type EmailUnsubscribeType = "goat_onboarding";

type EmailUnsubscribeTokenPayload = {
  v: typeof UNSUBSCRIBE_TOKEN_VERSION;
  email: string;
  type: EmailUnsubscribeType;
};

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
  if (payload.type !== "goat_onboarding") throw new Error("Invalid unsubscribe token.");
  if (typeof payload.email !== "string" || !payload.email.includes("@")) {
    throw new Error("Invalid unsubscribe token.");
  }

  return {
    v: UNSUBSCRIBE_TOKEN_VERSION,
    type: "goat_onboarding",
    email: payload.email,
  };
}

export function createGoatEmailUnsubscribeToken(input: { email: string; secret?: string }) {
  const email = input.email.trim().toLowerCase();
  if (!email.includes("@")) throw new Error("A valid email is required for unsubscribe links.");

  const payload = encodeJson({
    v: UNSUBSCRIBE_TOKEN_VERSION,
    email,
    type: "goat_onboarding",
  });
  const signature = signPayload(payload, input.secret ?? getEmailSecret());

  return `${payload}.${signature}`;
}

export function verifyGoatEmailUnsubscribeToken(token: string, secret = getEmailSecret()) {
  const [encodedPayload, signature, extra] = token.split(".");
  if (!encodedPayload || !signature || extra) throw new Error("Invalid unsubscribe token.");

  const expectedSignature = signPayload(encodedPayload, secret);
  if (!equalSignatures(signature, expectedSignature)) throw new Error("Invalid unsubscribe token.");

  return parsePayload(decodeJson(encodedPayload));
}

export function createGoatEmailUnsubscribeUrl(input: {
  email: string;
  baseUrl?: string;
  secret?: string;
}) {
  const base = input.baseUrl ?? getGoatAppUrl();
  const url = new URL("/api/email/unsubscribe", base);
  url.searchParams.set(
    "token",
    createGoatEmailUnsubscribeToken({
      email: input.email,
      ...(input.secret ? { secret: input.secret } : {}),
    }),
  );
  return url.toString();
}

export async function unsubscribeGoatOnboardingEmails(input: { token: string }) {
  const payload = verifyGoatEmailUnsubscribeToken(input.token);
  const skipped = await skipPendingGoatOnboardingEmailsForEmail(payload.email);
  return { status: "unsubscribed" as const, email: payload.email, skipped };
}

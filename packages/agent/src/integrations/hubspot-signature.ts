import { createHmac, timingSafeEqual } from "node:crypto";

// HubSpot v3 signatures sign `method + uri + body + timestamp` with the app's
// client secret and send the base64 digest in `X-HubSpot-Signature-v3`; the
// `X-HubSpot-Request-Timestamp` header (epoch ms) guards against replays.
// Behind proxies the observed request URL can differ from the URI HubSpot
// signed, so callers pass every plausible candidate (observed URL and the
// canonical app URL). Kept free of db/auth imports so the webhook route and
// its tests stay light.
export const HUBSPOT_SIGNATURE_MAX_AGE_MS = 5 * 60_000;

export function verifyHubspotWebhookSignature(input: {
  method: string;
  candidateUris: readonly string[];
  rawBody: string;
  signature: string | null;
  timestampHeader: string | null;
  nowMs?: number;
}): boolean {
  const secret = process.env.OPENCOMPANY_HUBSPOT_CLIENT_SECRET?.trim();
  if (!secret || !input.signature || !input.timestampHeader) return false;
  const timestampMs = Number(input.timestampHeader);
  if (!Number.isFinite(timestampMs)) return false;
  const nowMs = input.nowMs ?? Date.now();
  if (Math.abs(nowMs - timestampMs) > HUBSPOT_SIGNATURE_MAX_AGE_MS) return false;

  const signature = Buffer.from(input.signature);
  return input.candidateUris.some((uri) => {
    const expected = Buffer.from(
      createHmac("sha256", secret)
        .update(`${input.method}${uri}${input.rawBody}${input.timestampHeader}`)
        .digest("base64"),
    );
    return signature.length === expected.length && timingSafeEqual(signature, expected);
  });
}

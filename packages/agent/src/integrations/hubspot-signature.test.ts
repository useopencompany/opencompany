import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyHubspotWebhookSignature } from "./hubspot-signature";

const SECRET = "test-client-secret";
const URI = "https://opencompany.example.com/api/webhooks/hubspot/events";
const NOW_MS = 1_784_192_000_000;

function sign(input: { method?: string; uri?: string; rawBody: string; timestamp: string }) {
  return createHmac("sha256", SECRET)
    .update(`${input.method ?? "POST"}${input.uri ?? URI}${input.rawBody}${input.timestamp}`)
    .digest("base64");
}

describe("verifyHubspotWebhookSignature", () => {
  beforeEach(() => {
    process.env.OPENCOMPANY_HUBSPOT_CLIENT_SECRET = SECRET;
  });
  afterEach(() => {
    delete process.env.OPENCOMPANY_HUBSPOT_CLIENT_SECRET;
  });

  it("accepts a valid v3 signature", () => {
    const rawBody = JSON.stringify([{ eventId: 1 }]);
    const timestamp = String(NOW_MS);
    expect(
      verifyHubspotWebhookSignature({
        method: "POST",
        candidateUris: [URI],
        rawBody,
        signature: sign({ rawBody, timestamp }),
        timestampHeader: timestamp,
        nowMs: NOW_MS,
      }),
    ).toBe(true);
  });

  it("accepts when any candidate uri matches", () => {
    const rawBody = "[]";
    const timestamp = String(NOW_MS);
    expect(
      verifyHubspotWebhookSignature({
        method: "POST",
        candidateUris: ["https://internal.host/api/webhooks/hubspot/events", URI],
        rawBody,
        signature: sign({ rawBody, timestamp }),
        timestampHeader: timestamp,
        nowMs: NOW_MS,
      }),
    ).toBe(true);
  });

  it("rejects a signature from another secret, body, or uri", () => {
    const rawBody = "[]";
    const timestamp = String(NOW_MS);
    const valid = sign({ rawBody, timestamp });
    expect(
      verifyHubspotWebhookSignature({
        method: "POST",
        candidateUris: [URI],
        rawBody: "tampered",
        signature: valid,
        timestampHeader: timestamp,
        nowMs: NOW_MS,
      }),
    ).toBe(false);
    expect(
      verifyHubspotWebhookSignature({
        method: "POST",
        candidateUris: ["https://other.example.com/hook"],
        rawBody,
        signature: valid,
        timestampHeader: timestamp,
        nowMs: NOW_MS,
      }),
    ).toBe(false);
  });

  it("rejects stale timestamps and missing inputs", () => {
    const rawBody = "[]";
    const staleTimestamp = String(NOW_MS - 6 * 60_000);
    expect(
      verifyHubspotWebhookSignature({
        method: "POST",
        candidateUris: [URI],
        rawBody,
        signature: sign({ rawBody, timestamp: staleTimestamp }),
        timestampHeader: staleTimestamp,
        nowMs: NOW_MS,
      }),
    ).toBe(false);
    expect(
      verifyHubspotWebhookSignature({
        method: "POST",
        candidateUris: [URI],
        rawBody,
        signature: null,
        timestampHeader: String(NOW_MS),
        nowMs: NOW_MS,
      }),
    ).toBe(false);
    delete process.env.OPENCOMPANY_HUBSPOT_CLIENT_SECRET;
    const timestamp = String(NOW_MS);
    expect(
      verifyHubspotWebhookSignature({
        method: "POST",
        candidateUris: [URI],
        rawBody,
        signature: sign({ rawBody, timestamp }),
        timestampHeader: timestamp,
        nowMs: NOW_MS,
      }),
    ).toBe(false);
  });
});

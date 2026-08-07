import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifySlackEventSignature } from "./slack-signature";

const DEFAULT_SECRET = "ingestion-secret";
const BOT_SECRET = "bot-secret";

function sign(rawBody: string, timestamp: string, secret: string) {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
}

describe("verifySlackEventSignature", () => {
  const nowMs = 1_700_000_000_000;
  const timestamp = String(Math.floor(nowMs / 1000));

  beforeEach(() => {
    process.env.SLACK_SIGNING_SECRET = DEFAULT_SECRET;
  });
  afterEach(() => {
    delete process.env.SLACK_SIGNING_SECRET;
  });

  it("verifies against the env secret by default", () => {
    const rawBody = JSON.stringify({ type: "event_callback" });
    expect(
      verifySlackEventSignature({
        rawBody,
        timestamp,
        signature: sign(rawBody, timestamp, DEFAULT_SECRET),
        nowMs,
      }),
    ).toBe(true);
  });

  it("verifies against an explicit secret when provided", () => {
    const rawBody = "{}";
    expect(
      verifySlackEventSignature({
        rawBody,
        timestamp,
        signature: sign(rawBody, timestamp, BOT_SECRET),
        nowMs,
        secret: BOT_SECRET,
      }),
    ).toBe(true);
    // The explicit secret replaces the env secret rather than augmenting it.
    expect(
      verifySlackEventSignature({
        rawBody,
        timestamp,
        signature: sign(rawBody, timestamp, DEFAULT_SECRET),
        nowMs,
        secret: BOT_SECRET,
      }),
    ).toBe(false);
  });

  it("rejects when the explicit secret is missing or empty", () => {
    const rawBody = "{}";
    delete process.env.SLACK_SIGNING_SECRET;
    expect(
      verifySlackEventSignature({
        rawBody,
        timestamp,
        signature: sign(rawBody, timestamp, BOT_SECRET),
        nowMs,
        secret: undefined,
      }),
    ).toBe(false);
  });

  it("rejects replays outside the timestamp window", () => {
    const rawBody = "{}";
    const staleTimestamp = String(Math.floor(nowMs / 1000) - 600);
    expect(
      verifySlackEventSignature({
        rawBody,
        timestamp: staleTimestamp,
        signature: sign(rawBody, staleTimestamp, BOT_SECRET),
        nowMs,
        secret: BOT_SECRET,
      }),
    ).toBe(false);
  });
});

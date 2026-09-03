import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySlackEventSignature } from "./slack-signature";

const BOT_SECRET = "bot-secret";

function sign(rawBody: string, timestamp: string, secret: string) {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
}

describe("verifySlackEventSignature", () => {
  const nowMs = 1_700_000_000_000;
  const timestamp = String(Math.floor(nowMs / 1000));

  it("verifies against the caller-supplied secret", () => {
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
  });

  it("rejects when the explicit secret is missing or empty", () => {
    const rawBody = "{}";
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

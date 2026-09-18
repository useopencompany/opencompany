import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyConvexWebhookSignature } from "./convex-webhook-auth";

const SECRET = "convex_hmac_secret_value";
const BODY = JSON.stringify([{ topic: "verification", timestamp: 1, message: "ok" }]);

function sign(body: string, secret = SECRET) {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

describe("verifyConvexWebhookSignature", () => {
  it("accepts the signature Convex computes over the exact body", () => {
    expect(
      verifyConvexWebhookSignature({ body: BODY, signature: sign(BODY), secret: SECRET }),
    ).toBe(true);
  });

  it("accepts the digest without Convex's sha256= prefix", () => {
    expect(
      verifyConvexWebhookSignature({
        body: BODY,
        signature: sign(BODY).replace("sha256=", ""),
        secret: SECRET,
      }),
    ).toBe(true);
  });

  it("rejects a body, a secret, or a digest that does not match", () => {
    expect(
      verifyConvexWebhookSignature({ body: `${BODY} `, signature: sign(BODY), secret: SECRET }),
    ).toBe(false);
    expect(
      verifyConvexWebhookSignature({
        body: BODY,
        signature: sign(BODY, "someone-elses-secret"),
        secret: SECRET,
      }),
    ).toBe(false);
    expect(verifyConvexWebhookSignature({ body: BODY, signature: "sha256=", secret: SECRET })).toBe(
      false,
    );
  });

  it("rejects a missing signature or a connection with no stored secret", () => {
    expect(verifyConvexWebhookSignature({ body: BODY, signature: null, secret: SECRET })).toBe(
      false,
    );
    expect(verifyConvexWebhookSignature({ body: BODY, signature: sign(BODY), secret: null })).toBe(
      false,
    );
  });

  it("rejects a malformed digest instead of throwing on the length comparison", () => {
    expect(
      verifyConvexWebhookSignature({ body: BODY, signature: "sha256=zz", secret: SECRET }),
    ).toBe(false);
    expect(
      verifyConvexWebhookSignature({
        body: BODY,
        signature: `sha256=${"a".repeat(63)}`,
        secret: SECRET,
      }),
    ).toBe(false);
  });
});

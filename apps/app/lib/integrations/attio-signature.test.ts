import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyAttioWebhookSignature } from "./attio-signature";

const SECRET = "attio-webhook-secret";

function sign(body: string, secret = SECRET) {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

describe("verifyAttioWebhookSignature", () => {
  it("accepts the hex HMAC of the raw body", () => {
    const rawBody = JSON.stringify({ webhook_id: "wh_1", events: [] });
    expect(
      verifyAttioWebhookSignature({
        rawBody,
        signature: sign(rawBody),
        secret: SECRET,
      }),
    ).toBe(true);
  });

  it("rejects a signature minted with a different secret", () => {
    const rawBody = JSON.stringify({ webhook_id: "wh_1", events: [] });
    expect(
      verifyAttioWebhookSignature({
        rawBody,
        signature: sign(rawBody, "other-secret"),
        secret: SECRET,
      }),
    ).toBe(false);
  });

  it("rejects when the body was tampered with", () => {
    const rawBody = JSON.stringify({ webhook_id: "wh_1", events: [] });
    expect(
      verifyAttioWebhookSignature({
        rawBody: `${rawBody} `,
        signature: sign(rawBody),
        secret: SECRET,
      }),
    ).toBe(false);
  });

  it("rejects missing signatures and missing secrets", () => {
    const rawBody = "{}";
    expect(verifyAttioWebhookSignature({ rawBody, signature: null, secret: SECRET })).toBe(false);
    expect(verifyAttioWebhookSignature({ rawBody, signature: sign(rawBody), secret: null })).toBe(
      false,
    );
    expect(
      verifyAttioWebhookSignature({ rawBody, signature: sign(rawBody), secret: undefined }),
    ).toBe(false);
  });

  it("tolerates surrounding whitespace in the header value", () => {
    const rawBody = JSON.stringify({ webhook_id: "wh_1" });
    expect(
      verifyAttioWebhookSignature({
        rawBody,
        signature: ` ${sign(rawBody)} `,
        secret: SECRET,
      }),
    ).toBe(true);
  });
});

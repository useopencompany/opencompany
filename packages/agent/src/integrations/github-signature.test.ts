import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyGitHubWebhookSignature } from "./github-signature";

const SECRET = "github-webhook-secret";
const BODY = JSON.stringify({ action: "opened" });

function sign(body: string) {
  return `sha256=${createHmac("sha256", SECRET).update(body, "utf8").digest("hex")}`;
}

describe("verifyGitHubWebhookSignature", () => {
  it("accepts GitHub's sha256 signature for the unmodified body", () => {
    expect(
      verifyGitHubWebhookSignature({ rawBody: BODY, signature: sign(BODY), secret: SECRET }),
    ).toBe(true);
  });

  it.each([null, "", "sha1=29e9c87c7a6c595b4f46c310043b5a92e7fa5192", "sha256=invalid"])(
    "rejects an invalid signature: %s",
    (signature) => {
      expect(verifyGitHubWebhookSignature({ rawBody: BODY, signature, secret: SECRET })).toBe(
        false,
      );
    },
  );

  it("rejects a changed body or missing secret", () => {
    expect(
      verifyGitHubWebhookSignature({
        rawBody: `${BODY} `,
        signature: sign(BODY),
        secret: SECRET,
      }),
    ).toBe(false);
    expect(verifyGitHubWebhookSignature({ rawBody: BODY, signature: sign(BODY), secret: "" })).toBe(
      false,
    );
  });
});

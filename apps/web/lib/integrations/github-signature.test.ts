import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyGitHubWebhookSignature } from "./github-signature";

const SECRET = "test-webhook-secret";

function sign(rawBody: string, secret = SECRET) {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

describe("verifyGitHubWebhookSignature", () => {
  beforeEach(() => {
    process.env.GITHUB_INTEGRATION_APP_WEBHOOK_SECRET = SECRET;
  });
  afterEach(() => {
    delete process.env.GITHUB_INTEGRATION_APP_WEBHOOK_SECRET;
  });

  it("accepts a valid signature", () => {
    const rawBody = JSON.stringify({ action: "closed" });
    expect(verifyGitHubWebhookSignature({ rawBody, signature: sign(rawBody) })).toBe(true);
  });

  it("rejects a signature from another secret or body", () => {
    const rawBody = JSON.stringify({ action: "closed" });
    expect(verifyGitHubWebhookSignature({ rawBody, signature: sign(rawBody, "other") })).toBe(
      false,
    );
    expect(verifyGitHubWebhookSignature({ rawBody: "tampered", signature: sign(rawBody) })).toBe(
      false,
    );
  });

  it("rejects when the signature or secret is missing", () => {
    const rawBody = "{}";
    expect(verifyGitHubWebhookSignature({ rawBody, signature: null })).toBe(false);
    delete process.env.GITHUB_INTEGRATION_APP_WEBHOOK_SECRET;
    expect(verifyGitHubWebhookSignature({ rawBody, signature: sign(rawBody) })).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  hashGoatJamieWebhookApiKey,
  isValidJamieProviderApiKey,
  verifyGoatJamieWebhookApiKey,
} from "./jamie";

describe("Goat Jamie webhook API keys", () => {
  const jamieApiKey = "sk_0000000000000000000000000000000000000000000000000000000000000000";

  it("accepts Jamie-issued API keys before a key is bound", () => {
    expect(isValidJamieProviderApiKey(jamieApiKey)).toBe(true);
    expect(
      verifyGoatJamieWebhookApiKey({
        candidate: jamieApiKey,
        apiKeyHash: null,
      }),
    ).toEqual({ valid: true, shouldBind: true, apiKey: jamieApiKey });
  });

  it("rejects non-Jamie API keys before a key is bound", () => {
    expect(isValidJamieProviderApiKey("jwhsec_legacy")).toBe(false);
    expect(
      verifyGoatJamieWebhookApiKey({
        candidate: "jwhsec_legacy",
        apiKeyHash: null,
      }),
    ).toEqual({ valid: false, shouldBind: false, apiKey: null });
  });

  it("verifies bound Jamie API keys without storing plaintext in the hash", () => {
    const apiKeyHash = hashGoatJamieWebhookApiKey(jamieApiKey);

    expect(apiKeyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(apiKeyHash).not.toContain(jamieApiKey);
    expect(
      verifyGoatJamieWebhookApiKey({
        candidate: jamieApiKey,
        apiKeyHash,
      }),
    ).toEqual({ valid: true, shouldBind: false, apiKey: jamieApiKey });
    expect(
      verifyGoatJamieWebhookApiKey({
        candidate: `${jamieApiKey}0`,
        apiKeyHash,
      }),
    ).toEqual({ valid: false, shouldBind: false, apiKey: null });
  });
});

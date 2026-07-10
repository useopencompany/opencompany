import { describe, expect, it } from "vitest";
import {
  hashGoatJamieWebhookApiKey,
  isValidJamieProviderApiKey,
  verifyGoatJamieWebhookApiKey,
} from "./jamie";

describe("Goat Jamie webhook API keys", () => {
  const jamieApiKey = "sk_0000000000000000000000000000000000000000000000000000000000000000";

  it("recognizes Jamie-issued API key shape", () => {
    expect(isValidJamieProviderApiKey(jamieApiKey)).toBe(true);
  });

  it("rejects delivery API keys before a key is saved", () => {
    expect(isValidJamieProviderApiKey("jwhsec_legacy")).toBe(false);
    expect(
      verifyGoatJamieWebhookApiKey({
        candidate: jamieApiKey,
        apiKeyHash: null,
      }),
    ).toEqual({ valid: false, apiKey: null });
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
    ).toEqual({ valid: true, apiKey: jamieApiKey });
    expect(
      verifyGoatJamieWebhookApiKey({
        candidate: `${jamieApiKey}0`,
        apiKeyHash,
      }),
    ).toEqual({ valid: false, apiKey: null });
  });
});

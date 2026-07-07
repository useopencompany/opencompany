import { describe, expect, it } from "vitest";
import {
  generateGoatJamieWebhookSecret,
  hashGoatJamieWebhookSecret,
  verifyGoatJamieWebhookSecret,
} from "./jamie";

describe("Goat Jamie integration secrets", () => {
  it("generates verifiable webhook secrets without storing plaintext in the hash", () => {
    const secret = generateGoatJamieWebhookSecret();
    const secretHash = hashGoatJamieWebhookSecret(secret);

    expect(secret).toMatch(/^jwhsec_/);
    expect(secretHash).toMatch(/^[a-f0-9]{64}$/);
    expect(secretHash).not.toContain(secret);
    expect(verifyGoatJamieWebhookSecret({ candidate: secret, secretHash })).toBe(true);
    expect(verifyGoatJamieWebhookSecret({ candidate: `${secret}-wrong`, secretHash })).toBe(false);
  });
});

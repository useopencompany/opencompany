import { describe, expect, it } from "vitest";
import { verifyJamieWebhookKey } from "./jamie-webhook-auth";

describe("verifyJamieWebhookKey", () => {
  it("accepts the stored key and rejects anything else", () => {
    expect(verifyJamieWebhookKey({ presented: "sk_abc", expected: "sk_abc" })).toBe(true);
    expect(verifyJamieWebhookKey({ presented: "sk_abd", expected: "sk_abc" })).toBe(false);
    // A length mismatch must not reach timingSafeEqual, which throws on unequal buffers.
    expect(verifyJamieWebhookKey({ presented: "sk_abc_longer", expected: "sk_abc" })).toBe(false);
  });

  it("rejects a missing key on either side", () => {
    expect(verifyJamieWebhookKey({ presented: null, expected: "sk_abc" })).toBe(false);
    expect(verifyJamieWebhookKey({ presented: "sk_abc", expected: null })).toBe(false);
    expect(verifyJamieWebhookKey({ presented: "", expected: "" })).toBe(false);
  });
});

import {
  GOAT_STRIPE_API_VERSION,
  isValidGoatStripeRestrictedApiKey,
  validateGoatStripeRestrictedApiKey,
} from "@opencompany/goat-agent/integrations/stripe";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Stripe restricted-key validation", () => {
  it("accepts restricted test/live keys and rejects unrestricted secret keys", () => {
    expect(isValidGoatStripeRestrictedApiKey(`rk_test_${"a".repeat(24)}`)).toBe(true);
    expect(isValidGoatStripeRestrictedApiKey(`rk_live_${"b".repeat(24)}`)).toBe(true);
    expect(isValidGoatStripeRestrictedApiKey(`sk_live_${"c".repeat(24)}`)).toBe(false);
    expect(isValidGoatStripeRestrictedApiKey("rk_live_contains whitespace")).toBe(false);
  });

  it("validates identity and every read endpoint before accepting a key", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          id: "acct_123",
          email: "finance@example.com",
          business_profile: { name: "Acme Inc" },
          country: "US",
        }),
      )
      .mockImplementation(async () => jsonResponse({ data: [], has_more: false }));
    vi.stubGlobal("fetch", fetchMock);
    const apiKey = `rk_live_${"a".repeat(24)}`;

    await expect(validateGoatStripeRestrictedApiKey(apiKey)).resolves.toEqual({
      ok: true,
      identity: {
        accountId: "acct_123",
        accountName: "Acme Inc",
        accountEmail: "finance@example.com",
        country: "US",
        livemode: true,
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      "/v1/account",
      "/v1/balance",
      "/v1/balance_transactions",
      "/v1/subscriptions",
      "/v1/invoices",
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${apiKey}`);
      expect(new Headers(init?.headers).get("Stripe-Version")).toBe(GOAT_STRIPE_API_VERSION);
    }
  });

  it("reports the specific missing read permission", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "acct_123" }))
      .mockResolvedValueOnce(jsonResponse({ available: [], pending: [] }))
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { type: "invalid_request_error", message: "Permission denied" } },
          403,
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(validateGoatStripeRestrictedApiKey(`rk_test_${"a".repeat(24)}`)).resolves.toEqual({
      ok: false,
      error:
        "This restricted key needs read access to Balance (including balance transactions). Update the key's permissions in Stripe and try again.",
    });
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

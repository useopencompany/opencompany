import { describe, expect, it } from "vitest";
import type { ManagedCapabilityActionSpec } from "@/lib/capabilities/catalog";
import {
  assertInspectionMatches,
  calculateMaximumProviderQuoteUsdMicros,
  providerRunCostUsdMicros,
} from "@/lib/capabilities/execute";
import type { MonidInspection, MonidRun } from "@/lib/capabilities/monid";

describe("managed capability contract and money helpers", () => {
  it("quotes per-call and maximum per-result prices in USD micros", () => {
    expect(
      calculateMaximumProviderQuoteUsdMicros(
        inspection({ type: "PER_CALL", amount: 0.3, currency: "USD" }),
        1,
      ),
    ).toBe(300_000);
    expect(
      calculateMaximumProviderQuoteUsdMicros(
        inspection({
          type: "PER_RESULT",
          amount: 0.018,
          flatFee: 0.02,
          currency: "USD",
        }),
        10,
      ),
    ).toBe(200_000);
  });

  it("fails closed on endpoint, price type, and input schema drift", () => {
    const spec = actionSpec();
    expect(() =>
      assertInspectionMatches(
        spec,
        { providerInput: { keyword: "openai" }, resultLimit: 20, canonicalLinks: [] },
        inspection(
          { type: "PER_CALL", amount: 0.0015, currency: "USD" },
          { keyword: { type: "string" } },
        ),
      ),
    ).not.toThrow();
    expect(() =>
      assertInspectionMatches(
        spec,
        { providerInput: { keyword: "openai" }, resultLimit: 20, canonicalLinks: [] },
        {
          ...inspection({ type: "PER_RESULT", amount: 0.0015, currency: "USD" }),
          endpoint: "/changed",
        },
      ),
    ).toThrow(/endpoint|pricing/i);
    expect(() =>
      assertInspectionMatches(
        spec,
        { providerInput: { keyword: "openai" }, resultLimit: 20, canonicalLinks: [] },
        inspection(
          { type: "PER_CALL", amount: 0.0015, currency: "USD" },
          { query: { type: "string" } },
        ),
      ),
    ).toThrow(/input contract/i);
    expect(() =>
      assertInspectionMatches(
        spec,
        { providerInput: { keyword: "openai" }, resultLimit: 20, canonicalLinks: [] },
        inspection(
          { type: "PER_CALL", amount: 0.0015, currency: "USD" },
          {
            type: "object",
            properties: {
              keyword: { type: "number" },
              locale: { type: "string" },
            },
            required: ["keyword", "locale"],
          },
        ),
      ),
    ).toThrow(/input contract/i);
  });

  it("validates the reviewed Monid input location without flattening it", () => {
    const spec = { ...actionSpec(), inputLocation: "queryParams" as const };
    const mapped = {
      providerInput: { keyword: "openai" },
      resultLimit: 20,
      canonicalLinks: [],
    };
    expect(() =>
      assertInspectionMatches(
        spec,
        mapped,
        inspection(
          { type: "PER_CALL", amount: 0.0015, currency: "USD" },
          {
            queryParams: {
              type: "object",
              properties: { keyword: { type: "string" } },
              required: ["keyword"],
            },
          },
        ),
      ),
    ).not.toThrow();
    expect(() =>
      assertInspectionMatches(
        spec,
        mapped,
        inspection(
          { type: "PER_CALL", amount: 0.0015, currency: "USD" },
          { keyword: { type: "string" } },
        ),
      ),
    ).toThrow(/input contract/i);
  });

  it("uses settled cost first and Monid's reported micro-dollar cost otherwise", () => {
    expect(
      providerRunCostUsdMicros(
        run({
          cost: { value: 0.015, currency: "USD" },
          billing: {
            reportedCost: { value: 99_000, unit: "MICRO_DOLLAR", currency: "USD" },
          },
        }),
      ),
    ).toBe(15_000);
    expect(
      providerRunCostUsdMicros(
        run({
          cost: null,
          billing: {
            actualCost: { value: 0, unit: "MICRO_DOLLAR", currency: "USD" },
            reportedCost: { value: 3_000, unit: "MICRO_DOLLAR", currency: "USD" },
          },
        }),
      ),
    ).toBe(3_000);
    expect(providerRunCostUsdMicros(run({ cost: null }))).toBeNull();
  });
});

function inspection(
  price: NonNullable<MonidInspection["price"]>,
  input: unknown = { keyword: { type: "string" } },
): MonidInspection {
  return {
    id: "tikhub:test",
    provider: "tikhub",
    endpoint: "/api/v1/twitter/web/fetch_search_timeline",
    input,
    price,
    tags: ["verified"],
  };
}

function actionSpec(): ManagedCapabilityActionSpec {
  return {
    id: "x.search_posts",
    source: "x",
    description: "Search X",
    params: { type: "object" },
    provider: "tikhub",
    endpoint: "/api/v1/twitter/web/fetch_search_timeline",
    priceType: "PER_CALL",
    executionMode: "sync",
    mapInput: () => ({
      providerInput: { keyword: "openai" },
      resultLimit: 20,
      canonicalLinks: [],
    }),
  };
}

function run(overrides: Partial<MonidRun>): MonidRun {
  return {
    runId: "run_1",
    provider: "tikhub",
    endpoint: "/api/v1/twitter/web/fetch_search_timeline",
    status: "COMPLETED",
    ...overrides,
  };
}

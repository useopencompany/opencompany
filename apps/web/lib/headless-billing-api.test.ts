import { describe, expect, it, vi } from "vitest";
import { getHeadlessBillingBalance } from "./headless-billing-api";

describe("headless billing API", () => {
  it("reads the typed balance resource from the canonical API", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        data: {
          balanceUsdMicros: 2_500_000,
          lowBalanceWarnUsdMicros: 1_000_000,
          enforcementEnabled: true,
        },
        meta: { apiVersion: "v1", protocolVersion: "1" },
      }),
    );

    await expect(
      getHeadlessBillingBalance({
        baseUrl: "https://api.example.test",
        fetch: fetchMock,
      }),
    ).resolves.toEqual({
      balanceUsdMicros: 2_500_000,
      lowBalanceWarnUsdMicros: 1_000_000,
      enforcementEnabled: true,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/v1/billing/balance",
      expect.objectContaining({ credentials: "include" }),
    );
  });
});

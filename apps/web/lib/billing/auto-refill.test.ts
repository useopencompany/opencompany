import { captureProductServerEvent } from "@opencompany/analytics/product/server";
import { captureServerEvent } from "@opencompany/analytics/server";
import { getStripe } from "@opencompany/billing/stripe";
import {
  claimAutoRefill,
  releasePendingForWorkspace,
  settleAutoRefill,
} from "@opencompany/db/billing";
import { recordAutoRefillCredit } from "@opencompany/db/credits";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runAutoRefill } from "./auto-refill";

vi.mock("@opencompany/analytics/product/server", () => ({
  captureProductServerEvent: vi.fn(async () => undefined),
}));

vi.mock("@opencompany/analytics/server", () => ({
  captureServerEvent: vi.fn(async () => undefined),
}));

vi.mock("@opencompany/db/billing", () => ({
  claimAutoRefill: vi.fn(),
  AUTO_REFILL_THRESHOLD_USD_MICROS: 5_000_000,
  listAutoRefillCandidates: vi.fn(async () => []),
  releasePendingForWorkspace: vi.fn(async () => 0),
  settleAutoRefill: vi.fn(async () => undefined),
}));

vi.mock("@opencompany/db/credits", () => ({
  getCreditBalanceUsdMicros: vi.fn(async () => 0),
  usdMicrosToCents: (micros: number) => Math.round(micros / 10_000),
  recordAutoRefillCredit: vi.fn(),
}));

vi.mock("@opencompany/billing/stripe", () => ({
  assertCheckoutEnabled: vi.fn(),
  getStripe: vi.fn(),
}));

const captureProductServerEventMock = vi.mocked(captureProductServerEvent);
const captureServerEventMock = vi.mocked(captureServerEvent);
const claimAutoRefillMock = vi.mocked(claimAutoRefill);
const recordAutoRefillCreditMock = vi.mocked(recordAutoRefillCredit);
const releasePendingForWorkspaceMock = vi.mocked(releasePendingForWorkspace);
const settleAutoRefillMock = vi.mocked(settleAutoRefill);
const getStripeMock = vi.mocked(getStripe);

describe("runAutoRefill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claimAutoRefillMock.mockResolvedValue({
      amountCents: 2_000,
      stripeCustomerId: "cus_123",
      paymentMethodId: "pm_123",
    });
    getStripeMock.mockReturnValue({
      paymentIntents: {
        create: vi.fn(async () => ({ id: "pi_123", status: "succeeded" })),
      },
    } as never);
  });

  it("captures a successfully credited auto-refill in the opencompany project", async () => {
    recordAutoRefillCreditMock.mockResolvedValue({
      ok: true,
      ledgerId: 42,
      balanceUsdMicros: 21_000_000,
    });

    await expect(runAutoRefill("workspace_123")).resolves.toEqual({
      charged: true,
    });

    expect(captureProductServerEventMock).toHaveBeenCalledWith(
      "billing_topup_completed",
      "workspace_123",
      {
        workspace_id: "workspace_123",
        topup_type: "auto_refill",
        amount_cents: 2_000,
        amount_usd: 20,
        balance_cents: 2_100,
      },
    );
    expect(captureServerEventMock).toHaveBeenCalledWith(
      "goat_billing_auto_refill_succeeded",
      "workspace_123",
      {
        workspace_id: "workspace_123",
        amount_cents: 2_000,
      },
    );
    expect(settleAutoRefillMock).toHaveBeenCalledWith(
      {
        workspaceId: "workspace_123",
      },
      { db: undefined },
    );
    expect(releasePendingForWorkspaceMock).toHaveBeenCalledWith(
      "workspace_123",
      expect.any(Date),
      undefined,
    );
  });

  it("does not double-capture when the webhook already credited the PaymentIntent", async () => {
    recordAutoRefillCreditMock.mockResolvedValue({
      ok: false,
      reason: "duplicate",
    });

    await expect(runAutoRefill("workspace_123")).resolves.toEqual({
      charged: true,
    });

    expect(captureProductServerEventMock).not.toHaveBeenCalled();
    expect(captureServerEventMock).toHaveBeenCalledWith(
      "goat_billing_auto_refill_succeeded",
      "workspace_123",
      expect.any(Object),
    );
  });
});

import { captureGoatServerEvent } from "@opencompany/analytics/goat/server";
import { captureServerEvent } from "@opencompany/analytics/server";
import {
  claimGoatAutoRefill,
  releasePendingForWorkspace,
  settleGoatAutoRefill,
} from "@opencompany/db/goat-billing";
import { recordGoatAutoRefillCredit } from "@opencompany/db/goat-credits";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getGoatStripe } from "@/lib/billing/stripe";
import { runGoatAutoRefill } from "./auto-refill";

vi.mock("@opencompany/analytics/goat/server", () => ({
  captureGoatServerEvent: vi.fn(async () => undefined),
}));

vi.mock("@opencompany/analytics/server", () => ({
  captureServerEvent: vi.fn(async () => undefined),
}));

vi.mock("@opencompany/db/goat-billing", () => ({
  claimGoatAutoRefill: vi.fn(),
  GOAT_AUTO_REFILL_THRESHOLD_USD_MICROS: 5_000_000,
  listGoatAutoRefillCandidates: vi.fn(async () => []),
  releasePendingForWorkspace: vi.fn(async () => 0),
  settleGoatAutoRefill: vi.fn(async () => undefined),
}));

vi.mock("@opencompany/db/goat-credits", () => ({
  getGoatCreditBalanceUsdMicros: vi.fn(async () => 0),
  goatUsdMicrosToCents: (micros: number) => Math.round(micros / 10_000),
  recordGoatAutoRefillCredit: vi.fn(),
}));

vi.mock("@/lib/billing/stripe", () => ({
  assertGoatCheckoutEnabled: vi.fn(),
  getGoatStripe: vi.fn(),
}));

const captureGoatServerEventMock = vi.mocked(captureGoatServerEvent);
const captureServerEventMock = vi.mocked(captureServerEvent);
const claimGoatAutoRefillMock = vi.mocked(claimGoatAutoRefill);
const recordGoatAutoRefillCreditMock = vi.mocked(recordGoatAutoRefillCredit);
const releasePendingForWorkspaceMock = vi.mocked(releasePendingForWorkspace);
const settleGoatAutoRefillMock = vi.mocked(settleGoatAutoRefill);
const getGoatStripeMock = vi.mocked(getGoatStripe);

describe("runGoatAutoRefill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claimGoatAutoRefillMock.mockResolvedValue({
      amountCents: 2_000,
      stripeCustomerId: "cus_123",
      paymentMethodId: "pm_123",
    });
    getGoatStripeMock.mockReturnValue({
      paymentIntents: {
        create: vi.fn(async () => ({ id: "pi_123", status: "succeeded" })),
      },
    } as never);
  });

  it("captures a successfully credited auto-refill in the Goat project", async () => {
    recordGoatAutoRefillCreditMock.mockResolvedValue({
      ok: true,
      ledgerId: 42,
      balanceUsdMicros: 21_000_000,
    });

    await expect(runGoatAutoRefill("workspace_123")).resolves.toEqual({
      charged: true,
    });

    expect(captureGoatServerEventMock).toHaveBeenCalledWith(
      "billing_topup_completed",
      "workspace_123",
      {
        workspace_id: "workspace_123",
        topup_type: "auto_refill",
        amount_cents: 2_000,
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
    expect(settleGoatAutoRefillMock).toHaveBeenCalledWith({
      workspaceId: "workspace_123",
    });
    expect(releasePendingForWorkspaceMock).toHaveBeenCalledWith("workspace_123");
  });

  it("does not double-capture when the webhook already credited the PaymentIntent", async () => {
    recordGoatAutoRefillCreditMock.mockResolvedValue({
      ok: false,
      reason: "duplicate",
    });

    await expect(runGoatAutoRefill("workspace_123")).resolves.toEqual({
      charged: true,
    });

    expect(captureGoatServerEventMock).not.toHaveBeenCalled();
    expect(captureServerEventMock).toHaveBeenCalledWith(
      "goat_billing_auto_refill_succeeded",
      "workspace_123",
      expect.any(Object),
    );
  });
});

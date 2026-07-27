import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockGoatStripeApiError extends Error {
    readonly status: number;
    constructor(status: number) {
      super(`Stripe failed (${status}).`);
      this.status = status;
    }
  }
  return {
    GoatStripeApiError: MockGoatStripeApiError,
    loadGoatStripeConnection: vi.fn(),
    markGoatStripeConnectionNeedsReauth: vi.fn(),
    requestGoatStripeApi: vi.fn(),
  };
});

vi.mock("@/lib/integrations/stripe", () => ({
  GoatStripeApiError: mocks.GoatStripeApiError,
  loadGoatStripeConnection: mocks.loadGoatStripeConnection,
  markGoatStripeConnectionNeedsReauth: mocks.markGoatStripeConnectionNeedsReauth,
  requestGoatStripeApi: mocks.requestGoatStripeApi,
}));

import { resolveStripeActions } from "@/lib/actions/stripe";
import { GoatActionAuthError } from "@/lib/actions/types";

const connection = {
  integrationId: "gint_stripe",
  userWorkosId: "user_original",
  accountId: "acct_123",
  accountName: "Acme Payments",
  livemode: true,
  apiKey: `rk_live_${"a".repeat(24)}`,
};

beforeEach(() => {
  mocks.loadGoatStripeConnection.mockReset();
  mocks.loadGoatStripeConnection.mockResolvedValue(connection);
  mocks.markGoatStripeConnectionNeedsReauth.mockReset();
  mocks.markGoatStripeConnectionNeedsReauth.mockResolvedValue(undefined);
  mocks.requestGoatStripeApi.mockReset();
});

describe("resolveStripeActions", () => {
  it("is absent when the workspace has no connected Stripe account", async () => {
    mocks.loadGoatStripeConnection.mockResolvedValue(null);
    await expect(resolveStripeActions("workspace_1")).resolves.toBeNull();
  });

  it("summarizes period balance activity by currency and reporting category", async () => {
    mocks.requestGoatStripeApi.mockResolvedValue({
      data: [
        {
          id: "txn_charge",
          amount: 10_000,
          fee: 320,
          net: 9_680,
          currency: "usd",
          reporting_category: "charge",
        },
        {
          id: "txn_refund",
          amount: -2_000,
          fee: 0,
          net: -2_000,
          currency: "usd",
          reporting_category: "refund",
        },
        {
          id: "txn_partial_capture",
          amount: -500,
          fee: 0,
          net: -500,
          currency: "usd",
          reporting_category: "partial_capture_reversal",
        },
        {
          id: "txn_dispute",
          amount: -1_000,
          fee: 0,
          net: -1_000,
          currency: "usd",
          reporting_category: "dispute",
        },
        {
          id: "txn_fee",
          amount: -100,
          fee: 0,
          net: -100,
          currency: "usd",
          reporting_category: "fee",
        },
        {
          id: "txn_fee_refund",
          amount: 20,
          fee: 0,
          net: 20,
          currency: "usd",
          reporting_category: "fee",
        },
      ],
      has_more: false,
    });

    const result = await executeAction("stripe.get_revenue_summary", {
      start: "2026-07-20T00:00:00Z",
      end: "2026-07-27T00:00:00Z",
    });

    expect(result).toMatchObject({
      account: "Acme Payments",
      livemode: true,
      amountsAreMinorUnits: true,
      transactionCount: 6,
      partial: false,
      currencies: [
        {
          currency: "usd",
          transactionCount: 6,
          capturedPaymentVolume: 9_500,
          partialCaptureReversalVolume: 500,
          refundVolume: 2_000,
          disputeVolume: 1_000,
          stripeFees: 400,
          netPaymentActivity: 6_100,
          categoryBreakdown: {
            charge: { transactionCount: 1, amount: 10_000, fees: 320, net: 9_680 },
            refund: { transactionCount: 1, amount: -2_000, fees: 0, net: -2_000 },
            partial_capture_reversal: {
              transactionCount: 1,
              amount: -500,
              fees: 0,
              net: -500,
            },
            dispute: { transactionCount: 1, amount: -1_000, fees: 0, net: -1_000 },
            fee: { transactionCount: 2, amount: -80, fees: 0, net: -80 },
          },
        },
      ],
    });
    expect(mocks.requestGoatStripeApi).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/balance_transactions",
        params: expect.objectContaining({
          "created[gte]": 1_784_505_600,
          "created[lt]": 1_785_110_400,
          limit: 100,
        }),
      }),
    );
  });

  it("returns current available and pending balances without provider metadata", async () => {
    mocks.requestGoatStripeApi.mockResolvedValue({
      available: [{ amount: 4_200, currency: "usd", source_types: { card: 4_200 } }],
      pending: [{ amount: 900, currency: "usd" }],
    });

    await expect(executeAction("stripe.get_balance", {})).resolves.toMatchObject({
      account: "Acme Payments",
      amountsAreMinorUnits: true,
      available: [{ amount: 4_200, currency: "usd", sourceTypes: { card: 4_200 } }],
      pending: [{ amount: 900, currency: "usd" }],
    });
  });

  it("separates active, trialing, and at-risk recurring value", async () => {
    mocks.requestGoatStripeApi.mockImplementation(
      async (input: { params?: { status?: string } }) => {
        const status = input.params?.status;
        const amount =
          status === "active"
            ? 12_000
            : status === "trialing"
              ? 2_400
              : status === "past_due"
                ? 600
                : 0;
        return {
          data:
            amount > 0
              ? [
                  {
                    id: `sub_${status}`,
                    status,
                    cancel_at_period_end: status === "active",
                    items: {
                      data: [
                        {
                          quantity: 1,
                          price: {
                            currency: "usd",
                            unit_amount: amount,
                            recurring: {
                              interval: "year",
                              interval_count: 1,
                              usage_type: "licensed",
                            },
                          },
                        },
                        ...(status === "active"
                          ? [
                              {
                                quantity: 1,
                                price: {
                                  billing_scheme: "tiered",
                                  currency: "usd",
                                  unit_amount: 5_000,
                                  recurring: {
                                    interval: "month",
                                    interval_count: 1,
                                    usage_type: "licensed",
                                  },
                                },
                              },
                              {
                                quantity: 1,
                                price: {
                                  currency: "usd",
                                  unit_amount: 8_000,
                                  recurring: {
                                    interval: "month",
                                    interval_count: 1,
                                    usage_type: "metered",
                                  },
                                },
                              },
                            ]
                          : []),
                      ],
                    },
                  },
                ]
              : [],
          has_more: false,
        };
      },
    );

    await expect(executeAction("stripe.get_subscription_summary", {})).resolves.toMatchObject({
      statusCounts: { active: 1, trialing: 1, past_due: 1, unpaid: 0, paused: 0 },
      cancelAtPeriodEnd: 1,
      estimatedMonthlyRecurringValue: [
        { currency: "usd", active: 1_000, trialing: 200, atRisk: 50 },
      ],
      excludedRecurringItems: 2,
      partial: false,
    });
  });

  it("summarizes open receivables and keeps only safe Stripe invoice links", async () => {
    mocks.requestGoatStripeApi.mockResolvedValue({
      data: [
        {
          id: "in_1",
          number: "ACME-001",
          currency: "usd",
          amount_due: 5_000,
          amount_remaining: 5_000,
          attempted: false,
          collection_method: "send_invoice",
          created: 1_769_817_600,
          due_date: 1_770_163_200,
          hosted_invoice_url: "https://invoice.stripe.com/i/acme",
        },
        {
          id: "in_2",
          number: "ACME-002",
          currency: "usd",
          amount_due: 2_000,
          amount_remaining: 1_500,
          attempted: true,
          collection_method: "charge_automatically",
          hosted_invoice_url: "https://evil.example/invoice",
        },
      ],
      has_more: false,
    });

    const result = await executeAction("stripe.get_receivables_summary", {});
    expect(result).toMatchObject({
      partial: false,
      currencies: [
        {
          currency: "usd",
          openInvoiceCount: 2,
          amountDue: 7_000,
          amountRemaining: 6_500,
          overdueInvoiceCount: 1,
          overdueAmountRemaining: 5_000,
          attemptedUnpaidInvoiceCount: 1,
        },
      ],
    });
    const largestOpenInvoices = (result as { largestOpenInvoices: Array<Record<string, unknown>> })
      .largestOpenInvoices;
    expect(largestOpenInvoices).toEqual([
      expect.objectContaining({ id: "in_1", url: "https://invoice.stripe.com/i/acme" }),
      expect.objectContaining({ id: "in_2" }),
    ]);
    expect(largestOpenInvoices[1]).not.toHaveProperty("url");
  });

  it("marks the connection for reauth when Stripe rejects the key", async () => {
    mocks.requestGoatStripeApi.mockRejectedValue(new mocks.GoatStripeApiError(401));

    await expect(executeAction("stripe.get_balance", {})).rejects.toBeInstanceOf(
      GoatActionAuthError,
    );
    expect(mocks.markGoatStripeConnectionNeedsReauth).toHaveBeenCalledWith(connection);
  });
});

async function executeAction(actionId: string, params: Record<string, unknown>) {
  const catalog = await resolveStripeActions("workspace_1");
  const action = catalog?.actions.find((candidate) => candidate.id === actionId);
  if (!action) throw new Error(`Missing action ${actionId}.`);
  return await action.execute(params, {
    userWorkosId: "user_1",
    workspaceId: "workspace_1",
    signal: new AbortController().signal,
    currentDate: new Date("2026-07-27T12:00:00Z"),
    userTimezone: "UTC",
  });
}

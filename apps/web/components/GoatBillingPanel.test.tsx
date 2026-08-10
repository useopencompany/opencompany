import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GoatBillingPanel, type GoatBillingPanelData } from "./GoatBillingPanel";

vi.mock("@/lib/billing/actions", () => ({
  createGoatBillingPortalAction: vi.fn(),
  createGoatCreditTopUpAction: vi.fn(),
  createGoatProCheckoutAction: vi.fn(),
  setGoatAutoRefillAction: vi.fn(),
}));

const base: GoatBillingPanelData = {
  plan: "hobby",
  subscriptionStatus: null,
  cancelAtPeriodEnd: false,
  currentPeriodEnd: null,
  includedUsagePeriodEnd: null,
  paymentNeedsAttention: false,
  proMonthlyPriceCents: 2_000,
  hobbyIncludedUsageCents: 500,
  includedUsagePerSeatCents: 2_000,
  seatQuantity: 1,
  memberCount: 1,
  memberCap: 1,
  creditBalanceUsdMicros: 5_000_000,
  includedBalanceUsdMicros: 2_000_000,
  topUpBalanceUsdMicros: 3_000_000,
  spendThisMonthUsdMicros: 1_230_000,
  spendThisMonthByCategory: {
    chat: 800_000,
    ingestion: 300_000,
    capabilities: 130_000,
  },
  recentActivity: [],
  lowBalanceWarnUsdMicros: 2_000_000,
  topUpAmountsCents: [500, 1_000, 2_000, 5_000, 10_000],
  defaultTopUpCents: 2_000,
  minTopUpCents: 500,
  maxTopUpCents: 100_000,
  autoRefillMonthlyMaxCents: 100_000,
  autoRefill: {
    enabled: false,
    amountCents: 2_000,
    hasPaymentMethod: true,
    lastError: null,
  },
  isAdmin: true,
};

describe("GoatBillingPanel", () => {
  it("shows the Hobby allowance without purchase controls", () => {
    render(<GoatBillingPanel data={base} checkoutResult={null} topupResult={null} />);

    expect(screen.getByText("Balance").parentElement?.parentElement).toHaveTextContent("$5.00");
    expect(screen.getByText(/\$2\.00 included · \$3\.00 top-up/i)).toBeVisible();
    expect(screen.getByText("Spent this month").parentElement).toHaveTextContent("$1.23");
    expect(screen.getByText("Hobby")).toBeVisible();
    expect(screen.getByText(/\$5 of included usage refreshes/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Add $5" })).toBeNull();
    expect(screen.getByText(/top-ups are available after upgrading/i)).toBeVisible();
  });

  it("shows purchase controls only to Pro admins", () => {
    const { rerender } = render(
      <GoatBillingPanel
        data={{ ...base, plan: "pro", memberCap: 10 }}
        checkoutResult={null}
        topupResult={null}
      />,
    );
    expect(screen.getByRole("button", { name: "Add $5" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Add $100" })).toBeEnabled();
    expect(screen.getByLabelText("Custom top-up amount in dollars")).toHaveValue("20");

    rerender(
      <GoatBillingPanel
        data={{ ...base, plan: "pro", memberCap: 10, isAdmin: false }}
        checkoutResult={null}
        topupResult={null}
      />,
    );
    expect(screen.queryByRole("button", { name: "Add $5" })).toBeNull();
    expect(screen.getByText(/ask a workspace admin to add/i)).toBeVisible();
  });

  it("explains at-cost pricing and included usage", () => {
    render(<GoatBillingPanel data={base} checkoutResult={null} topupResult={null} />);

    expect(screen.getByText(/provider retail cost only/i)).toBeVisible();
    expect(screen.getByText(/there is no platform fee on usage/i)).toBeVisible();
    expect(screen.getByText(/included usage expires monthly/i)).toBeVisible();
  });

  it("warns when the balance is empty", () => {
    render(
      <GoatBillingPanel
        data={{ ...base, creditBalanceUsdMicros: 0 }}
        checkoutResult={null}
        topupResult={null}
      />,
    );

    expect(screen.getByText(/Hobby credits are used up/i)).toBeVisible();
  });

  it("surfaces an auto-refill failure", () => {
    render(
      <GoatBillingPanel
        data={{
          ...base,
          autoRefill: { ...base.autoRefill, lastError: "Your card was declined." },
        }}
        checkoutResult={null}
        topupResult={null}
      />,
    );

    expect(screen.getByText(/Auto-refill failed: Your card was declined\./i)).toBeVisible();
  });

  it("blocks the auto-refill toggle until a card is saved", () => {
    render(
      <GoatBillingPanel
        data={{
          ...base,
          plan: "pro",
          memberCap: 10,
          autoRefill: { ...base.autoRefill, hasPaymentMethod: false },
        }}
        checkoutResult={null}
        topupResult={null}
      />,
    );

    expect(screen.getByRole("switch")).toBeDisabled();
    expect(
      screen.getByText(/auto-refill charges the card saved during a top-up/i),
    ).toBeInTheDocument();
  });

  it("offers Pro to admins and shows the active team plan", () => {
    const { rerender } = render(
      <GoatBillingPanel data={base} checkoutResult={null} topupResult={null} />,
    );
    expect(screen.getByRole("button", { name: "Upgrade to Pro" })).toBeEnabled();
    expect(screen.getByText(/\$5 of included usage refreshes/i)).toBeVisible();

    rerender(
      <GoatBillingPanel
        data={{ ...base, plan: "pro", memberCount: 4, memberCap: 10, seatQuantity: 4 }}
        checkoutResult={null}
        topupResult={null}
      />,
    );
    expect(screen.getByRole("button", { name: "Manage plan" })).toBeEnabled();
    expect(screen.getByText(/4 billed seats with \$20 of included at-cost usage/i)).toBeVisible();
  });

  it("surfaces Pro cancellation and payment states", () => {
    render(
      <GoatBillingPanel
        data={{
          ...base,
          plan: "pro",
          memberCap: 10,
          paymentNeedsAttention: true,
          cancelAtPeriodEnd: true,
          currentPeriodEnd: "2026-09-01T00:00:00.000Z",
        }}
        checkoutResult={null}
        topupResult={null}
      />,
    );

    expect(screen.getByText(/payment needs attention/i)).toBeVisible();
    expect(screen.getByText(/remains active until/i)).toBeVisible();
  });
});

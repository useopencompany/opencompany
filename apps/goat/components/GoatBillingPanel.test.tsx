import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GoatBillingPanel, type GoatBillingPanelData } from "./GoatBillingPanel";

vi.mock("@/lib/billing/actions", () => ({
  createGoatBillingPortalAction: vi.fn(),
  createGoatCreditTopUpAction: vi.fn(),
  setGoatAutoRefillAction: vi.fn(),
}));

const base: GoatBillingPanelData = {
  creditBalanceUsdMicros: 5_000_000,
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
  autoRefill: {
    enabled: false,
    amountCents: 2_000,
    hasPaymentMethod: true,
    lastError: null,
  },
  platformFeePercent: 20,
  ingestFeeUsdCentsPer50: 20,
  hasStripeCustomer: true,
  isAdmin: true,
};

describe("GoatBillingPanel", () => {
  it("shows the balance, monthly spend, and top-up actions for any member", () => {
    render(<GoatBillingPanel data={{ ...base, isAdmin: false }} topupResult={null} />);

    expect(screen.getByText("Balance").parentElement?.parentElement).toHaveTextContent("$5.00");
    expect(screen.getByText("Spent this month").parentElement).toHaveTextContent("$1.23");
    expect(screen.getByRole("button", { name: "Add $5" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Add $100" })).toBeEnabled();
    expect(screen.getByLabelText("Custom top-up amount in dollars")).toHaveValue("20");
  });

  it("explains pricing in dollars with the fee split", () => {
    render(<GoatBillingPanel data={base} topupResult={null} />);

    expect(screen.getByText(/model cost \+ 20% platform fee, charged per message/i)).toBeVisible();
    expect(screen.getByText(/\$0\.20 per 50 ingested items/i)).toBeVisible();
    expect(screen.getByText(/underlying provider cost \+ 20% platform fee/i)).toBeVisible();
  });

  it("warns when the balance is empty", () => {
    render(<GoatBillingPanel data={{ ...base, creditBalanceUsdMicros: 0 }} topupResult={null} />);

    expect(screen.getByText(/out of credits/i)).toBeVisible();
  });

  it("surfaces an auto-refill failure", () => {
    render(
      <GoatBillingPanel
        data={{
          ...base,
          autoRefill: { ...base.autoRefill, lastError: "Your card was declined." },
        }}
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
          autoRefill: { ...base.autoRefill, hasPaymentMethod: false },
        }}
        topupResult={null}
      />,
    );

    expect(screen.getByRole("switch")).toBeDisabled();
    expect(
      screen.getByText(/auto-refill charges the card saved during a top-up/i),
    ).toBeInTheDocument();
  });

  it("shows the Stripe portal button only to admins with a Stripe customer", () => {
    const { rerender } = render(<GoatBillingPanel data={base} topupResult={null} />);
    expect(screen.getByRole("button", { name: /Manage billing details/i })).toBeEnabled();

    rerender(<GoatBillingPanel data={{ ...base, isAdmin: false }} topupResult={null} />);
    expect(screen.queryByRole("button", { name: /Manage billing details/i })).toBeNull();

    rerender(<GoatBillingPanel data={{ ...base, hasStripeCustomer: false }} topupResult={null} />);
    expect(screen.queryByRole("button", { name: /Manage billing details/i })).toBeNull();
  });
});

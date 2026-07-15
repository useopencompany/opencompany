import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GoatBillingPanel, type GoatBillingPanelData } from "./GoatBillingPanel";

vi.mock("@/lib/billing/actions", () => ({
  createGoatBillingPortalAction: vi.fn(),
  createGoatProCheckoutAction: vi.fn(),
}));

const base: GoatBillingPanelData = {
  plan: "free",
  subscriptionStatus: null,
  cancelAtPeriodEnd: false,
  currentPeriodEnd: null,
  paymentNeedsAttention: false,
  monthlyPriceUsdCents: 9_900,
  monthlyIngestionsUsed: 42,
  monthlyIngestionLimit: 150,
  baseMonthlyLimit: 150,
  freeMonthlyLimit: 150,
  proMonthlyLimit: 1_500,
  sourceBonus: 0,
  sourceBonusPerSource: 25,
  sourceBonusMax: 100,
  monthStartedAt: "2026-07-01T00:00:00.000Z",
  monthResetAt: "2026-08-01T00:00:00.000Z",
  isAdmin: true,
};

describe("GoatBillingPanel", () => {
  it("shows the Free allowance and admin upgrade action", () => {
    render(<GoatBillingPanel data={base} />);

    expect(screen.getByText("Current plan").parentElement).toHaveTextContent("Free");
    expect(screen.getByRole("button", { name: "Upgrade to Pro" })).toBeEnabled();
    expect(screen.getByText(/150 ingested items each month\./i)).toBeInTheDocument();
    expect(screen.getByText("42 ingestions")).toBeInTheDocument();
    expect(screen.getByText(/42 of 150 monthly allowance/i)).toBeInTheDocument();
    expect(
      screen.getAllByText(/\+25 items\/month per connected source \(up to \+100\)/i),
    ).toHaveLength(2);
    expect(screen.getByText("Allowance resets").parentElement?.parentElement).toHaveTextContent(
      "Aug 1, 2026",
    );
  });

  it("surfaces the connected-source bonus inside the monthly allowance", () => {
    render(
      <GoatBillingPanel
        data={{
          ...base,
          monthlyIngestionLimit: 200,
          sourceBonus: 50,
        }}
      />,
    );

    expect(
      screen.getByText(/42 of 200 monthly allowance \(150 base \+ 50 source bonus\)/i),
    ).toBeInTheDocument();
  });

  it("shows flat Pro pricing, cancellation, and payment state", () => {
    render(
      <GoatBillingPanel
        data={{
          ...base,
          plan: "pro",
          subscriptionStatus: "past_due",
          cancelAtPeriodEnd: true,
          currentPeriodEnd: "2026-08-13T00:00:00.000Z",
          paymentNeedsAttention: true,
          monthlyIngestionsUsed: 381,
          monthlyIngestionLimit: 1_500,
          baseMonthlyLimit: 1_500,
        }}
      />,
    );

    expect(screen.getByRole("button", { name: "Manage billing" })).toBeEnabled();
    expect(screen.getAllByText("OpenCompany Pro")).toHaveLength(2);
    expect(screen.getAllByText("$99/month")).toHaveLength(2);
    expect(screen.getByText(/flat, plus applicable tax/i)).toBeInTheDocument();
    expect(screen.getByText(/could not collect the latest payment/i)).toBeInTheDocument();
    expect(screen.getByText("381 ingestions")).toBeInTheDocument();
    expect(screen.getByText(/381 of 1,500 monthly allowance/i)).toBeInTheDocument();
    expect(screen.getByText("Plan ends").parentElement?.parentElement).toHaveTextContent(
      "Aug 13, 2026",
    );
  });

  it("shows the next billing cycle for a renewing Pro workspace", () => {
    render(
      <GoatBillingPanel
        data={{
          ...base,
          plan: "pro",
          subscriptionStatus: "active",
          currentPeriodEnd: "2026-08-13T00:00:00.000Z",
          monthlyIngestionLimit: 1_500,
        }}
      />,
    );

    expect(screen.getByText("Next billing cycle").parentElement?.parentElement).toHaveTextContent(
      "Aug 13, 2026",
    );
  });

  it("keeps billing actions read-only for workspace members", () => {
    render(<GoatBillingPanel data={{ ...base, isAdmin: false }} />);

    expect(screen.queryByRole("button", { name: "Upgrade to Pro" })).toBeNull();
    expect(screen.getByText(/Only workspace admins/i)).toBeInTheDocument();
  });

  it("shows incomplete subscriptions as activating without offering duplicate Checkout", () => {
    render(
      <GoatBillingPanel
        data={{
          ...base,
          subscriptionStatus: "incomplete",
        }}
      />,
    );

    expect(screen.getByText("Activating Pro")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Manage billing" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Upgrade to Pro" })).toBeNull();
  });
});

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GoatBillingPanel, type GoatBillingPanelData } from "./GoatBillingPanel";

vi.mock("@/lib/billing/actions", () => ({
  createGoatBillingPortalAction: vi.fn(),
  createGoatCreditTopUpAction: vi.fn(),
  createGoatProCheckoutAction: vi.fn(),
}));

const base: GoatBillingPanelData = {
  plan: "free",
  subscriptionStatus: null,
  cancelAtPeriodEnd: false,
  currentPeriodEnd: null,
  paymentNeedsAttention: false,
  seatMonthlyPriceUsdCents: 1_800,
  seatQuantity: 1,
  memberCount: 1,
  freeMaxMembers: 3,
  proMaxMembers: 50,
  monthlyIngestionsUsed: 42,
  monthlyIngestionLimit: 300,
  freeMonthlyLimit: 300,
  proMonthlyPerSeat: 300,
  overageUnits: 0,
  overageUsdMicros: 0,
  overageCentsPer100: 200,
  creditBalanceUsdMicros: 5_000_000,
  topUpAmountsCents: [500, 1_000, 2_500, 5_000],
  monthStartedAt: "2026-07-01T00:00:00.000Z",
  monthResetAt: "2026-08-01T00:00:00.000Z",
  isAdmin: true,
};

describe("GoatBillingPanel", () => {
  it("shows the Free allowance and admin upgrade action", () => {
    render(<GoatBillingPanel data={base} />);

    expect(screen.getByText("Current plan").parentElement).toHaveTextContent("Free");
    expect(screen.getByRole("button", { name: "Upgrade to Pro" })).toBeEnabled();
    expect(screen.getAllByText(/Up to 3 workspace members/i).length).toBeGreaterThan(0);
    expect(screen.getByText("42 ingestions")).toBeInTheDocument();
    expect(screen.getByText(/42 of 300 monthly allowance/i)).toBeInTheDocument();
    expect(screen.getByText("Allowance resets").parentElement?.parentElement).toHaveTextContent(
      "Aug 1, 2026",
    );
  });

  it("shows the credit balance with top-up actions for admins", () => {
    render(<GoatBillingPanel data={base} />);

    expect(screen.getByText("Usage credits").parentElement?.parentElement).toHaveTextContent(
      "$5.00",
    );
    expect(screen.getByRole("button", { name: "Add $5" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Add $50" })).toBeEnabled();
    expect(screen.getAllByText(/\$2 per 100 extra items/i).length).toBeGreaterThan(0);
  });

  it("shows seat-based Pro pricing, cancellation, and payment state", () => {
    render(
      <GoatBillingPanel
        data={{
          ...base,
          plan: "pro",
          subscriptionStatus: "past_due",
          cancelAtPeriodEnd: true,
          currentPeriodEnd: "2026-08-13T00:00:00.000Z",
          paymentNeedsAttention: true,
          seatQuantity: 4,
          memberCount: 4,
          monthlyIngestionsUsed: 381,
          monthlyIngestionLimit: 1_200,
        }}
      />,
    );

    expect(screen.getByRole("button", { name: "Manage billing" })).toBeEnabled();
    expect(screen.getAllByText("OpenCompany Pro")).toHaveLength(2);
    expect(screen.getByText(/4 seats × \$18\/month/i)).toBeInTheDocument();
    expect(screen.getByText(/\$18 per seat\/month/i)).toBeInTheDocument();
    expect(screen.getByText(/could not collect the latest payment/i)).toBeInTheDocument();
    expect(screen.getByText("381 ingestions")).toBeInTheDocument();
    expect(
      screen.getByText(/381 of 1,200 monthly allowance \(300 × 4 seats\)/i),
    ).toBeInTheDocument();
    expect(screen.getByText("Plan ends").parentElement?.parentElement).toHaveTextContent(
      "Aug 13, 2026",
    );
  });

  it("reports overage taken from credits inside the allowance metric", () => {
    render(
      <GoatBillingPanel
        data={{
          ...base,
          plan: "pro",
          subscriptionStatus: "active",
          seatQuantity: 1,
          monthlyIngestionsUsed: 350,
          monthlyIngestionLimit: 300,
          overageUnits: 50,
          overageUsdMicros: 1_000_000,
        }}
      />,
    );

    expect(screen.getByText(/plus 50 overage \(\$1\.00 from credits\)/i)).toBeInTheDocument();
  });

  it("shows the next billing cycle for a renewing Pro workspace", () => {
    render(
      <GoatBillingPanel
        data={{
          ...base,
          plan: "pro",
          subscriptionStatus: "active",
          currentPeriodEnd: "2026-08-13T00:00:00.000Z",
          monthlyIngestionLimit: 300,
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
    expect(screen.queryByRole("button", { name: "Add $5" })).toBeNull();
    expect(screen.getByText(/Only workspace admins can change the plan/i)).toBeInTheDocument();
    expect(screen.getByText(/Only workspace admins can add credits/i)).toBeInTheDocument();
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

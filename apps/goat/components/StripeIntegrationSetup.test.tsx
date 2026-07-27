import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StripeIntegrationSetup } from "./StripeIntegrationSetup";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("@/lib/integrations/stripe-actions", () => ({
  disconnectStripeIntegrationAction: vi.fn(),
}));

describe("StripeIntegrationSetup", () => {
  it("starts Stripe OAuth without asking the user for an API key", () => {
    render(
      <StripeIntegrationSetup
        canManage
        initialState={{
          provider: "stripe",
          connected: false,
          status: "not_connected",
          integrationId: null,
          accountName: null,
          livemode: null,
          statusReason: null,
        }}
      />,
    );

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Connect Stripe" })).toHaveAttribute(
      "href",
      "/api/integrations/stripe/start?returnTo=/settings/stripe",
    );
    expect(
      screen.getByText(/select an account and approve Goat's read-only permissions/i),
    ).toBeInTheDocument();
  });

  it("shows the connected OAuth account and reauthorization path", () => {
    render(
      <StripeIntegrationSetup
        canManage
        initialState={{
          provider: "stripe",
          connected: true,
          status: "connected",
          integrationId: "gint_stripe",
          accountName: "Acme Payments",
          livemode: false,
          statusReason: null,
        }}
      />,
    );

    expect(screen.getByText("Connected to Acme Payments")).toBeInTheDocument();
    expect(screen.getByText("Read-only access authorized")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Reauthorize Stripe" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
  });

  it("allows an admin to remove a stale connection instead of reauthorizing it", () => {
    render(
      <StripeIntegrationSetup
        canManage
        initialState={{
          provider: "stripe",
          connected: false,
          status: "needs_reauth",
          integrationId: "gint_stripe",
          accountName: "Acme Payments",
          livemode: null,
          statusReason: "Reconnect Stripe to authorize read-only access.",
        }}
      />,
    );

    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Reauthorize Stripe" })).toBeInTheDocument();
  });
});

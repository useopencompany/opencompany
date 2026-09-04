import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StripeRestrictedKeyConnectionForm } from "./StripeRestrictedKeyConnectionForm";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
const actions = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/lib/integrations/stripe-actions", () => ({
  saveStripeRestrictedApiKeyAction: actions.connect,
  disconnectStripeIntegrationAction: actions.disconnect,
}));

describe("StripeRestrictedKeyConnectionForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    actions.connect.mockResolvedValue({
      ok: true,
      state: {
        provider: "stripe",
        connected: true,
        status: "connected",
        integrationId: "gint_stripe",
        accountName: "Acme",
        livemode: false,
        statusReason: null,
        capabilityModes: {},
        toolModes: {},
      },
    });
    actions.disconnect.mockResolvedValue({ ok: true });
  });

  it("connects with a restricted key without rendering it back", async () => {
    const user = userEvent.setup();
    render(<StripeRestrictedKeyConnectionForm connected={false} canManage />);

    const input = screen.getByLabelText("Restricted key");
    await user.type(input, "rk_test_secret_value");
    await user.click(screen.getByRole("button", { name: "Connect Stripe" }));

    await waitFor(() => expect(actions.connect).toHaveBeenCalledWith("rk_test_secret_value"));
    expect(input).toHaveValue("");
    expect(screen.queryByText("rk_test_secret_value")).not.toBeInTheDocument();
    expect(router.refresh).toHaveBeenCalled();
  });

  it("disconnects the workspace connection", async () => {
    const user = userEvent.setup();
    render(<StripeRestrictedKeyConnectionForm connected canManage />);

    await user.click(screen.getByRole("button", { name: "Disconnect" }));

    await waitFor(() => expect(actions.disconnect).toHaveBeenCalled());
    expect(router.refresh).toHaveBeenCalled();
  });

  it("keeps key controls read-only for workspace members", () => {
    render(<StripeRestrictedKeyConnectionForm connected canManage={false} />);

    expect(screen.getByText(/managed by workspace admins/i)).toBeVisible();
    expect(screen.queryByLabelText("Restricted key")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

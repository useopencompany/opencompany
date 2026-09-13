import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GranolaProviderState } from "@/lib/integration-state";
import { GranolaIntegrationSetup } from "./GranolaIntegrationSetup";

const actions = vi.hoisted(() => ({ save: vi.fn(), disconnect: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: actions.refresh }) }));
vi.mock("@/lib/integrations/granola-actions", () => ({ saveGranolaApiKeyAction: actions.save }));
vi.mock("@/lib/integration-account-actions", () => ({
  disconnectIntegrationAccountAction: actions.disconnect,
}));

const disconnected: GranolaProviderState = {
  provider: "granola",
  connected: false,
  status: "not_connected",
  integrationId: null,
  accountEmail: null,
  accountName: null,
  statusReason: null,
};

describe("Granola event account setup", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it("saves the event key and clears the password field before refreshing the plugin", async () => {
    actions.save.mockResolvedValue({
      ok: true,
      state: { ...disconnected, connected: true, status: "connected", integrationId: "granola_1" },
    });
    const user = userEvent.setup();
    render(<GranolaIntegrationSetup initialState={disconnected} variant="modal" />);
    expect(screen.getByText(/Business or Enterprise API access/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("API key"), "grn_test_key_for_events");
    await user.click(screen.getByRole("button", { name: "Save API key" }));
    expect(await screen.findByText("API key saved")).toBeInTheDocument();
    expect(screen.getByLabelText("New API key")).toHaveValue("");
    expect(actions.refresh).toHaveBeenCalledOnce();
    expect(screen.getByText(/Turn on Meeting notes ready/)).toBeInTheDocument();
  });

  it("shows reconnection failures inside the plugin Events section", async () => {
    actions.save.mockResolvedValue({ ok: false, error: "Granola rejected this API key." });
    const user = userEvent.setup();
    render(
      <GranolaIntegrationSetup
        initialState={{
          ...disconnected,
          status: "needs_reauth",
          integrationId: "granola_1",
          statusReason: "Granola rejected the saved API key.",
        }}
        variant="modal"
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Granola rejected the saved API key.");
    await user.type(screen.getByLabelText("API key"), "grn_revoked_test_key");
    await user.click(screen.getByRole("button", { name: "Save API key" }));
    expect(await screen.findByText("Granola rejected this API key.")).toBeInTheDocument();
    expect(actions.refresh).not.toHaveBeenCalled();
  });
});

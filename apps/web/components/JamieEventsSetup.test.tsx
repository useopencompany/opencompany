import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JamieEventsProviderState } from "@/lib/integration-state";
import { JamieEventsSetup } from "./JamieEventsSetup";

const actions = vi.hoisted(() => ({
  save: vi.fn(),
  create: vi.fn(),
  disconnect: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: actions.refresh }) }));
vi.mock("@/lib/integration-account-actions", () => ({
  disconnectIntegrationAccountAction: actions.disconnect,
}));
vi.mock("@/lib/integrations/jamie-events-actions", () => ({
  saveJamieWebhookKeyAction: actions.save,
  createJamieWebhookEndpointAction: actions.create,
}));

const WEBHOOK_URL = "https://app.example.com/api/webhooks/jamie/gint_1";

const noEndpoint: JamieEventsProviderState = {
  provider: "jamie",
  connected: false,
  status: "not_connected",
  integrationId: null,
  statusReason: null,
  webhookUrl: null,
  lastDeliveryAt: null,
};

// The endpoint exists but Jamie's key has not been saved, so nothing can be delivered yet.
const disconnected: JamieEventsProviderState = {
  ...noEndpoint,
  status: "needs_reauth",
  integrationId: "gint_1",
  webhookUrl: WEBHOOK_URL,
};

describe("Jamie event account setup", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it("creates the endpoint first, then offers its URL to copy into Jamie", async () => {
    actions.create.mockResolvedValue({ ok: true, state: disconnected });
    const user = userEvent.setup();
    render(<JamieEventsSetup initialState={noEndpoint} />);

    // Nothing can be pasted into Jamie until the endpoint it points at exists.
    expect(screen.queryByLabelText("Webhook key")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create endpoint" }));
    expect(await screen.findByText(WEBHOOK_URL)).toBeInTheDocument();

    expect(screen.getByText(/keep the default x-jamie-api-key header/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy the Jamie endpoint URL" }));
    await expect(navigator.clipboard.readText()).resolves.toBe(WEBHOOK_URL);
  });

  it("saves the webhook key, clears the field, and refreshes the plugin", async () => {
    actions.save.mockResolvedValue({
      ok: true,
      state: { ...disconnected, connected: true, status: "connected", integrationId: "gint_1" },
    });
    const user = userEvent.setup();
    render(<JamieEventsSetup initialState={disconnected} />);

    await user.type(screen.getByLabelText("Webhook key"), "sk_jamie_webhook_key");
    await user.click(screen.getByRole("button", { name: "Save webhook key" }));

    expect(await screen.findByText("Webhook key saved")).toBeInTheDocument();
    expect(screen.getByLabelText("New webhook key")).toHaveValue("");
    expect(actions.refresh).toHaveBeenCalledOnce();
    // Jamie cannot validate a key on save, so the only honest confirmation is a real delivery.
    expect(screen.getByText(/Nothing has arrived from Jamie yet/)).toBeInTheDocument();
  });

  it("reports when Jamie last reached opencompany", () => {
    render(
      <JamieEventsSetup
        initialState={{
          ...disconnected,
          connected: true,
          status: "connected",
          integrationId: "gint_1",
          lastDeliveryAt: "2026-09-12T15:04:00.000Z",
        }}
      />,
    );

    expect(screen.getByText(/Jamie last reached opencompany on/)).toBeInTheDocument();
  });

  it("surfaces a save failure without clearing the key the user typed", async () => {
    actions.save.mockResolvedValue({ ok: false, error: "Could not save the Jamie webhook key." });
    const user = userEvent.setup();
    render(<JamieEventsSetup initialState={disconnected} />);

    await user.type(screen.getByLabelText("Webhook key"), "sk_jamie_webhook_key");
    await user.click(screen.getByRole("button", { name: "Save webhook key" }));

    expect(await screen.findByText("Could not save the Jamie webhook key.")).toBeInTheDocument();
    expect(screen.getByLabelText("Webhook key")).toHaveValue("sk_jamie_webhook_key");
    expect(actions.refresh).not.toHaveBeenCalled();
  });

  it("removes the endpoint and returns to the zero state", async () => {
    actions.disconnect.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(
      <JamieEventsSetup initialState={{ ...disconnected, connected: true, status: "connected" }} />,
    );

    await user.click(screen.getByRole("button", { name: "Remove endpoint" }));

    expect(actions.disconnect).toHaveBeenCalledWith("gint_1");
    expect(await screen.findByRole("button", { name: "Create endpoint" })).toBeInTheDocument();
    expect(screen.queryByText(WEBHOOK_URL)).not.toBeInTheDocument();
  });
});

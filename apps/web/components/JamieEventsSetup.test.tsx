import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JamieEventsProviderState } from "@/lib/integration-state";
import { JamieEventsSetup } from "./JamieEventsSetup";

const actions = vi.hoisted(() => ({ save: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: actions.refresh }) }));
vi.mock("@/lib/integrations/jamie-events-actions", () => ({
  saveJamieWebhookKeyAction: actions.save,
}));

const WEBHOOK_URL = "https://app.example.com/api/webhooks/jamie/events";

const disconnected: JamieEventsProviderState = {
  provider: "jamie",
  connected: false,
  status: "not_connected",
  integrationId: null,
  statusReason: null,
  webhookUrl: WEBHOOK_URL,
  lastDeliveryAt: null,
};

describe("Jamie event account setup", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it("offers the endpoint to copy into Jamie before anything is connected", async () => {
    const user = userEvent.setup();
    render(<JamieEventsSetup initialState={disconnected} />);

    expect(screen.getByText(WEBHOOK_URL)).toBeInTheDocument();
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
});

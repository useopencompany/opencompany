import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { JamieIntegrationSetup } from "@/components/JamieIntegrationSetup";
import type { GoatJamieProviderState } from "@/lib/integration-state";
import { saveJamieWebhookApiKeyAction } from "@/lib/integrations/jamie-actions";
import { GOAT_JAMIE_WEBHOOK_SECRET_HEADER } from "@/lib/integrations/jamie-constants";

const routerMock = vi.hoisted(() => ({
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

vi.mock("@/lib/integrations/jamie-actions", () => ({
  createOrResetJamieWebhookEndpointAction: vi.fn(),
  saveJamieWebhookApiKeyAction: vi.fn(),
}));

describe("JamieIntegrationSetup", () => {
  it("shows that a saved API key is present and can be updated", () => {
    render(<JamieIntegrationSetup initialState={jamieState({ apiKeyConfigured: true })} />);

    expect(screen.getByText("API key saved")).toBeInTheDocument();
    expect(screen.getByText("Paste a new Jamie API key below to update it.")).toBeInTheDocument();
    expect(screen.getByLabelText("New API key")).toHaveAttribute(
      "placeholder",
      "Paste a new sk_ key",
    );
    expect(screen.getByText("Leave blank to keep the saved key.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update API key" })).toBeDisabled();
  });

  it("enables updating the saved API key after a new key is entered", async () => {
    const user = userEvent.setup();
    render(<JamieIntegrationSetup initialState={jamieState({ apiKeyConfigured: true })} />);

    await user.type(screen.getByLabelText("New API key"), validJamieApiKey());

    expect(screen.getByRole("button", { name: "Update API key" })).toBeEnabled();
  });

  it("uses the initial save copy before an API key has been configured", () => {
    render(<JamieIntegrationSetup initialState={jamieState({ apiKeyConfigured: false })} />);

    expect(screen.queryByText("API key saved")).not.toBeInTheDocument();
    expect(screen.getByLabelText("API key")).toHaveAttribute("placeholder", "sk_...");
    expect(screen.getByText("Save the key Jamie shows after creation.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save API key" })).toBeDisabled();
  });

  it("treats a saved Jamie API key as ready for Brain routing", () => {
    render(
      <JamieIntegrationSetup
        initialState={jamieState({
          connected: false,
          status: "needs_reauth",
          apiKeyConfigured: true,
          statusReason: "Waiting for Jamie to send the first valid webhook delivery.",
        })}
        brainSourcesHref="/brain/goat_brain_1/settings"
      />,
    );

    expect(screen.getByText("Ready for Brain")).toBeInTheDocument();
    expect(
      screen.getByText("Enable Jamie from a brain's Sources settings to route completed meetings."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Waiting for Jamie")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Brain sources" })).toHaveAttribute(
      "href",
      "/brain/goat_brain_1/settings",
    );
  });

  it("hides the Status section header in the modal variant", () => {
    render(
      <JamieIntegrationSetup
        initialState={jamieState({ apiKeyConfigured: true })}
        variant="modal"
      />,
    );

    expect(screen.queryByText("Status")).not.toBeInTheDocument();
    // The setup sections still render so the form stays usable inside the modal.
    expect(screen.getByText("Jamie webhook")).toBeInTheDocument();
    expect(screen.getByText("Jamie API key")).toBeInTheDocument();
  });

  it("fires onSaved after a successful API key save", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    vi.mocked(saveJamieWebhookApiKeyAction).mockResolvedValue({
      ok: true,
      setup: {
        integrationId: "goat_integration_1",
        webhookUrl: "https://my.opencompany.chat/api/webhooks/jamie",
        headerName: GOAT_JAMIE_WEBHOOK_SECRET_HEADER,
        apiKeyConfigured: true,
      },
    });

    render(
      <JamieIntegrationSetup
        initialState={jamieState({ apiKeyConfigured: false })}
        variant="modal"
        onSaved={onSaved}
      />,
    );

    await user.type(screen.getByLabelText("API key"), validJamieApiKey());
    await user.click(screen.getByRole("button", { name: "Save API key" }));

    expect(saveJamieWebhookApiKeyAction).toHaveBeenCalledWith(validJamieApiKey());
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
});

function jamieState(overrides: Partial<GoatJamieProviderState> = {}): GoatJamieProviderState {
  return {
    provider: "jamie",
    connected: false,
    status: "needs_reauth",
    accountName: "Jamie",
    statusReason: "Waiting for Jamie to send the first valid webhook delivery.",
    integrationId: "goat_integration_1",
    webhookUrl: "https://my.opencompany.chat/api/webhooks/jamie",
    apiKeyConfigured: false,
    ...overrides,
  };
}

function validJamieApiKey() {
  return `sk_${"a".repeat(64)}`;
}

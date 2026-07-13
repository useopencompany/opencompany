import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SourceProviderCard } from "@/components/GoatBrainSourceCards";
import type { GoatBrainSourcesDetails, GoatBrainSourceView } from "@/lib/brain-source-actions";
import { GOAT_BRAIN_SOURCE_PROVIDERS } from "@/lib/brain-sources/registry";
import type { GoatJamieProviderState } from "@/lib/integration-state";

const brainSourceActionsMock = vi.hoisted(() => ({
  getGoatBrainSourcesAction: vi.fn(),
  listGoatGitHubRepositoriesAction: vi.fn(),
  listGoatLinearTeamsAction: vi.fn(),
  listGoatSlackConversationsAction: vi.fn(),
  setGoatBrainGitHubSourceAction: vi.fn(),
  setGoatBrainGmailSourceAction: vi.fn(),
  setGoatBrainLinearSourceAction: vi.fn(),
  setGoatBrainSlackSourceAction: vi.fn(),
  setGoatBrainSourceEnabledAction: vi.fn(async () => ({ ok: true })),
}));

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/brain-source-actions", () => brainSourceActionsMock);

vi.mock("@opencompany/ui/components/sonner", () => ({
  toast: toastMock,
}));

describe("GoatBrainSourceCards", () => {
  beforeEach(() => {
    brainSourceActionsMock.getGoatBrainSourcesAction.mockReset();
    brainSourceActionsMock.getGoatBrainSourcesAction.mockResolvedValue(brainSourceDetails());
    brainSourceActionsMock.setGoatBrainSourceEnabledAction.mockClear();
    toastMock.error.mockClear();
  });

  it("allows a saved Jamie API key to be enabled as a brain source before the first webhook", async () => {
    const user = userEvent.setup();
    renderJamieSource(brainSourceDetails());

    const toggle = await screen.findByRole("switch", { name: "Jamie source" });
    expect(toggle).toHaveAttribute("aria-checked", "false");

    await user.click(toggle);

    await waitFor(() =>
      expect(brainSourceActionsMock.setGoatBrainSourceEnabledAction).toHaveBeenCalledWith({
        brainRef: "goat_brain_1",
        provider: "jamie",
        integrationId: "gint_jamie_1",
        enabled: true,
      }),
    );
  });

  it("does not show a setup warning for an enabled Jamie source with saved credentials", async () => {
    renderJamieSource(
      brainSourceDetails({
        sources: [
          {
            provider: "jamie",
            integrationId: "gint_jamie_1",
            enabled: true,
            connectedByName: "Ada Lovelace",
            ownerKind: "workspace" as const,
            canManage: true,
            integrationStatus: "needs_reauth",
            config: {},
          },
        ],
      }),
    );

    const toggle = await screen.findByRole("switch", { name: "Jamie source" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByText("Needs setup")).not.toBeInTheDocument();
  });

  it("supports onboarding-owned setup actions and links to the manual guide", async () => {
    const user = userEvent.setup();
    const onConnect = vi.fn();
    if (!jamieProvider) throw new Error("Jamie source provider is not registered.");

    render(
      <SourceProviderCard
        brainRef="goat_brain_1"
        provider={jamieProvider}
        details={brainSourceDetails({
          jamie: {
            integration: jamieState({
              integrationId: null,
              webhookUrl: null,
              apiKeyConfigured: false,
            }),
            legacyDefaultDelivery: false,
            isDefaultBrain: false,
          },
        })}
        onChanged={async () => {}}
        onConnect={onConnect}
      />,
    );

    expect(screen.getByRole("link", { name: /setup guide/i })).toHaveAttribute(
      "href",
      "/docs/integrations/jamie",
    );
    await user.click(screen.getByRole("button", { name: "Set up" }));
    expect(onConnect).toHaveBeenCalledOnce();
  });
});

const jamieProvider = GOAT_BRAIN_SOURCE_PROVIDERS.find((provider) => provider.id === "jamie");

function renderJamieSource(details: GoatBrainSourcesDetails) {
  if (!jamieProvider) throw new Error("Jamie source provider is not registered.");
  return render(
    <SourceProviderCard
      brainRef="goat_brain_1"
      provider={jamieProvider}
      details={details}
      onChanged={async () => {}}
    />,
  );
}

function brainSourceDetails(
  overrides: Partial<GoatBrainSourcesDetails> & { sources?: GoatBrainSourceView[] } = {},
): GoatBrainSourcesDetails {
  return {
    sources: [],
    jamie: {
      integration: jamieState({
        connected: false,
        status: "needs_reauth",
        apiKeyConfigured: true,
      }),
      legacyDefaultDelivery: false,
      isDefaultBrain: false,
    },
    slack: {
      integration: {
        provider: "slack",
        connected: false,
        status: "not_connected",
        integrationId: null,
        accountName: null,
        teamName: null,
        statusReason: null,
      },
    },
    linear: {
      integration: {
        provider: "linear",
        connected: false,
        status: "not_connected",
        integrationId: null,
        accountName: null,
        organizationName: null,
        statusReason: null,
      },
    },
    github: {
      integration: {
        provider: "github",
        connected: false,
        status: "not_connected",
        integrationId: null,
        accountName: null,
        statusReason: null,
      },
    },
    gmail: {
      integration: {
        provider: "gmail",
        connected: false,
        status: "not_connected",
        integrationId: null,
        accountEmail: null,
        statusReason: null,
      },
    },
    ...overrides,
  };
}

function jamieState(overrides: Partial<GoatJamieProviderState> = {}): GoatJamieProviderState {
  return {
    provider: "jamie",
    connected: false,
    status: "not_connected",
    accountName: "Jamie",
    statusReason: null,
    integrationId: "gint_jamie_1",
    webhookUrl: "https://goat.test/api/webhooks/jamie",
    apiKeyConfigured: false,
    ...overrides,
  };
}

import "@testing-library/jest-dom/vitest";
import type { JamieProviderState } from "@opencompany/core/integration-state";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SourceProviderCard } from "@/components/BrainSourceCards";
import type { BrainSourcesDetails, BrainSourceView } from "@/lib/brain-source-actions";
import { BRAIN_SOURCE_PROVIDERS } from "@/lib/brain-sources/registry";

const brainSourceActionsMock = vi.hoisted(() => ({
  getBrainSourcesAction: vi.fn(),
  listGoogleDriveResourcesAction: vi.fn(),
  listGitHubRepositoriesAction: vi.fn(),
  listLinearTeamsAction: vi.fn(),
  listSlackConversationsAction: vi.fn(),
  setBrainAttioSourceAction: vi.fn(),
  setBrainGitHubSourceAction: vi.fn(),
  setBrainGmailSourceAction: vi.fn(),
  setBrainGoogleDriveSourceAction: vi.fn(),
  setBrainLinearSourceAction: vi.fn(),
  setBrainSlackSourceAction: vi.fn(),
  setBrainSourceEnabledAction: vi.fn(async () => ({ ok: true })),
}));

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/brain-source-actions", () => brainSourceActionsMock);

vi.mock("@opencompany/ui/components/sonner", () => ({
  toast: toastMock,
}));

describe("BrainSourceCards", () => {
  beforeEach(() => {
    brainSourceActionsMock.getBrainSourcesAction.mockReset();
    brainSourceActionsMock.getBrainSourcesAction.mockResolvedValue(brainSourceDetails());
    brainSourceActionsMock.setBrainSourceEnabledAction.mockClear();
    brainSourceActionsMock.setBrainAttioSourceAction.mockReset();
    brainSourceActionsMock.setBrainAttioSourceAction.mockResolvedValue({ ok: true });
    brainSourceActionsMock.listSlackConversationsAction.mockReset();
    brainSourceActionsMock.setBrainSlackSourceAction.mockReset();
    brainSourceActionsMock.setBrainSlackSourceAction.mockResolvedValue({ ok: true });
    brainSourceActionsMock.listGoogleDriveResourcesAction.mockResolvedValue({
      ok: true,
      files: [
        {
          id: "drive_file_1",
          name: "Roadmap",
          kind: "file",
          mimeType: "application/vnd.google-apps.document",
          driveId: null,
          webViewLink: "https://docs.google.com/document/d/drive_file_1/edit",
        },
        {
          id: "drive_folder_1",
          name: "Product",
          kind: "folder",
          mimeType: "application/vnd.google-apps.folder",
          driveId: null,
          webViewLink: "https://drive.google.com/drive/folders/drive_folder_1",
        },
      ],
      nextPageToken: null,
    });
    brainSourceActionsMock.setBrainGoogleDriveSourceAction.mockResolvedValue({ ok: true });
    toastMock.error.mockClear();
  });

  it("allows a saved Jamie API key to be enabled as a brain source before the first webhook", async () => {
    const user = userEvent.setup();
    renderJamieSource(brainSourceDetails());

    const toggle = await screen.findByRole("switch", { name: "Jamie source" });
    expect(toggle).toHaveAttribute("aria-checked", "false");

    await user.click(toggle);

    await waitFor(() =>
      expect(brainSourceActionsMock.setBrainSourceEnabledAction).toHaveBeenCalledWith({
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
            sourceId: "gbscfg_jamie_1",
            provider: "jamie",
            integrationId: "gint_jamie_1",
            enabled: true,
            connectedByName: "Ada Lovelace",
            ownerEmail: "ada@example.com",
            ownerAvatarUrl: null,
            accountEmail: null,
            accountName: "Jamie",
            connectionLabel: null,
            ownerKind: "workspace" as const,
            isOwn: false,
            canConfigure: true,
            canToggle: true,
            canRemove: true,
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

  it("browses and saves personal Drive selections with the workspace visibility warning", async () => {
    const user = userEvent.setup();
    const provider = BRAIN_SOURCE_PROVIDERS.find((entry) => entry.id === "google_drive");
    if (!provider) throw new Error("Google Drive source provider is not registered.");
    render(
      <SourceProviderCard
        brainRef="goat_brain_1"
        provider={provider}
        details={brainSourceDetails({
          googleDrive: {
            integration: {
              provider: "google_drive",
              connected: true,
              status: "connected",
              integrationId: "gint_drive_1",
              accountEmail: "owner@example.com",
              statusReason: null,
            },
          },
        })}
        onChanged={async () => {}}
      />,
    );

    expect(
      screen.getByText(/Selected Drive content will be summarized into this brain/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Select files and folders/ }));
    expect(await screen.findByText("Roadmap")).toBeInTheDocument();
    expect(screen.getByText("Recursive")).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Select Roadmap" }));
    await user.click(screen.getByRole("button", { name: "Save Google Drive source" }));

    await waitFor(() =>
      expect(brainSourceActionsMock.setBrainGoogleDriveSourceAction).toHaveBeenCalledWith({
        brainRef: "goat_brain_1",
        integrationId: "gint_drive_1",
        enabled: true,
        allFiles: false,
        resourceIds: ["drive_file_1"],
      }),
    );
  });

  it("saves personal Drive sources in all-files mode", async () => {
    const user = userEvent.setup();
    const provider = BRAIN_SOURCE_PROVIDERS.find((entry) => entry.id === "google_drive");
    if (!provider) throw new Error("Google Drive source provider is not registered.");
    render(
      <SourceProviderCard
        brainRef="goat_brain_1"
        provider={provider}
        details={brainSourceDetails({
          googleDrive: {
            integration: {
              provider: "google_drive",
              connected: true,
              status: "connected",
              integrationId: "gint_drive_1",
              accountEmail: "owner@example.com",
              statusReason: null,
            },
          },
        })}
        onChanged={async () => {}}
      />,
    );

    await user.click(screen.getByRole("checkbox", { name: /Subscribe to all files/ }));
    await user.click(screen.getByRole("button", { name: "Save Google Drive source" }));

    await waitFor(() =>
      expect(brainSourceActionsMock.setBrainGoogleDriveSourceAction).toHaveBeenCalledWith({
        brainRef: "goat_brain_1",
        integrationId: "gint_drive_1",
        enabled: true,
        allFiles: true,
        resourceIds: [],
      }),
    );
  });

  it("surfaces Slack Connect conversations and bulk-selects each privacy group", async () => {
    const user = userEvent.setup();
    const provider = BRAIN_SOURCE_PROVIDERS.find((entry) => entry.id === "slack");
    if (!provider) throw new Error("Slack source provider is not registered.");
    brainSourceActionsMock.listSlackConversationsAction.mockResolvedValue({
      ok: true,
      channels: [
        { id: "C_GENERAL", name: "general", isPrivate: false, isSlackConnect: false },
        { id: "C_CONNECT", name: "acme-partner", isPrivate: true, isSlackConnect: true },
      ],
      dms: [
        { id: "D_TEAMMATE", name: "Grace", isSlackConnect: false },
        { id: "D_CONNECT", name: "External Partner", isSlackConnect: true },
      ],
      partial: false,
    });

    render(
      <SourceProviderCard
        brainRef="goat_brain_1"
        provider={provider}
        details={brainSourceDetails({ sources: [slackSource()] })}
        onChanged={async () => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Choose conversations" }));

    const slackConnectTitle = await screen.findByText("Slack Connect");
    const slackConnectSection = slackConnectTitle.parentElement?.parentElement;
    if (!slackConnectSection) throw new Error("Slack Connect section was not rendered.");
    expect(
      within(slackConnectSection).getByText(/people outside your Slack workspace/),
    ).toBeInTheDocument();
    expect(
      within(slackConnectSection).getByRole("checkbox", { name: /External Partner/ }),
    ).not.toBeChecked();

    await user.click(
      within(slackConnectSection).getByRole("button", {
        name: "Select all Slack Connect conversations",
      }),
    );

    expect(
      within(slackConnectSection).getByRole("checkbox", { name: /acme-partner/ }),
    ).toBeChecked();
    expect(
      within(slackConnectSection).getByRole("checkbox", { name: /External Partner/ }),
    ).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /#general/ })).not.toBeChecked();
    expect(screen.queryByRole("checkbox", { name: "Grace" })).not.toBeInTheDocument();

    const directMessagesButton = screen.getByRole("button", { name: "Direct messages" });
    await user.click(directMessagesButton);
    const directMessagesSection = directMessagesButton.parentElement?.parentElement;
    if (!directMessagesSection) throw new Error("Direct messages section was not rendered.");
    await user.click(
      within(directMessagesSection).getByRole("button", {
        name: "Select all direct messages",
      }),
    );
    expect(screen.getByRole("checkbox", { name: "Grace" })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Save conversations" }));

    await waitFor(() =>
      expect(brainSourceActionsMock.setBrainSlackSourceAction).toHaveBeenCalledWith({
        brainRef: "goat_brain_1",
        integrationId: "gint_slack_1",
        enabled: true,
        channels: [{ id: "C_CONNECT", name: "acme-partner" }],
        dms: [
          { id: "D_CONNECT", name: "External Partner" },
          { id: "D_TEAMMATE", name: "Grace" },
        ],
      }),
    );
  });

  it("uses safe Attio defaults and never offers system updates", async () => {
    const user = userEvent.setup();
    const provider = BRAIN_SOURCE_PROVIDERS.find((entry) => entry.id === "attio");
    if (!provider) throw new Error("Attio source provider is not registered.");
    render(
      <SourceProviderCard
        brainRef="goat_brain_1"
        provider={provider}
        details={brainSourceDetails({
          sources: [
            attioSource({
              config: { objectTypes: [{ id: "person" }], includeSystemUpdates: true },
            }),
          ],
          attio: {
            integration: {
              provider: "attio",
              connected: true,
              status: "connected",
              integrationId: "gint_attio_1",
              workspaceName: "Acme",
              statusReason: null,
            },
          },
        })}
        onChanged={async () => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Choose records and events" }));
    expect(screen.getByRole("checkbox", { name: "Record created" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Note added" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Record updated" })).not.toBeChecked();
    expect(
      screen.queryByRole("checkbox", { name: /Include Attio automation/ }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Record updated" }));
    expect(
      screen.queryByRole("checkbox", { name: /Include Attio automation/ }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save Attio source" }));

    await waitFor(() =>
      expect(brainSourceActionsMock.setBrainAttioSourceAction).toHaveBeenCalledWith({
        brainRef: "goat_brain_1",
        integrationId: "gint_attio_1",
        enabled: true,
        objectTypes: [{ id: "person" }],
        events: [{ id: "object_created" }, { id: "note_added" }, { id: "object_updated" }],
      }),
    );
  });

  it("renders one row per source with owner-only config and admin veto affordances", async () => {
    const user = userEvent.setup();
    const provider = BRAIN_SOURCE_PROVIDERS.find((entry) => entry.id === "gmail");
    if (!provider) throw new Error("Gmail source provider is not registered.");
    render(
      <SourceProviderCard
        brainRef="goat_brain_1"
        provider={provider}
        details={brainSourceDetails({
          sources: [
            gmailSource({
              sourceId: "gbscfg_own",
              integrationId: "gint_gmail_own",
              connectedByName: "Admin Ada",
              accountEmail: "ada@example.com",
              isOwn: true,
              canConfigure: true,
              canToggle: true,
              canRemove: true,
            }),
            gmailSource({
              sourceId: "gbscfg_member",
              integrationId: "gint_gmail_member",
              connectedByName: "Maya Chen",
              accountEmail: "maya@example.com",
              isOwn: false,
              canConfigure: false,
              canToggle: true,
              canRemove: true,
            }),
          ],
        })}
        onChanged={async () => {}}
      />,
    );

    expect(screen.getByText("You")).toBeInTheDocument();
    expect(screen.getByText("Maya Chen")).toBeInTheDocument();
    expect(screen.getByText(/2 sources · 2 ingesting/)).toBeInTheDocument();
    expect(
      screen.getByText(/Managed by Maya Chen · only they can change what's ingested/),
    ).toBeInTheDocument();
    // Both rows can be toggled (owner + admin veto), and removed.
    expect(screen.getAllByRole("switch", { name: "Gmail source" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(2);

    await user.click(screen.getAllByRole("button", { name: "Remove" })[1]!);
    expect(screen.getByText(/Remove Maya Chen's Gmail \(maya@example.com\)/)).toBeInTheDocument();
  });

  it("renders another member's source read-only for non-admin members", () => {
    const provider = BRAIN_SOURCE_PROVIDERS.find((entry) => entry.id === "gmail");
    if (!provider) throw new Error("Gmail source provider is not registered.");
    render(
      <SourceProviderCard
        brainRef="goat_brain_1"
        provider={provider}
        details={brainSourceDetails({
          viewer: { workosUserId: "user_member_2", isAdmin: false },
          sources: [
            gmailSource({
              sourceId: "gbscfg_member",
              integrationId: "gint_gmail_member",
              connectedByName: "Maya Chen",
              accountEmail: "maya@example.com",
              isOwn: false,
              canConfigure: false,
              canToggle: false,
              canRemove: false,
            }),
          ],
        })}
        onChanged={async () => {}}
      />,
    );

    expect(screen.getByText("Managed by Maya Chen")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Gmail source" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
  });

  it("adds one of the member's own accounts after the consent step", async () => {
    const user = userEvent.setup();
    const provider = BRAIN_SOURCE_PROVIDERS.find((entry) => entry.id === "gmail");
    if (!provider) throw new Error("Gmail source provider is not registered.");
    render(
      <SourceProviderCard
        brainRef="goat_brain_1"
        provider={provider}
        details={brainSourceDetails({
          sources: [
            gmailSource({
              sourceId: "gbscfg_own",
              integrationId: "gint_gmail_own",
              connectedByName: "Admin Ada",
              accountEmail: "ada@example.com",
              isOwn: true,
              canConfigure: true,
              canToggle: true,
              canRemove: true,
            }),
          ],
          ownAccounts: {
            slack: [],
            linear: [],
            gmail: [
              {
                integrationId: "gint_gmail_second",
                status: "connected",
                accountEmail: "ada.second@example.com",
                accountName: null,
                connectionLabel: null,
              },
            ],
            google_drive: [],
            hubspot: [],
            granola: [],
            fathom: [],
            attio: [],
          },
        })}
        onChanged={async () => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Add ada.second@example.com/ }));
    expect(
      screen.getByText(/Everyone with access to this brain, now and in the future/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add to brain" }));

    await waitFor(() =>
      expect(brainSourceActionsMock.setBrainSourceEnabledAction).toHaveBeenCalledWith({
        brainRef: "goat_brain_1",
        provider: "gmail",
        integrationId: "gint_gmail_second",
        enabled: true,
      }),
    );
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

const jamieProvider = BRAIN_SOURCE_PROVIDERS.find((provider) => provider.id === "jamie");

function renderJamieSource(details: BrainSourcesDetails) {
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
  overrides: Partial<BrainSourcesDetails> & { sources?: BrainSourceView[] } = {},
): BrainSourcesDetails {
  return {
    viewer: { workosUserId: "user_admin_1", isAdmin: true },
    sources: [],
    ownAccounts: {
      slack: [],
      linear: [],
      gmail: [],
      google_drive: [],
      hubspot: [],
      granola: [],
      fathom: [],
      attio: [],
    },
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
    googleDrive: {
      integration: {
        provider: "google_drive",
        connected: false,
        status: "not_connected",
        integrationId: null,
        accountEmail: null,
        statusReason: null,
      },
    },
    hubspot: {
      integration: {
        provider: "hubspot",
        connected: false,
        status: "not_connected",
        integrationId: null,
        accountEmail: null,
        hubDomain: null,
        statusReason: null,
      },
    },
    granola: {
      integration: {
        provider: "granola",
        connected: false,
        status: "not_connected",
        integrationId: null,
        accountEmail: null,
        accountName: null,
        statusReason: null,
      },
    },
    fathom: {
      integration: {
        provider: "fathom",
        connected: false,
        status: "not_connected",
        integrationId: null,
        accountEmail: null,
        accountName: null,
        statusReason: null,
      },
    },
    attio: {
      integration: {
        provider: "attio",
        connected: false,
        status: "not_connected",
        integrationId: null,
        workspaceName: null,
        statusReason: null,
      },
    },
    ...overrides,
  };
}

function gmailSource(overrides: Partial<BrainSourceView> = {}): BrainSourceView {
  return {
    sourceId: "gbscfg_gmail_1",
    provider: "gmail",
    integrationId: "gint_gmail_1",
    enabled: true,
    connectedByName: "Ada Lovelace",
    ownerEmail: "ada@example.com",
    ownerAvatarUrl: null,
    accountEmail: "ada@example.com",
    accountName: null,
    connectionLabel: null,
    ownerKind: "user",
    isOwn: false,
    canConfigure: false,
    canToggle: false,
    canRemove: false,
    integrationStatus: "connected",
    config: {},
    ...overrides,
  };
}

function slackSource(overrides: Partial<BrainSourceView> = {}): BrainSourceView {
  return {
    sourceId: "gbscfg_slack_1",
    provider: "slack",
    integrationId: "gint_slack_1",
    enabled: true,
    connectedByName: "Ada Lovelace",
    ownerEmail: "ada@example.com",
    ownerAvatarUrl: null,
    accountEmail: "ada@example.com",
    accountName: "Ada",
    connectionLabel: "Acme",
    ownerKind: "user",
    isOwn: true,
    canConfigure: true,
    canToggle: true,
    canRemove: true,
    integrationStatus: "connected",
    config: {},
    ...overrides,
  };
}

function attioSource(overrides: Partial<BrainSourceView> = {}): BrainSourceView {
  return {
    sourceId: "gbscfg_attio_1",
    provider: "attio",
    integrationId: "gint_attio_1",
    enabled: true,
    connectedByName: "Ada Lovelace",
    ownerEmail: "ada@example.com",
    ownerAvatarUrl: null,
    accountEmail: null,
    accountName: "acme",
    connectionLabel: "Acme",
    ownerKind: "user",
    isOwn: true,
    canConfigure: true,
    canToggle: true,
    canRemove: true,
    integrationStatus: "connected",
    config: {},
    ...overrides,
  };
}

function jamieState(overrides: Partial<JamieProviderState> = {}): JamieProviderState {
  return {
    provider: "jamie",
    connected: false,
    status: "not_connected",
    accountName: "Jamie",
    statusReason: null,
    integrationId: "gint_jamie_1",
    webhookUrl: "https://app.test/api/webhooks/jamie",
    apiKeyConfigured: false,
    ...overrides,
  };
}

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  github: vi.fn(),
  googleDrive: vi.fn(),
  noop: vi.fn(),
  remote: vi.fn(),
  registrations: vi.fn(),
}));

vi.mock("../plugin-gateway", () => ({
  resolvePluginGatewayRegistrations: mocks.registrations,
}));
vi.mock("./attio", () => ({ resolveAttioActions: mocks.noop }));
vi.mock("./github", () => ({ resolveGitHubActions: mocks.github }));
vi.mock("./gmail", () => ({ resolveGmailActions: mocks.noop }));
vi.mock("./google-calendar", () => ({ resolveGoogleCalendarActions: mocks.noop }));
vi.mock("./google-drive", () => ({ resolveGoogleDriveActions: mocks.googleDrive }));
vi.mock("./latitude", () => ({ resolveLatitudeActions: mocks.noop }));
vi.mock("./linear", () => ({ resolveLinearActions: mocks.noop }));
vi.mock("./neon", () => ({ resolveNeonActions: mocks.noop }));
vi.mock("./posthog", () => ({ resolvePostHogActions: mocks.noop }));
vi.mock("./remote-mcp", () => ({ resolveRemoteMcpActions: mocks.remote }));
vi.mock("./revolut", () => ({ resolveRevolutActions: mocks.noop }));
vi.mock("./stripe", () => ({ resolveStripeActions: mocks.noop }));
vi.mock("./x-account", () => ({ resolveXAccountActions: mocks.noop }));

import { resolveActionCatalog } from "./catalog";
import type { RemoteMcpGatewayRegistration } from "./remote-mcp";

describe("resolveActionCatalog plugin reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.noop.mockResolvedValue(null);
    mocks.remote.mockResolvedValue(null);
    mocks.registrations.mockResolvedValue([]);
    mocks.github.mockResolvedValue({
      id: "github",
      label: "GitHub",
      description: "Legacy workspace GitHub actions.",
      actions: [{ id: "github.search_issues" }],
    });
    mocks.googleDrive.mockResolvedValue({
      id: "google_drive",
      label: "Google Drive",
      description: "Legacy Google Drive actions.",
      actions: [{ id: "google_drive.search_files" }],
    });
  });

  it("keeps the legacy GitHub issue search when the official plugin is absent", async () => {
    const catalog = await resolveActionCatalog(
      { userWorkosId: "user_1", workspaceId: "workspace_1" },
      { remoteMcpRegistrations: [] },
    );

    expect(mocks.github).toHaveBeenCalledWith("workspace_1");
    expect(catalog.actions).toContainEqual(expect.objectContaining({ id: "github.search_issues" }));
  });

  it("suppresses the legacy GitHub issue search when the official plugin is installed", async () => {
    const githubPluginRegistration = {
      source: "plugin:github:github",
      getState: vi.fn().mockResolvedValue({
        connected: true,
        integrationId: "gint_github_user",
        capabilityModes: {},
        toolModes: {},
      }),
    } as unknown as RemoteMcpGatewayRegistration;

    const catalog = await resolveActionCatalog(
      { userWorkosId: "user_1", workspaceId: "workspace_1" },
      { remoteMcpRegistrations: [githubPluginRegistration] },
    );

    expect(mocks.github).not.toHaveBeenCalled();
    expect(mocks.remote).toHaveBeenCalledWith(
      { userWorkosId: "user_1", workspaceId: "workspace_1" },
      githubPluginRegistration,
    );
    expect(catalog.actions).not.toContainEqual(
      expect.objectContaining({ id: "github.search_issues" }),
    );
  });

  it("keeps the legacy GitHub issue search for members without a personal connection", async () => {
    const githubPluginRegistration = {
      source: "plugin:github:github",
      getState: vi.fn().mockResolvedValue({
        connected: false,
        integrationId: null,
        capabilityModes: {},
        toolModes: {},
      }),
    } as unknown as RemoteMcpGatewayRegistration;

    const catalog = await resolveActionCatalog(
      { userWorkosId: "user_without_github", workspaceId: "workspace_1" },
      { remoteMcpRegistrations: [githubPluginRegistration] },
    );

    expect(githubPluginRegistration.getState).toHaveBeenCalledWith({
      userWorkosId: "user_without_github",
      workspaceId: "workspace_1",
    });
    expect(mocks.github).toHaveBeenCalledWith("workspace_1");
    expect(catalog.actions).toContainEqual(expect.objectContaining({ id: "github.search_issues" }));
  });

  it("exposes Slack tools only through the official plugin", async () => {
    const withoutPlugin = await resolveActionCatalog(
      { userWorkosId: "user_1", workspaceId: "workspace_1" },
      { remoteMcpRegistrations: [] },
    );
    expect(withoutPlugin.actions).not.toContainEqual(
      expect.objectContaining({ provider: expect.stringContaining("slack") }),
    );

    const slackPluginRegistration = {
      source: "plugin:slack:slack",
    } as unknown as RemoteMcpGatewayRegistration;
    mocks.remote.mockResolvedValueOnce({
      id: "plugin:slack:slack",
      label: "Slack",
      description: "Official Slack plugin tools.",
      actions: [{ id: "plugin:slack:slack.search" }],
    });
    const withPlugin = await resolveActionCatalog(
      { userWorkosId: "user_1", workspaceId: "workspace_1" },
      { remoteMcpRegistrations: [slackPluginRegistration] },
    );

    expect(mocks.remote).toHaveBeenCalledWith(
      { userWorkosId: "user_1", workspaceId: "workspace_1" },
      slackPluginRegistration,
    );
    expect(withPlugin.actions).toContainEqual(
      expect.objectContaining({ id: "plugin:slack:slack.search" }),
    );
  });

  it("keeps legacy Drive actions as fallback and suppresses them after plugin install", async () => {
    const withoutPlugin = await resolveActionCatalog(
      { userWorkosId: "user_1", workspaceId: "workspace_1" },
      { remoteMcpRegistrations: [] },
    );
    expect(mocks.googleDrive).toHaveBeenCalledWith("user_1");
    expect(withoutPlugin.actions).toContainEqual(
      expect.objectContaining({ id: "google_drive.search_files" }),
    );

    mocks.googleDrive.mockClear();
    const googleDrivePluginRegistration = {
      source: "plugin:google-drive:google-drive",
    } as unknown as RemoteMcpGatewayRegistration;
    await resolveActionCatalog(
      { userWorkosId: "user_1", workspaceId: "workspace_1" },
      { remoteMcpRegistrations: [googleDrivePluginRegistration] },
    );

    expect(mocks.googleDrive).not.toHaveBeenCalled();
    expect(mocks.remote).toHaveBeenCalledWith(
      { userWorkosId: "user_1", workspaceId: "workspace_1" },
      googleDrivePluginRegistration,
    );
  });
});

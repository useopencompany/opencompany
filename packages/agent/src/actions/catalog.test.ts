import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  github: vi.fn(),
  noop: vi.fn(),
  remote: vi.fn(),
  registrations: vi.fn(),
  slack: vi.fn(),
}));

vi.mock("../plugin-gateway", () => ({
  resolvePluginGatewayRegistrations: mocks.registrations,
}));
vi.mock("./attio", () => ({ resolveAttioActions: mocks.noop }));
vi.mock("./github", () => ({ resolveGitHubActions: mocks.github }));
vi.mock("./gmail", () => ({ resolveGmailActions: mocks.noop }));
vi.mock("./google-calendar", () => ({ resolveGoogleCalendarActions: mocks.noop }));
vi.mock("./google-drive", () => ({ resolveGoogleDriveActions: mocks.noop }));
vi.mock("./latitude", () => ({ resolveLatitudeActions: mocks.noop }));
vi.mock("./linear", () => ({ resolveLinearActions: mocks.noop }));
vi.mock("./neon", () => ({ resolveNeonActions: mocks.noop }));
vi.mock("./posthog", () => ({ resolvePostHogActions: mocks.noop }));
vi.mock("./remote-mcp", () => ({ resolveRemoteMcpActions: mocks.remote }));
vi.mock("./revolut", () => ({ resolveRevolutActions: mocks.noop }));
vi.mock("./slack", () => ({ resolveSlackActions: mocks.slack }));
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
    mocks.slack.mockResolvedValue({
      id: "slack",
      label: "Slack",
      description: "Legacy Slack actions.",
      actions: [{ id: "slack.search_messages" }],
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

  it("uses legacy Slack actions only until the official Slack plugin is installed", async () => {
    const withoutPlugin = await resolveActionCatalog(
      { userWorkosId: "user_1", workspaceId: "workspace_1" },
      { remoteMcpRegistrations: [] },
    );
    expect(mocks.slack).toHaveBeenCalledWith("user_1");
    expect(withoutPlugin.actions).toContainEqual(
      expect.objectContaining({ id: "slack.search_messages" }),
    );

    mocks.slack.mockClear();
    const slackPluginRegistration = {
      source: "plugin:slack:slack",
    } as unknown as RemoteMcpGatewayRegistration;
    const withPlugin = await resolveActionCatalog(
      { userWorkosId: "user_1", workspaceId: "workspace_1" },
      { remoteMcpRegistrations: [slackPluginRegistration] },
    );

    expect(mocks.slack).not.toHaveBeenCalled();
    expect(mocks.remote).toHaveBeenCalledWith(
      { userWorkosId: "user_1", workspaceId: "workspace_1" },
      slackPluginRegistration,
    );
    expect(withPlugin.actions).not.toContainEqual(
      expect.objectContaining({ id: "slack.search_messages" }),
    );
  });
});

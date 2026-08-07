import { GOAT_ACTION_EFFECTS_READ } from "@opencompany/core/actions/types";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveAttioActions: vi.fn(),
  resolveSlackActions: vi.fn(),
  resolveGmailActions: vi.fn(),
  resolveGoogleCalendarActions: vi.fn(),
  resolveGoogleDriveActions: vi.fn(),
  resolveLatitudeActions: vi.fn(),
  resolveNeonActions: vi.fn(),
  resolveLinearActions: vi.fn(),
  resolvePostHogActions: vi.fn(),
  resolveGitHubActions: vi.fn(),
  resolveStripeActions: vi.fn(),
  resolveRevolutActions: vi.fn(),
  listGoatWorkspaceCapabilities: vi.fn(),
}));

vi.mock("@opencompany/db/capabilities", () => ({
  listGoatWorkspaceCapabilities: mocks.listGoatWorkspaceCapabilities,
}));

vi.mock("@opencompany/core/actions/attio", () => ({
  resolveAttioActions: mocks.resolveAttioActions,
}));
vi.mock("@opencompany/core/actions/slack", () => ({
  resolveSlackActions: mocks.resolveSlackActions,
}));
vi.mock("@opencompany/core/actions/gmail", () => ({
  resolveGmailActions: mocks.resolveGmailActions,
}));
vi.mock("@opencompany/core/actions/google-calendar", () => ({
  resolveGoogleCalendarActions: mocks.resolveGoogleCalendarActions,
}));
vi.mock("@opencompany/core/actions/google-drive", () => ({
  resolveGoogleDriveActions: mocks.resolveGoogleDriveActions,
}));
vi.mock("@opencompany/core/actions/latitude", () => ({
  resolveLatitudeActions: mocks.resolveLatitudeActions,
}));
vi.mock("@opencompany/core/actions/linear", () => ({
  resolveLinearActions: mocks.resolveLinearActions,
}));
vi.mock("@opencompany/core/actions/neon", () => ({
  resolveNeonActions: mocks.resolveNeonActions,
}));
vi.mock("@opencompany/core/actions/posthog", () => ({
  resolvePostHogActions: mocks.resolvePostHogActions,
}));
vi.mock("@opencompany/core/actions/github", () => ({
  resolveGitHubActions: mocks.resolveGitHubActions,
}));
vi.mock("@opencompany/core/actions/stripe", () => ({
  resolveStripeActions: mocks.resolveStripeActions,
}));
vi.mock("@opencompany/core/actions/revolut", () => ({
  resolveRevolutActions: mocks.resolveRevolutActions,
}));

import { isGoatChatActionsKilled, resolveGoatActionCatalog } from "@/lib/actions/catalog";
import type { GoatActionProviderCatalog } from "@/lib/actions/types";

function providerCatalog(
  id:
    | "slack"
    | "gmail"
    | "google_calendar"
    | "google_drive"
    | "latitude"
    | "neon"
    | "linear"
    | "posthog"
    | "attio"
    | "github"
    | "stripe"
    | "revolut",
): GoatActionProviderCatalog {
  return {
    id,
    label: `${id} label`,
    description: `${id} description`,
    actions: [
      {
        id: `${id}.read_something`,
        provider: id,
        capability: "read",
        effects: GOAT_ACTION_EFFECTS_READ,
        permissionMode: "on",
        description: "read",
        params: { type: "object" },
        execute: vi.fn(),
      },
    ],
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isGoatChatActionsKilled", () => {
  it("is off unless the env var is exactly true", () => {
    vi.stubEnv("CHAT_ACTIONS_KILL_SWITCH", "");
    expect(isGoatChatActionsKilled()).toBe(false);
    vi.stubEnv("CHAT_ACTIONS_KILL_SWITCH", "1");
    expect(isGoatChatActionsKilled()).toBe(false);
    vi.stubEnv("CHAT_ACTIONS_KILL_SWITCH", "true");
    expect(isGoatChatActionsKilled()).toBe(true);
  });
});

describe("resolveGoatActionCatalog", () => {
  it("includes only connected providers", async () => {
    mocks.resolveSlackActions.mockResolvedValue(providerCatalog("slack"));
    mocks.resolveGmailActions.mockResolvedValue(null);
    mocks.resolveGoogleCalendarActions.mockResolvedValue(providerCatalog("google_calendar"));
    mocks.resolveGoogleDriveActions.mockResolvedValue(providerCatalog("google_drive"));
    mocks.resolveLinearActions.mockResolvedValue(providerCatalog("linear"));
    mocks.resolvePostHogActions.mockResolvedValue(providerCatalog("posthog"));
    mocks.resolveLatitudeActions.mockResolvedValue(providerCatalog("latitude"));
    mocks.resolveNeonActions.mockResolvedValue(providerCatalog("neon"));
    mocks.resolveAttioActions.mockResolvedValue(providerCatalog("attio"));
    mocks.resolveGitHubActions.mockResolvedValue(providerCatalog("github"));
    mocks.resolveStripeActions.mockResolvedValue(providerCatalog("stripe"));
    mocks.resolveRevolutActions.mockResolvedValue(providerCatalog("revolut"));

    const catalog = await resolveGoatActionCatalog({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
    });
    expect(catalog.providers.map((provider) => provider.id)).toEqual([
      "slack",
      "google_calendar",
      "google_drive",
      "linear",
      "posthog",
      "latitude",
      "neon",
      "attio",
      "github",
      "stripe",
      "revolut",
    ]);
    expect(catalog.providers.map((provider) => provider.description)).toEqual([
      "slack description",
      "google_calendar description",
      "google_drive description",
      "linear description",
      "posthog description",
      "latitude description",
      "neon description",
      "attio description",
      "github description",
      "stripe description",
      "revolut description",
    ]);
    expect(catalog.actions.map((action) => action.id)).toEqual([
      "slack.read_something",
      "google_calendar.read_something",
      "google_drive.read_something",
      "linear.read_something",
      "posthog.read_something",
      "latitude.read_something",
      "neon.read_something",
      "attio.read_something",
      "github.read_something",
      "stripe.read_something",
      "revolut.read_something",
    ]);
    expect(mocks.resolveGitHubActions).toHaveBeenCalledWith("workspace_1");
    expect(mocks.resolveStripeActions).toHaveBeenCalledWith("workspace_1");
    expect(mocks.resolveRevolutActions).toHaveBeenCalledWith("workspace_1");
  });

  it("keeps other providers when one resolver throws", async () => {
    mocks.resolveSlackActions.mockRejectedValue(new Error("boom"));
    mocks.resolveGmailActions.mockResolvedValue(providerCatalog("gmail"));
    mocks.resolveGoogleCalendarActions.mockResolvedValue(null);
    mocks.resolveGoogleDriveActions.mockResolvedValue(null);
    mocks.resolveLinearActions.mockResolvedValue(null);
    mocks.resolvePostHogActions.mockResolvedValue(null);
    mocks.resolveLatitudeActions.mockResolvedValue(null);
    mocks.resolveNeonActions.mockResolvedValue(null);
    mocks.resolveAttioActions.mockResolvedValue(null);
    mocks.resolveGitHubActions.mockResolvedValue(null);
    mocks.resolveStripeActions.mockResolvedValue(null);
    mocks.resolveRevolutActions.mockResolvedValue(null);

    const catalog = await resolveGoatActionCatalog({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
    });
    expect(catalog.providers.map((provider) => provider.id)).toEqual(["gmail"]);
  });

  it("returns an empty catalog when nothing is connected", async () => {
    mocks.resolveSlackActions.mockResolvedValue(null);
    mocks.resolveGmailActions.mockResolvedValue(null);
    mocks.resolveGoogleCalendarActions.mockResolvedValue(null);
    mocks.resolveGoogleDriveActions.mockResolvedValue(null);
    mocks.resolveLinearActions.mockResolvedValue(null);
    mocks.resolvePostHogActions.mockResolvedValue(null);
    mocks.resolveLatitudeActions.mockResolvedValue(null);
    mocks.resolveNeonActions.mockResolvedValue(null);
    mocks.resolveAttioActions.mockResolvedValue(null);
    mocks.resolveGitHubActions.mockResolvedValue(null);
    mocks.resolveStripeActions.mockResolvedValue(null);
    mocks.resolveRevolutActions.mockResolvedValue(null);

    const catalog = await resolveGoatActionCatalog({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
    });
    expect(catalog).toEqual({ providers: [], actions: [] });
  });

  it("adds enabled managed sources to the same compact catalog", async () => {
    vi.stubEnv("MONID_API_KEY", "monid_test");
    vi.stubEnv("MANAGED_CAPABILITIES_KILL_SWITCH", "");
    mocks.resolveSlackActions.mockResolvedValue(null);
    mocks.resolveGmailActions.mockResolvedValue(null);
    mocks.resolveGoogleCalendarActions.mockResolvedValue(null);
    mocks.resolveGoogleDriveActions.mockResolvedValue(null);
    mocks.resolveLinearActions.mockResolvedValue(null);
    mocks.resolvePostHogActions.mockResolvedValue(null);
    mocks.resolveLatitudeActions.mockResolvedValue(null);
    mocks.resolveNeonActions.mockResolvedValue(null);
    mocks.resolveAttioActions.mockResolvedValue(null);
    mocks.resolveGitHubActions.mockResolvedValue(null);
    mocks.resolveStripeActions.mockResolvedValue(null);
    mocks.resolveRevolutActions.mockResolvedValue(null);
    mocks.listGoatWorkspaceCapabilities.mockResolvedValue([
      { source: "x", enabled: true },
      { source: "linkedin", enabled: false },
      { source: "youtube", enabled: true },
      { source: "instagram", enabled: true },
      { source: "tiktok", enabled: true },
      { source: "lead", enabled: true },
      { source: "seo", enabled: true },
    ]);

    const catalog = await resolveGoatActionCatalog({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
    });
    expect(catalog.providers.map((source) => [source.id, source.kind])).toEqual([
      ["x", "managed"],
      ["youtube", "managed"],
      ["instagram", "managed"],
      ["tiktok", "managed"],
      ["lead", "managed"],
      ["seo", "managed"],
    ]);
    expect(catalog.actions).not.toContainEqual(expect.objectContaining({ provider: "linkedin" }));
    expect(catalog.actions.filter((action) => action.provider === "x")).toHaveLength(7);
    expect(catalog.actions.filter((action) => action.provider === "lead")).toHaveLength(5);
    expect(catalog.actions.filter((action) => action.provider === "seo")).toHaveLength(6);
    expect(catalog.actions.find((action) => action.id === "youtube.get_transcript")).toMatchObject({
      provider: "youtube",
      maxResultChars: 256_000,
    });

    vi.stubEnv("DISABLED_MANAGED_CAPABILITY_ACTIONS", "x.search_posts");
    const endpointDisabledCatalog = await resolveGoatActionCatalog({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
    });
    expect(endpointDisabledCatalog.actions.some((action) => action.id === "x.search_posts")).toBe(
      false,
    );
    expect(
      endpointDisabledCatalog.actions.filter((action) => action.provider === "x"),
    ).toHaveLength(6);
    expect(endpointDisabledCatalog.providers.some((source) => source.id === "x")).toBe(true);
  });

  it("removes managed sources behind the dedicated global kill switch", async () => {
    vi.stubEnv("MONID_API_KEY", "monid_test");
    vi.stubEnv("MANAGED_CAPABILITIES_KILL_SWITCH", "true");
    mocks.resolveSlackActions.mockResolvedValue(providerCatalog("slack"));
    mocks.resolveGmailActions.mockResolvedValue(null);
    mocks.resolveGoogleCalendarActions.mockResolvedValue(null);
    mocks.resolveGoogleDriveActions.mockResolvedValue(null);
    mocks.resolveLinearActions.mockResolvedValue(null);
    mocks.resolvePostHogActions.mockResolvedValue(null);
    mocks.resolveLatitudeActions.mockResolvedValue(null);
    mocks.resolveNeonActions.mockResolvedValue(null);
    mocks.resolveAttioActions.mockResolvedValue(null);
    mocks.resolveGitHubActions.mockResolvedValue(null);
    mocks.resolveStripeActions.mockResolvedValue(null);
    mocks.resolveRevolutActions.mockResolvedValue(null);

    const catalog = await resolveGoatActionCatalog({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
    });
    expect(catalog.providers.map((source) => source.id)).toEqual(["slack"]);
    expect(mocks.listGoatWorkspaceCapabilities).not.toHaveBeenCalled();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveSlackActions: vi.fn(),
  resolveGmailActions: vi.fn(),
  resolveGoogleDriveActions: vi.fn(),
  resolveLinearActions: vi.fn(),
}));

vi.mock("@/lib/actions/slack", () => ({ resolveSlackActions: mocks.resolveSlackActions }));
vi.mock("@/lib/actions/gmail", () => ({ resolveGmailActions: mocks.resolveGmailActions }));
vi.mock("@/lib/actions/google-drive", () => ({
  resolveGoogleDriveActions: mocks.resolveGoogleDriveActions,
}));
vi.mock("@/lib/actions/linear", () => ({ resolveLinearActions: mocks.resolveLinearActions }));

import { isGoatChatActionsKilled, resolveGoatActionCatalog } from "@/lib/actions/catalog";
import type { GoatActionProviderCatalog } from "@/lib/actions/types";

function providerCatalog(
  id: "slack" | "gmail" | "google_drive" | "linear",
): GoatActionProviderCatalog {
  return {
    id,
    label: `${id} label`,
    description: `${id} description`,
    actions: [
      {
        id: `${id}.read_something`,
        provider: id,
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
    vi.stubEnv("GOAT_CHAT_ACTIONS_KILL_SWITCH", "");
    expect(isGoatChatActionsKilled()).toBe(false);
    vi.stubEnv("GOAT_CHAT_ACTIONS_KILL_SWITCH", "1");
    expect(isGoatChatActionsKilled()).toBe(false);
    vi.stubEnv("GOAT_CHAT_ACTIONS_KILL_SWITCH", "true");
    expect(isGoatChatActionsKilled()).toBe(true);
  });
});

describe("resolveGoatActionCatalog", () => {
  it("includes only connected providers", async () => {
    mocks.resolveSlackActions.mockResolvedValue(providerCatalog("slack"));
    mocks.resolveGmailActions.mockResolvedValue(null);
    mocks.resolveGoogleDriveActions.mockResolvedValue(providerCatalog("google_drive"));
    mocks.resolveLinearActions.mockResolvedValue(providerCatalog("linear"));

    const catalog = await resolveGoatActionCatalog("user_1");
    expect(catalog.providers.map((provider) => provider.id)).toEqual([
      "slack",
      "google_drive",
      "linear",
    ]);
    expect(catalog.providers.map((provider) => provider.description)).toEqual([
      "slack description",
      "google_drive description",
      "linear description",
    ]);
    expect(catalog.actions.map((action) => action.id)).toEqual([
      "slack.read_something",
      "google_drive.read_something",
      "linear.read_something",
    ]);
  });

  it("keeps other providers when one resolver throws", async () => {
    mocks.resolveSlackActions.mockRejectedValue(new Error("boom"));
    mocks.resolveGmailActions.mockResolvedValue(providerCatalog("gmail"));
    mocks.resolveGoogleDriveActions.mockResolvedValue(null);
    mocks.resolveLinearActions.mockResolvedValue(null);

    const catalog = await resolveGoatActionCatalog("user_1");
    expect(catalog.providers.map((provider) => provider.id)).toEqual(["gmail"]);
  });

  it("returns an empty catalog when nothing is connected", async () => {
    mocks.resolveSlackActions.mockResolvedValue(null);
    mocks.resolveGmailActions.mockResolvedValue(null);
    mocks.resolveGoogleDriveActions.mockResolvedValue(null);
    mocks.resolveLinearActions.mockResolvedValue(null);

    const catalog = await resolveGoatActionCatalog("user_1");
    expect(catalog).toEqual({ providers: [], actions: [] });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dbRows: [] as unknown[],
  xApiCall: vi.fn(),
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: async () => mocks.dbRows,
          limit: async () => mocks.dbRows,
        }),
      }),
    }),
  }),
}));

vi.mock("../integrations/x", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../integrations/x")>();
  return { ...actual, xApiCall: mocks.xApiCall };
});

import type { GoatActionExecuteContext } from "./types";
import { resolveXActions } from "./x";

const CONTEXT: GoatActionExecuteContext = {
  userWorkosId: "user_1",
  signal: new AbortController().signal,
  currentDate: new Date("2026-08-04T12:00:00.000Z"),
  userTimezone: "UTC",
};

function connectedRow(overrides: Record<string, unknown> = {}) {
  return {
    integrationId: "gint_x_1",
    id: "gint_x_1",
    status: "connected",
    username: "@opencompany",
    connectionLabel: "@opencompany",
    displayName: "OpenCompany",
    accountName: "OpenCompany",
    scopes: ["tweet.read", "tweet.write", "users.read", "offline.access"],
    capabilityModes: {},
    ...overrides,
  };
}

function findCreatePost(catalog: Awaited<ReturnType<typeof resolveXActions>>) {
  const action = catalog?.actions.find((entry) => entry.id === "x.create_post");
  if (!action) throw new Error("missing x.create_post");
  return action;
}

beforeEach(() => {
  mocks.dbRows = [];
  mocks.xApiCall.mockReset();
});

describe("resolveXActions", () => {
  it("is absent unless a connected X account has posting scopes", async () => {
    expect(await resolveXActions("user_1")).toBeNull();

    mocks.dbRows = [connectedRow({ status: "needs_reauth" })];
    expect(await resolveXActions("user_1")).toBeNull();

    mocks.dbRows = [connectedRow({ scopes: ["tweet.read", "users.read"] })];
    expect(await resolveXActions("user_1")).toBeNull();
  });

  it("exposes plain-text posting as ask by default", async () => {
    mocks.dbRows = [connectedRow()];
    const catalog = await resolveXActions("user_1");
    const action = findCreatePost(catalog);

    expect(catalog).toMatchObject({
      id: "x",
      label: "X (@opencompany)",
      description: "Create plain-text posts from your connected X account.",
    });
    expect(action).toMatchObject({
      id: "x.create_post",
      provider: "x",
      capability: "write",
      permissionMode: "ask",
      permission: {
        provider: "x",
        capabilityId: "write",
        label: "Post to X",
        integrationIds: ["gint_x_1"],
      },
      params: {
        type: "object",
        additionalProperties: false,
        required: ["text"],
      },
    });
  });

  it("omits posting when the connection permission is off", async () => {
    mocks.dbRows = [connectedRow({ capabilityModes: { write: "off" } })];
    expect(await resolveXActions("user_1")).toBeNull();
  });
});

describe("x.create_post", () => {
  it("creates a post and returns the canonical X URL", async () => {
    mocks.dbRows = [connectedRow()];
    mocks.xApiCall.mockResolvedValue({ data: { id: "12345", text: "Hello from Goat" } });

    const action = findCreatePost(await resolveXActions("user_1"));
    const result = await action.execute({ text: "Hello from Goat" }, CONTEXT);

    expect(mocks.xApiCall).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      integrationId: "gint_x_1",
      path: "/tweets",
      method: "POST",
      body: { text: "Hello from Goat" },
      signal: CONTEXT.signal,
    });
    expect(result).toEqual({
      account: "@opencompany",
      integrationId: "gint_x_1",
      postId: "12345",
      text: "Hello from Goat",
      url: "https://x.com/opencompany/status/12345",
    });
  });
});

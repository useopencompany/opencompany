import { describe, expect, it, vi } from "vitest";
import type { GoatActionExecuteContext, ResolvedGoatAction } from "./types";
import { resolveXAccountActions } from "./x-account";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  xAccountApiCall: vi.fn(),
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: mocks.getDb,
}));

vi.mock("../integrations/x-access-token", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../integrations/x-access-token")>()),
  xAccountApiCall: mocks.xAccountApiCall,
}));

describe("resolveXAccountActions", () => {
  it("posts a tweet from the single connected account", async () => {
    mocks.getDb.mockImplementation(() =>
      fakeDb({
        connectionRows: [
          {
            integrationId: "gint_x_1",
            connectionLabel: "@jane",
            accountName: "Jane Doe",
            status: "connected",
            capabilityModes: { write: "on" },
          },
        ],
        statusRows: [{ status: "connected", capabilityModes: { write: "on" } }],
      }),
    );
    mocks.xAccountApiCall.mockResolvedValue({
      data: { id: "tweet_1", text: "Shipping something new today." },
    });

    const catalog = await resolveXAccountActions("user_1");
    const postTweet = findAction(catalog!.actions, "x_account.post_tweet");
    const context = actionContext();

    const result = await postTweet.execute({ text: "Shipping something new today." }, context);

    expect(result).toMatchObject({
      account: "@jane",
      integrationId: "gint_x_1",
      tweet: {
        id: "tweet_1",
        text: "Shipping something new today.",
        url: "https://x.com/jane/status/tweet_1",
      },
    });
    expect(mocks.xAccountApiCall).toHaveBeenCalledWith(
      { userWorkosId: "user_1", integrationId: "gint_x_1" },
      "POST",
      new URL("https://api.x.com/2/tweets"),
      expect.objectContaining({ body: { text: "Shipping something new today." } }),
    );
  });

  it("requires an account name when multiple accounts are connected", async () => {
    mocks.getDb.mockImplementation(() =>
      fakeDb({
        connectionRows: [
          {
            integrationId: "gint_x_1",
            connectionLabel: "@jane",
            accountName: "Jane Doe",
            status: "connected",
            capabilityModes: { write: "on" },
          },
          {
            integrationId: "gint_x_2",
            connectionLabel: "@acme",
            accountName: "Acme Co",
            status: "connected",
            capabilityModes: { write: "on" },
          },
        ],
        statusRows: [],
      }),
    );

    const catalog = await resolveXAccountActions("user_1");
    const postTweet = findAction(catalog!.actions, "x_account.post_tweet");

    await expect(postTweet.execute({ text: "hello" }, actionContext())).rejects.toThrow(
      /Multiple X accounts/,
    );
  });

  it("omits the catalog entirely when posting is turned off", async () => {
    mocks.getDb.mockImplementation(() =>
      fakeDb({
        connectionRows: [
          {
            integrationId: "gint_x_1",
            connectionLabel: "@jane",
            accountName: "Jane Doe",
            status: "connected",
            capabilityModes: { write: "off" },
          },
        ],
        statusRows: [],
      }),
    );

    expect(await resolveXAccountActions("user_1")).toBeNull();
  });
});

function findAction(actions: ResolvedGoatAction[], id: string) {
  const action = actions.find((candidate) => candidate.id === id);
  if (!action) throw new Error(`Missing action ${id}`);
  return action;
}

function actionContext(): GoatActionExecuteContext {
  return {
    userWorkosId: "user_1",
    signal: new AbortController().signal,
    currentDate: new Date("2026-08-04T00:00:00.000Z"),
    userTimezone: "UTC",
  };
}

function fakeDb(input: { connectionRows: unknown[]; statusRows: unknown[] }): {
  select: ReturnType<typeof vi.fn>;
} {
  return {
    select: vi.fn(() => {
      const builder = {
        from: vi.fn(() => builder),
        where: vi.fn(() => builder),
        orderBy: vi.fn(async () => input.connectionRows),
        limit: vi.fn(async () => input.statusRows),
      };
      return builder;
    }),
  };
}

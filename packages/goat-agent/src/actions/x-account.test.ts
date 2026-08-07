import { beforeEach, describe, expect, it, vi } from "vitest";
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
  beforeEach(() => {
    mocks.getDb.mockReset();
    mocks.xAccountApiCall.mockReset();
  });

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

    expect(result).toEqual({
      status: "posted",
      posts: [
        {
          account: "@jane",
          integrationId: "gint_x_1",
          tweet: {
            id: "tweet_1",
            text: "Shipping something new today.",
            url: "https://x.com/jane/status/tweet_1",
          },
        },
      ],
      failures: [],
    });
    expect(mocks.xAccountApiCall).toHaveBeenCalledWith(
      { userWorkosId: "user_1", integrationId: "gint_x_1" },
      "POST",
      new URL("https://api.x.com/2/tweets"),
      expect.objectContaining({ body: { text: "Shipping something new today." } }),
    );
  });

  it("posts account-specific copy to both selected accounts in one action", async () => {
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
        statusRows: [{ status: "connected", capabilityModes: { write: "on" } }],
      }),
    );
    mocks.xAccountApiCall.mockImplementation(
      async ({ integrationId }: { integrationId: string }) => ({
        data: {
          id: integrationId === "gint_x_1" ? "tweet_jane" : "tweet_acme",
          text:
            integrationId === "gint_x_1"
              ? "I am proud of what our team shipped today."
              : "Meet Acme's newest release, built for busy founders.",
        },
      }),
    );

    const catalog = await resolveXAccountActions("user_1");
    const postTweet = findAction(catalog!.actions, "x_account.post_tweet");

    expect(postTweet.params).toMatchObject({
      required: ["posts"],
      properties: {
        posts: {
          type: "array",
          minItems: 1,
          maxItems: 2,
          items: {
            type: "object",
            required: ["account", "text"],
            properties: {
              account: { type: "string", enum: ["@jane", "@acme"] },
              text: { type: "string" },
            },
          },
        },
      },
    });

    const result = await postTweet.execute(
      {
        posts: [
          { account: "@jane", text: "I am proud of what our team shipped today." },
          { account: "@acme", text: "Meet Acme's newest release, built for busy founders." },
        ],
      },
      actionContext(),
    );

    expect(result).toEqual({
      status: "posted",
      posts: [
        {
          account: "@jane",
          integrationId: "gint_x_1",
          tweet: {
            id: "tweet_jane",
            text: "I am proud of what our team shipped today.",
            url: "https://x.com/jane/status/tweet_jane",
          },
        },
        {
          account: "@acme",
          integrationId: "gint_x_2",
          tweet: {
            id: "tweet_acme",
            text: "Meet Acme's newest release, built for busy founders.",
            url: "https://x.com/acme/status/tweet_acme",
          },
        },
      ],
      failures: [],
    });
    expect(mocks.xAccountApiCall).toHaveBeenCalledTimes(2);
    expect(mocks.xAccountApiCall).toHaveBeenCalledWith(
      { userWorkosId: "user_1", integrationId: "gint_x_1" },
      "POST",
      new URL("https://api.x.com/2/tweets"),
      expect.objectContaining({ body: { text: "I am proud of what our team shipped today." } }),
    );
    expect(mocks.xAccountApiCall).toHaveBeenCalledWith(
      { userWorkosId: "user_1", integrationId: "gint_x_2" },
      "POST",
      new URL("https://api.x.com/2/tweets"),
      expect.objectContaining({
        body: { text: "Meet Acme's newest release, built for busy founders." },
      }),
    );
  });

  it("requires explicit targets and rejects duplicates with multiple accounts", async () => {
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
      /"posts" is required/,
    );
    await expect(
      postTweet.execute(
        {
          posts: [
            { account: "@jane", text: "Founder perspective." },
            { account: "jane", text: "Company perspective." },
          ],
        },
        actionContext(),
      ),
    ).rejects.toThrow(/must not contain duplicate accounts/);
    expect(mocks.xAccountApiCall).not.toHaveBeenCalled();
  });

  it("rejects identical or substantially similar cross-account posts before dispatch", async () => {
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

    await expect(
      postTweet.execute(
        {
          posts: [
            { account: "@jane", text: "We just shipped our new founder toolkit today!" },
            {
              account: "@acme",
              text: "We just shipped our new founder toolkit today for teams. https://acme.example",
            },
          ],
        },
        actionContext(),
      ),
    ).rejects.toThrow(/identical or substantially similar/);
    expect(mocks.xAccountApiCall).not.toHaveBeenCalled();
  });

  it("preserves a successful post when another selected account fails", async () => {
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
        statusRows: [{ status: "connected", capabilityModes: { write: "on" } }],
      }),
    );
    mocks.xAccountApiCall.mockImplementation(
      async ({ integrationId }: { integrationId: string }) => {
        if (integrationId === "gint_x_2") throw new Error("X API request failed with 403.");
        return { data: { id: "tweet_jane", text: "I am proud of what our team shipped today." } };
      },
    );

    const catalog = await resolveXAccountActions("user_1");
    const postTweet = findAction(catalog!.actions, "x_account.post_tweet");
    const result = await postTweet.execute(
      {
        posts: [
          { account: "@jane", text: "I am proud of what our team shipped today." },
          { account: "@acme", text: "Meet Acme's newest release, built for busy founders." },
        ],
      },
      actionContext(),
    );

    expect(result).toEqual({
      status: "partial",
      posts: [
        {
          account: "@jane",
          integrationId: "gint_x_1",
          tweet: {
            id: "tweet_jane",
            text: "I am proud of what our team shipped today.",
            url: "https://x.com/jane/status/tweet_jane",
          },
        },
      ],
      failures: [
        {
          account: "@acme",
          integrationId: "gint_x_2",
          error: "X API request failed with 403.",
        },
      ],
    });
  });

  it("revalidates every selected account before dispatching any post", async () => {
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
        statusRows: [{ status: "connected", capabilityModes: { write: "off" } }],
      }),
    );

    const catalog = await resolveXAccountActions("user_1");
    const postTweet = findAction(catalog!.actions, "x_account.post_tweet");

    await expect(
      postTweet.execute(
        {
          posts: [
            { account: "@jane", text: "I am proud of what our team shipped today." },
            { account: "@acme", text: "Meet Acme's newest release, built for busy founders." },
          ],
        },
        actionContext(),
      ),
    ).rejects.toThrow(/Posting to X is turned off/);
    expect(mocks.xAccountApiCall).not.toHaveBeenCalled();
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

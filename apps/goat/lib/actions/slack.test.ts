import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  slackApiRequest: vi.fn(),
  loadCredential: vi.fn(),
  dbRows: [] as unknown[],
}));

vi.mock("@/lib/integrations/slack", () => ({
  slackApiRequest: mocks.slackApiRequest,
}));
vi.mock("@opencompany/db/goat-integrations", () => ({
  loadGoatIntegrationCredential: mocks.loadCredential,
}));
vi.mock("@opencompany/db/client", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({ limit: async () => mocks.dbRows }),
        }),
      }),
    }),
  }),
}));

import { resolveSlackActions } from "@/lib/actions/slack";
import { GoatActionAuthError, type GoatActionExecuteContext } from "@/lib/actions/types";

const CONTEXT: GoatActionExecuteContext = {
  userWorkosId: "user_1",
  signal: new AbortController().signal,
  currentDate: new Date("2026-07-18T00:00:00.000Z"),
  userTimezone: "UTC",
};

function connectedRow(scopes: string[]) {
  return { id: "gint_1", status: "connected", connectionLabel: "Acme", scopes };
}

beforeEach(() => {
  mocks.dbRows = [connectedRow([])];
  mocks.loadCredential.mockReset();
  mocks.loadCredential.mockResolvedValue({
    payload: { access_token: "xoxp-1", team_domain: "acme" },
  });
  mocks.slackApiRequest.mockReset();
});

describe("resolveSlackActions", () => {
  it("is absent when Slack is not connected", async () => {
    mocks.dbRows = [];
    expect(await resolveSlackActions("user_1")).toBeNull();
    mocks.dbRows = [{ ...connectedRow([]), status: "needs_reauth" }];
    expect(await resolveSlackActions("user_1")).toBeNull();
  });

  it("registers the search action only for search-scoped connections", async () => {
    mocks.dbRows = [connectedRow(["search:read"])];
    const withSearch = await resolveSlackActions("user_1");
    expect(withSearch?.actions.map((action) => action.id)).toContain("slack.search_messages");
    expect(withSearch?.label).toBe('Slack workspace "Acme"');

    mocks.dbRows = [connectedRow(["channels:history"])];
    const withoutSearch = await resolveSlackActions("user_1");
    expect(withoutSearch?.actions.map((action) => action.id)).toEqual([
      "slack.list_conversations",
      "slack.fetch_history",
      "slack.fetch_thread",
      "slack.list_users",
    ]);
  });

  it("does not touch the credential during resolution", async () => {
    mocks.loadCredential.mockClear();
    mocks.dbRows = [connectedRow([])];
    await resolveSlackActions("user_1");
    expect(mocks.loadCredential).not.toHaveBeenCalled();
  });

  it("throws an auth error on execute when the credential is unusable", async () => {
    mocks.dbRows = [connectedRow([])];
    mocks.loadCredential.mockResolvedValueOnce(null);
    const catalog = await resolveSlackActions("user_1");
    const history = catalog?.actions.find((action) => action.id === "slack.fetch_history");
    await expect(history?.execute({ channel: "C1234567" }, CONTEXT)).rejects.toBeInstanceOf(
      GoatActionAuthError,
    );
  });

  it("fetches history with the expected Slack method and truncates + permalinks messages", async () => {
    mocks.dbRows = [connectedRow([])];
    mocks.loadCredential.mockResolvedValue({
      payload: { access_token: "xoxp-1", team_domain: "acme" },
    });
    mocks.slackApiRequest.mockResolvedValueOnce({
      messages: [{ ts: "1234.5678", user: "U1", text: "y".repeat(900) }],
    });

    const catalog = await resolveSlackActions("user_1");
    const history = catalog?.actions.find((action) => action.id === "slack.fetch_history");
    const result = (await history?.execute({ channel: "C1234567", limit: 5 }, CONTEXT)) as {
      messages: Array<{ text?: string; url?: string }>;
    };

    expect(mocks.slackApiRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "conversations.history",
        token: "xoxp-1",
        form: expect.objectContaining({ channel: "C1234567", limit: "5" }),
      }),
    );
    expect(mocks.slackApiRequest).toHaveBeenCalledTimes(1);
    expect(result.messages[0]?.text?.length).toBe(701);
    expect(result.messages[0]?.url).toBe("https://acme.slack.com/archives/C1234567/p12345678");
  });

  it.each([
    "engineering",
    "#Engineering",
  ])("resolves a channel name before fetching history: %s", async (channel) => {
    mocks.slackApiRequest
      .mockResolvedValueOnce({
        channels: [{ id: "CENGINE1", name: "engineering" }],
        response_metadata: { next_cursor: "" },
      })
      .mockResolvedValueOnce({ messages: [] });

    const catalog = await resolveSlackActions("user_1");
    const history = catalog?.actions.find((action) => action.id === "slack.fetch_history");
    await history?.execute({ channel }, CONTEXT);

    expect(mocks.slackApiRequest).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: "conversations.list",
        form: expect.objectContaining({ limit: "200", exclude_archived: "true" }),
      }),
    );
    expect(mocks.slackApiRequest).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "conversations.history",
        form: expect.objectContaining({ channel: "CENGINE1" }),
      }),
    );
  });

  it("paginates channel-name resolution until a match is found", async () => {
    mocks.slackApiRequest
      .mockResolvedValueOnce({
        channels: [{ id: "CGENERAL1", name: "general" }],
        response_metadata: { next_cursor: "page_2" },
      })
      .mockResolvedValueOnce({
        channels: [{ id: "CENGINE1", name: "engineering" }],
        response_metadata: { next_cursor: "" },
      })
      .mockResolvedValueOnce({ messages: [] });

    const catalog = await resolveSlackActions("user_1");
    const history = catalog?.actions.find((action) => action.id === "slack.fetch_history");
    await history?.execute({ channel: "engineering" }, CONTEXT);

    expect(mocks.slackApiRequest).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "conversations.list",
        form: expect.objectContaining({ cursor: "page_2" }),
      }),
    );
    expect(mocks.slackApiRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: "conversations.history",
        form: expect.objectContaining({ channel: "CENGINE1" }),
      }),
    );
  });

  it("reports how many conversations were searched when a name is not found", async () => {
    mocks.slackApiRequest.mockResolvedValueOnce({
      channels: [
        { id: "CGENERAL1", name: "general" },
        { id: "CRANDOM12", name: "random" },
      ],
      response_metadata: { next_cursor: "" },
    });

    const catalog = await resolveSlackActions("user_1");
    const history = catalog?.actions.find((action) => action.id === "slack.fetch_history");

    await expect(history?.execute({ channel: "engineering" }, CONTEXT)).rejects.toThrow(
      "across 2 conversations",
    );
    await expect(history?.execute({ channel: "engineering" }, CONTEXT)).rejects.toThrow(
      "slack.list_conversations",
    );
    expect(mocks.slackApiRequest).toHaveBeenCalledTimes(1);
  });

  it("memoizes the channel-name index across history and thread actions", async () => {
    mocks.slackApiRequest
      .mockResolvedValueOnce({
        channels: [{ id: "CENGINE1", name: "engineering" }],
        response_metadata: { next_cursor: "" },
      })
      .mockResolvedValueOnce({ messages: [] })
      .mockResolvedValueOnce({ messages: [] });
    const catalog = await resolveSlackActions("user_1");
    const history = catalog?.actions.find((action) => action.id === "slack.fetch_history");
    const thread = catalog?.actions.find((action) => action.id === "slack.fetch_thread");

    await history?.execute({ channel: "engineering" }, CONTEXT);
    await thread?.execute({ channel: "#engineering", thread_ts: "1234.5" }, CONTEXT);

    expect(mocks.slackApiRequest.mock.calls.map(([input]) => input.method)).toEqual([
      "conversations.list",
      "conversations.history",
      "conversations.replies",
    ]);
  });

  it("passes list cursors through and returns the next cursor", async () => {
    mocks.slackApiRequest.mockResolvedValueOnce({
      channels: [{ id: "CGENERAL1", name: "general" }],
      response_metadata: { next_cursor: "cursor_2" },
    });
    const catalog = await resolveSlackActions("user_1");
    const list = catalog?.actions.find((action) => action.id === "slack.list_conversations");

    const result = (await list?.execute({ limit: 25, cursor: "cursor_1" }, CONTEXT)) as {
      next_cursor?: string;
    };

    expect(mocks.slackApiRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        form: expect.objectContaining({ cursor: "cursor_1", limit: "25" }),
      }),
    );
    expect(result.next_cursor).toBe("cursor_2");
  });

  it("rejects missing required params before any provider call", async () => {
    mocks.dbRows = [connectedRow([])];
    mocks.loadCredential.mockResolvedValue({
      payload: { access_token: "xoxp-1", team_domain: "acme" },
    });
    mocks.slackApiRequest.mockClear();
    const catalog = await resolveSlackActions("user_1");
    const thread = catalog?.actions.find((action) => action.id === "slack.fetch_thread");
    await expect(thread?.execute({ channel: "C1234567" }, CONTEXT)).rejects.toThrow("thread_ts");
    expect(mocks.slackApiRequest).not.toHaveBeenCalled();
  });
});

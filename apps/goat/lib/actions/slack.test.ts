import { describe, expect, it, vi } from "vitest";

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
};

function connectedRow(scopes: string[]) {
  return { id: "gint_1", status: "connected", connectionLabel: "Acme", scopes };
}

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
    await expect(history?.execute({ channel: "C123" }, CONTEXT)).rejects.toBeInstanceOf(
      GoatActionAuthError,
    );
  });

  it("fetches history with the expected Slack method and truncates + permalinks messages", async () => {
    mocks.dbRows = [connectedRow([])];
    mocks.loadCredential.mockResolvedValue({
      payload: { access_token: "xoxp-1", team_id: "T123", team_domain: "acme" },
    });
    mocks.slackApiRequest.mockResolvedValueOnce({
      messages: [{ ts: "1234.5678", user: "U1", text: "y".repeat(900) }],
      response_metadata: { next_cursor: "cursor_2" },
    });

    const catalog = await resolveSlackActions("user_1");
    const history = catalog?.actions.find((action) => action.id === "slack.fetch_history");
    const result = (await history?.execute(
      { channel: "C123", limit: 5, cursor: "cursor_1" },
      CONTEXT,
    )) as {
      integrationId: string;
      nextCursor?: string;
      messages: Array<{ text?: string; url?: string; sourceRef?: string; integrationId?: string }>;
    };

    expect(mocks.slackApiRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "conversations.history",
        token: "xoxp-1",
        form: expect.objectContaining({ channel: "C123", limit: "5", cursor: "cursor_1" }),
      }),
    );
    expect(result.messages[0]?.text?.length).toBe(701);
    expect(result.messages[0]?.url).toBe("https://acme.slack.com/archives/C123/p12345678");
    expect(result.messages[0]?.sourceRef).toBe("slack:conversation:T123:C123:1234.5678");
    expect(result.messages[0]?.integrationId).toBe("gint_1");
    expect(result.integrationId).toBe("gint_1");
    expect(result.nextCursor).toBe("cursor_2");
  });

  it("rejects missing required params before any provider call", async () => {
    mocks.dbRows = [connectedRow([])];
    mocks.loadCredential.mockResolvedValue({
      payload: { access_token: "xoxp-1", team_id: "T123", team_domain: "acme" },
    });
    mocks.slackApiRequest.mockClear();
    const catalog = await resolveSlackActions("user_1");
    const thread = catalog?.actions.find((action) => action.id === "slack.fetch_thread");
    await expect(thread?.execute({ channel: "C123" }, CONTEXT)).rejects.toThrow("thread_ts");
    expect(mocks.slackApiRequest).not.toHaveBeenCalled();
  });
});

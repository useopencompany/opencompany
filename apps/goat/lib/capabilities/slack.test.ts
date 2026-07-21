import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  slackApiRequest: vi.fn(),
  loadCredential: vi.fn(),
  dbRows: [] as unknown[],
}));

vi.mock("@/lib/integrations/slack", () => ({ slackApiRequest: mocks.slackApiRequest }));
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

import { slackCapability } from "@/lib/capabilities/slack";
import {
  GoatCapabilityAuthError,
  type GoatCapabilityWorkerContext,
} from "@/lib/capabilities/types";

const CONTEXT: GoatCapabilityWorkerContext = {
  userWorkosId: "user_1",
  signal: new AbortController().signal,
  currentDate: new Date("2026-07-18T00:00:00.000Z"),
  userContext: { email: "ada@example.com", firstName: "Ada", lastName: null, timezone: "UTC" },
};

function connectedRow(scopes: string[]) {
  return { id: "gint_1", status: "connected", connectionLabel: "Acme", scopes };
}

describe("slackCapability.resolve", () => {
  it("is absent when Slack is not connected", async () => {
    mocks.dbRows = [];
    expect(await slackCapability.resolve("user_1")).toBeNull();
    mocks.dbRows = [{ ...connectedRow([]), status: "needs_reauth" }];
    expect(await slackCapability.resolve("user_1")).toBeNull();
  });

  it("advertises keyword search only when the stored scopes include it", async () => {
    mocks.dbRows = [connectedRow(["channels:history", "search:read"])];
    const withSearch = await slackCapability.resolve("user_1");
    expect(withSearch?.indexLine).toContain("CAN keyword-search messages");

    mocks.dbRows = [connectedRow(["channels:history", "users:read"])];
    const withoutSearch = await slackCapability.resolve("user_1");
    expect(withoutSearch?.indexLine).toContain("CANNOT keyword-search");
    expect(withoutSearch?.indexLine).toContain("reconnecting Slack in Settings");
  });
});

describe("slack capability tools", () => {
  it("throws an auth error when the credential is unusable", async () => {
    mocks.dbRows = [connectedRow([])];
    mocks.loadCredential.mockResolvedValueOnce(null);
    const resolved = await slackCapability.resolve("user_1");
    await expect(resolved?.createTools(CONTEXT, "read")).rejects.toBeInstanceOf(
      GoatCapabilityAuthError,
    );
  });

  it("registers the search tool only for search-scoped connections", async () => {
    mocks.loadCredential.mockResolvedValue({
      payload: { access_token: "xoxp-1", team_domain: "acme" },
    });

    mocks.dbRows = [connectedRow(["search:read"])];
    const withSearch = await (await slackCapability.resolve("user_1"))?.createTools(
      CONTEXT,
      "read",
    );
    expect(Object.keys(withSearch?.tools ?? {})).toContain("slack_search_messages");

    mocks.dbRows = [connectedRow(["channels:history"])];
    const withoutSearch = await (await slackCapability.resolve("user_1"))?.createTools(
      CONTEXT,
      "read",
    );
    expect(Object.keys(withoutSearch?.tools ?? {})).toEqual([
      "slack_list_conversations",
      "slack_fetch_history",
      "slack_fetch_thread",
      "slack_list_users",
    ]);
  });

  it("fetches history with the expected Slack method and truncates + permalinks messages", async () => {
    mocks.dbRows = [connectedRow([])];
    mocks.loadCredential.mockResolvedValue({
      payload: { access_token: "xoxp-1", team_domain: "acme" },
    });
    mocks.slackApiRequest.mockResolvedValueOnce({
      messages: [{ ts: "1234.5678", user: "U1", text: "y".repeat(900) }],
    });

    const toolkit = await (await slackCapability.resolve("user_1"))?.createTools(CONTEXT, "read");
    const history = toolkit?.tools.slack_fetch_history as {
      execute: (
        args: unknown,
        options: unknown,
      ) => Promise<{
        messages: Array<{ text?: string; url?: string }>;
      }>;
    };
    const output = await history.execute(
      { channel: "C1", oldest_iso: "2026-07-17T00:00:00.000Z", limit: 500 },
      { toolCallId: "t1", messages: [] },
    );

    expect(mocks.slackApiRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "conversations.history",
        token: "xoxp-1",
        signal: CONTEXT.signal,
        form: expect.objectContaining({
          channel: "C1",
          limit: "30",
          oldest: String(Date.parse("2026-07-17T00:00:00.000Z") / 1000),
        }),
      }),
    );
    expect(output.messages[0]?.text).toHaveLength(701); // 700 + ellipsis
    expect(output.messages[0]?.url).toBe("https://acme.slack.com/archives/C1/p12345678");
  });
});

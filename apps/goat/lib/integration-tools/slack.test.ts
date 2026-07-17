import { describe, expect, it, vi } from "vitest";
import type { ResolvedSlackAccount } from "@/lib/integration-tools/connections";
import { findIntegrationToolDefinition } from "@/lib/integration-tools/registry";
import { createSlackIntegrationToolExecutor } from "@/lib/integration-tools/slack";

vi.mock("@opencompany/db/client", () => ({ getDb: () => ({}) }));

const SEARCH_TOOL = findIntegrationToolDefinition("slack_search_messages")!;
const HISTORY_TOOL = findIntegrationToolDefinition("slack_get_channel_history")!;

const ACCOUNT: ResolvedSlackAccount = {
  integrationId: "gint_1",
  teamId: "T123",
  teamName: "Acme",
  scopes: ["channels:history", "channels:read", "users:read"],
};

function createExecutor(input: {
  accounts?: ResolvedSlackAccount[];
  api?: ReturnType<typeof vi.fn>;
}) {
  const api = input.api ?? vi.fn();
  return {
    api,
    executor: createSlackIntegrationToolExecutor({
      userWorkosId: "user_1",
      accounts: input.accounts ?? [ACCOUNT],
      api: api as never,
      loadCredential: vi
        .fn()
        .mockResolvedValue({ payload: { access_token: "xoxp-test" } }) as never,
    }),
  };
}

describe("createSlackIntegrationToolExecutor", () => {
  it("blocks search when the connection lacks search:read but keeps history working", async () => {
    const api = vi.fn().mockResolvedValue({ messages: [] });
    const { executor } = createExecutor({ api });

    await expect(executor({ tool: SEARCH_TOOL, args: { query: "launch" } })).rejects.toThrow(
      /search:read.*Reconnect Slack/s,
    );
    expect(api).not.toHaveBeenCalledWith(expect.objectContaining({ method: "search.messages" }));

    const history = await executor({ tool: HISTORY_TOOL, args: { channel: "C12345678" } });
    expect(history).toEqual({ channel: "C12345678", messages: [] });
    expect(api).toHaveBeenCalledWith(expect.objectContaining({ method: "conversations.history" }));
  });

  it("searches when search:read was granted", async () => {
    const api = vi.fn().mockResolvedValue({
      messages: {
        total: 1,
        matches: [
          {
            text: "ship it",
            ts: "1720000000.1",
            username: "dana",
            permalink: "https://slack.example/p1",
            channel: { id: "C1", name: "product" },
          },
        ],
      },
    });
    const { executor } = createExecutor({
      accounts: [{ ...ACCOUNT, scopes: [...ACCOUNT.scopes, "search:read"] }],
      api,
    });
    const output = await executor({ tool: SEARCH_TOOL, args: { query: "ship", limit: 5 } });
    expect(output).toEqual({
      total: 1,
      matches: [
        {
          channel: "product",
          user: "dana",
          text: "ship it",
          ts: "1720000000.1",
          permalink: "https://slack.example/p1",
        },
      ],
    });
    expect(api).toHaveBeenCalledWith({
      method: "search.messages",
      token: "xoxp-test",
      form: { query: "ship", count: "5" },
    });
  });

  it("maps Slack's missing_scope error to the reconnect message", async () => {
    const api = vi
      .fn()
      .mockRejectedValue(new Error("Slack API search.messages returned missing_scope."));
    const { executor } = createExecutor({
      accounts: [{ ...ACCOUNT, scopes: [...ACCOUNT.scopes, "search:read"] }],
      api,
    });
    await expect(executor({ tool: SEARCH_TOOL, args: { query: "x" } })).rejects.toThrow(
      /Reconnect Slack in Settings/,
    );
  });

  it("requires an account argument when multiple workspaces are connected", async () => {
    const { executor } = createExecutor({
      accounts: [
        ACCOUNT,
        { ...ACCOUNT, integrationId: "gint_2", teamId: "T999", teamName: "Beta" },
      ],
    });
    await expect(executor({ tool: HISTORY_TOOL, args: { channel: "C12345678" } })).rejects.toThrow(
      /Multiple Slack workspaces are connected \(Acme, Beta\)/,
    );
  });

  it("matches the account argument against team name and id", async () => {
    const api = vi.fn().mockResolvedValue({ messages: [] });
    const { executor } = createExecutor({
      accounts: [
        ACCOUNT,
        { ...ACCOUNT, integrationId: "gint_2", teamId: "T999", teamName: "Beta" },
      ],
      api,
    });
    await executor({ tool: HISTORY_TOOL, args: { channel: "C12345678", account: "beta" } });
    await executor({ tool: HISTORY_TOOL, args: { channel: "C12345678", account: "T123" } });
    expect(api).toHaveBeenCalledTimes(2);
  });

  it("rejects unknown account references with the connected list", async () => {
    const { executor } = createExecutor({});
    await expect(
      executor({ tool: HISTORY_TOOL, args: { channel: "C12345678", account: "nope" } }),
    ).rejects.toThrow(/No connected Slack workspace matches "nope". Connected: Acme./);
  });
});

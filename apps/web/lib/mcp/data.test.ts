import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadWorkspaceMcpSettingsForWorkspace } from "@/lib/mcp/data";

const db = vi.hoisted(() => ({
  queryResults: [] as unknown[][],
  select: vi.fn(),
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: () => db,
}));

beforeEach(() => {
  vi.clearAllMocks();
  db.queryResults = [];
  db.select.mockImplementation(() => ({
    from: vi.fn(() => ({
      innerJoin: vi.fn(() => ({
        where: vi.fn(() => queryResult(db.queryResults.shift() ?? [])),
      })),
      where: vi.fn(() => queryResult(db.queryResults.shift() ?? [])),
    })),
  }));
});

describe("loadWorkspaceMcpSettingsForWorkspace", () => {
  it("reports MCP provider configured states independently", async () => {
    db.queryResults = [
      [
        mcpServerRow("wmcps_linear", "linear", "configured"),
        mcpServerRow("wmcps_slack", "slack", "configured"),
        mcpServerRow("wmcps_posthog", "posthog", "configured"),
        mcpServerRow("wmcps_betterstack", "betterstack", "configured"),
        mcpServerRow("wmcps_braintrust", "braintrust", "configured"),
        mcpServerRow("wmcps_notion", "notion", "configured"),
      ],
      [
        mcpCredentialRow("linear", "bearer_token"),
        mcpCredentialRow("slack", "oauth", {
          accountKey: "slack_acme",
          accountLabel: "Acme",
          connectedByUserId: "usr_123",
        }),
        mcpCredentialRow("posthog", "oauth"),
        mcpCredentialRow("betterstack", "oauth"),
        mcpCredentialRow("braintrust", "oauth"),
        mcpCredentialRow("notion", "oauth"),
      ],
    ];

    const settings = await loadWorkspaceMcpSettingsForWorkspace("wks_123");

    expect(settings.linear).toMatchObject({
      configured: true,
      serverId: "wmcps_linear",
      status: "configured",
    });
    expect(settings.slack).toMatchObject({
      configured: true,
      serverId: "wmcps_slack",
      status: "configured",
      accounts: [{ accountKey: "slack_acme", label: "Acme" }],
    });
    expect(settings.posthog).toMatchObject({
      configured: true,
      serverId: "wmcps_posthog",
      status: "configured",
    });
    expect(settings.betterstack).toMatchObject({
      configured: true,
      serverId: "wmcps_betterstack",
      status: "configured",
    });
    expect(settings.braintrust).toMatchObject({
      configured: true,
      serverId: "wmcps_braintrust",
      status: "configured",
    });
    expect(settings.notion).toMatchObject({
      configured: true,
      serverId: "wmcps_notion",
      status: "configured",
    });
  });

  it("does not treat Linear credentials as Slack credentials", async () => {
    db.queryResults = [
      [
        mcpServerRow("wmcps_linear", "linear", "configured"),
        mcpServerRow("wmcps_slack", "slack", "configured"),
      ],
      [mcpCredentialRow("linear", "oauth")],
    ];

    const settings = await loadWorkspaceMcpSettingsForWorkspace("wks_123");

    expect(settings.linear.configured).toBe(true);
    expect(settings.slack.configured).toBe(false);
  });

  it("ignores unfinished non-default Slack OAuth credentials", async () => {
    db.queryResults = [
      [mcpServerRow("wmcps_slack", "slack", "configured")],
      [mcpCredentialRow("slack", "oauth", { accountKey: "acct_pending" })],
    ];

    const settings = await loadWorkspaceMcpSettingsForWorkspace("wks_123");

    expect(settings.slack.configured).toBe(false);
    expect(settings.slack.accounts).toEqual([]);
  });
});

function mcpServerRow(
  id: string,
  serverKey: "linear" | "slack" | "posthog" | "betterstack" | "braintrust" | "notion",
  status: "configured" | "missing_credential" | "disabled" | "error",
) {
  return {
    id,
    serverKey,
    status,
    statusReason: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function queryResult(result: unknown[]) {
  return {
    limit: vi.fn(async () => result),
    then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
}

function mcpCredentialRow(
  serverKey: "linear" | "slack" | "posthog" | "betterstack" | "braintrust" | "notion",
  kind: string,
  overrides: Partial<{
    accountKey: string;
    externalAccountId: string | null;
    accountLabel: string | null;
    accountEmail: string | null;
    connectedByUserId: string | null;
    credentialUpdatedAt: Date;
    metadata: Record<string, unknown>;
  }> = {},
) {
  return {
    serverKey,
    kind,
    accountKey: "default",
    externalAccountId: null,
    accountLabel: null,
    accountEmail: null,
    connectedByUserId: null,
    credentialUpdatedAt: new Date("2026-01-01T00:00:00.000Z"),
    metadata: {},
    ...overrides,
  };
}

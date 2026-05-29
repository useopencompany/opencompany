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
  it("reports Linear and Slack MCP configured states independently", async () => {
    db.queryResults = [
      [{ enabled: true }],
      [
        mcpServerRow("wmcps_linear", "linear", "configured"),
        mcpServerRow("wmcps_slack", "slack", "configured"),
      ],
      [
        { serverKey: "linear", kind: "bearer_token" },
        { serverKey: "slack", kind: "oauth" },
      ],
    ];

    const settings = await loadWorkspaceMcpSettingsForWorkspace("wks_123");

    expect(settings.mcpEnabled).toBe(true);
    expect(settings.linear).toMatchObject({
      configured: true,
      serverId: "wmcps_linear",
      status: "configured",
    });
    expect(settings.slack).toMatchObject({
      configured: true,
      serverId: "wmcps_slack",
      status: "configured",
    });
  });

  it("does not treat Linear credentials as Slack credentials", async () => {
    db.queryResults = [
      [{ enabled: true }],
      [
        mcpServerRow("wmcps_linear", "linear", "configured"),
        mcpServerRow("wmcps_slack", "slack", "configured"),
      ],
      [{ serverKey: "linear", kind: "oauth" }],
    ];

    const settings = await loadWorkspaceMcpSettingsForWorkspace("wks_123");

    expect(settings.linear.configured).toBe(true);
    expect(settings.slack.configured).toBe(false);
  });
});

function mcpServerRow(
  id: string,
  serverKey: "linear" | "slack",
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

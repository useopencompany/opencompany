import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getGoatLinearIntegrationState: vi.fn(async () => ({ connected: true })),
  loadGoatLinearMcpWorkerConnection: vi.fn(),
  createMCPClient: vi.fn(),
}));

vi.mock("@/lib/integrations/linear-mcp", () => ({
  GOAT_LINEAR_MCP_ENDPOINT_URL: "https://mcp.linear.app/mcp",
  getGoatLinearIntegrationState: mocks.getGoatLinearIntegrationState,
  loadGoatLinearMcpWorkerConnection: mocks.loadGoatLinearMcpWorkerConnection,
}));
vi.mock("@ai-sdk/mcp", () => ({
  createMCPClient: mocks.createMCPClient,
}));

import { normalizeLinearListIssuesInput, resolveLinearActions } from "@/lib/actions/linear";
import { GoatActionAuthError, type GoatActionExecuteContext } from "@/lib/actions/types";

const CONTEXT: GoatActionExecuteContext = {
  userWorkosId: "user_1",
  signal: new AbortController().signal,
  currentDate: new Date("2026-07-18T00:00:00.000Z"),
};

function mockClient(remoteTools: Record<string, { execute?: unknown }>) {
  const close = vi.fn(async () => {});
  mocks.createMCPClient.mockResolvedValue({
    listTools: vi.fn(async () => ({})),
    toolsFromDefinitions: vi.fn(() => remoteTools),
    close,
  });
  return { close };
}

describe("normalizeLinearListIssuesInput", () => {
  it("drops model placeholder values that Linear treats as active filters", () => {
    expect(
      normalizeLinearListIssuesInput({
        limit: 100,
        cursor: "",
        orderBy: "updatedAt",
        query: "",
        team: "Goat",
        state: "Todo",
        cycle: "",
        label: "",
        assignee: null,
        delegate: "",
        project: "company brain",
        release: "",
        priority: 0,
        parentId: "",
        createdAt: "",
        updatedAt: "",
        includeArchived: false,
      }),
    ).toEqual({
      limit: 100,
      orderBy: "updatedAt",
      team: "Goat",
      state: "Todo",
      project: "company brain",
      includeArchived: false,
    });
  });

  it("maps explicit unassigned and no-priority filters to Linear sentinels", () => {
    expect(
      normalizeLinearListIssuesInput({
        team: "Goat",
        unassigned: true,
        unprioritized: true,
      }),
    ).toEqual({ team: "Goat", assignee: null, priority: 0 });
  });

  it("rejects contradictory explicit filters", () => {
    expect(() => normalizeLinearListIssuesInput({ assignee: "me", unassigned: true })).toThrow(
      "Choose either an assignee or unassigned issues",
    );
    expect(() => normalizeLinearListIssuesInput({ priority: 2, unprioritized: true })).toThrow(
      "Choose either a priority or unprioritized issues",
    );
  });
});

describe("resolveLinearActions", () => {
  it("is absent when Linear is not connected", async () => {
    mocks.getGoatLinearIntegrationState.mockResolvedValueOnce({ connected: false });
    expect(await resolveLinearActions("user_1")).toBeNull();
  });

  it("exposes a static read-only catalog without touching the MCP server", async () => {
    mocks.createMCPClient.mockClear();
    const catalog = await resolveLinearActions("user_1");
    const ids = catalog?.actions.map((action) => action.id) ?? [];
    expect(ids).toContain("linear.list_issues");
    expect(ids).toContain("linear.get_issue");
    expect(ids).toContain("linear.list_teams");
    expect(ids.every((id) => !/create|update|delete|save/.test(id))).toBe(true);
    expect(mocks.createMCPClient).not.toHaveBeenCalled();
  });
});

describe("linear action execution", () => {
  it("maps auth failures to GoatActionAuthError", async () => {
    mocks.loadGoatLinearMcpWorkerConnection.mockResolvedValueOnce({
      ok: false,
      reason: "not_connected",
    });
    const catalog = await resolveLinearActions("user_1");
    const listIssues = catalog?.actions.find((action) => action.id === "linear.list_issues");
    await expect(listIssues?.execute({}, CONTEXT)).rejects.toBeInstanceOf(GoatActionAuthError);
  });

  it("normalizes list_issues input, calls the remote tool, and closes the client", async () => {
    mocks.loadGoatLinearMcpWorkerConnection.mockResolvedValue({
      ok: true,
      integrationId: "gint_linear_1",
      authProvider: {},
    });
    const remoteExecute = vi.fn(async () => ({
      content: [{ type: "text", text: '{"issues":[{"identifier":"ENG-1"}]}' }],
    }));
    const { close } = mockClient({ list_issues: { execute: remoteExecute } });

    const catalog = await resolveLinearActions("user_1");
    const listIssues = catalog?.actions.find((action) => action.id === "linear.list_issues");
    const result = await listIssues?.execute(
      { team: "Goat", assignee: null, priority: 0 },
      CONTEXT,
    );

    expect(remoteExecute).toHaveBeenCalledWith({ team: "Goat" }, expect.anything());
    expect(result).toEqual({
      integrationId: "gint_linear_1",
      issues: [
        {
          identifier: "ENG-1",
          sourceRef: "linear:issue:ENG-1",
          integrationId: "gint_linear_1",
        },
      ],
    });
    expect(close).toHaveBeenCalled();
  });

  it("fails as a provider error when the remote tool is missing and still closes the client", async () => {
    mocks.loadGoatLinearMcpWorkerConnection.mockResolvedValue({
      ok: true,
      integrationId: "gint_linear_1",
      authProvider: {},
    });
    const { close } = mockClient({});

    const catalog = await resolveLinearActions("user_1");
    const getIssue = catalog?.actions.find((action) => action.id === "linear.get_issue");
    await expect(getIssue?.execute({ id: "ENG-1" }, CONTEXT)).rejects.toThrow(
      'no longer exposes the "get_issue" tool',
    );
    expect(close).toHaveBeenCalled();
  });

  it("surfaces MCP isError results as thrown provider errors", async () => {
    mocks.loadGoatLinearMcpWorkerConnection.mockResolvedValue({
      ok: true,
      integrationId: "gint_linear_1",
      authProvider: {},
    });
    const remoteExecute = vi.fn(async () => ({
      isError: true,
      content: [{ type: "text", text: "Team not found" }],
    }));
    mockClient({ list_issues: { execute: remoteExecute } });

    const catalog = await resolveLinearActions("user_1");
    const listIssues = catalog?.actions.find((action) => action.id === "linear.list_issues");
    await expect(listIssues?.execute({}, CONTEXT)).rejects.toThrow("Team not found");
  });
});

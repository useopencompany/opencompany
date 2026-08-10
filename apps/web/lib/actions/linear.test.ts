import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getGoatLinearIntegrationState: vi.fn(),
  loadGoatLinearMcpWorkerConnection: vi.fn(),
  createMCPClient: vi.fn(),
}));

vi.mock("@opencompany/goat-agent/integrations/linear-mcp", () => ({
  GOAT_LINEAR_MCP_ENDPOINT_URL: "https://mcp.linear.app/mcp",
  getGoatLinearIntegrationState: mocks.getGoatLinearIntegrationState,
  loadGoatLinearMcpWorkerConnection: mocks.loadGoatLinearMcpWorkerConnection,
}));
vi.mock("@ai-sdk/mcp", () => ({
  createMCPClient: mocks.createMCPClient,
}));

import {
  normalizeLinearCreateCommentInput,
  normalizeLinearCreateIssueInput,
  normalizeLinearListIssuesInput,
  normalizeLinearUpdateIssueInput,
  resolveLinearActions,
} from "@/lib/actions/linear";
import {
  GoatActionAuthError,
  type GoatActionExecuteContext,
  GoatActionPermissionError,
} from "@/lib/actions/types";

const CONTEXT: GoatActionExecuteContext = {
  userWorkosId: "user_1",
  signal: new AbortController().signal,
  currentDate: new Date("2026-07-18T00:00:00.000Z"),
  userTimezone: "UTC",
};
const LINEAR_MAX_MARKDOWN_BODY_CHARS = 249_999;

function connectedLinearState(capabilityModes: Record<string, unknown> = {}) {
  return {
    provider: "linear",
    connected: true,
    status: "connected",
    integrationId: "gint_linear_1",
    accountName: "Linear",
    statusReason: null,
    capabilityModes,
  };
}

function mockClient(remoteTools: Record<string, { execute?: unknown }>) {
  const close = vi.fn(async () => {});
  mocks.createMCPClient.mockResolvedValue({
    listTools: vi.fn(async () => ({})),
    toolsFromDefinitions: vi.fn(() => remoteTools),
    close,
  });
  return { close };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getGoatLinearIntegrationState.mockResolvedValue(connectedLinearState());
});

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

describe("normalizeLinearCreateIssueInput", () => {
  it("normalizes useful issue fields and deduplicates labels", () => {
    expect(
      normalizeLinearCreateIssueInput({
        title: "  Add export flow  ",
        team: " GOAT ",
        description: " Ship the first cut. ",
        assignee: " me ",
        state: " Todo ",
        project: " Company Brain ",
        priority: 2,
        labels: ["Feature", " feature ", "Customer"],
        parentId: " GOAT-10 ",
      }),
    ).toEqual({
      title: "Add export flow",
      team: "GOAT",
      description: "Ship the first cut.",
      assignee: "me",
      state: "Todo",
      project: "Company Brain",
      priority: 2,
      labels: ["Feature", "Customer"],
      parentId: "GOAT-10",
    });
  });

  it("requires a title and team and rejects unsafe or unknown fields", () => {
    expect(() => normalizeLinearCreateIssueInput({ team: "GOAT" })).toThrow('"title" is required');
    expect(() =>
      normalizeLinearCreateIssueInput({ title: "Ship", team: "GOAT", priority: 5 }),
    ).toThrow('"priority" must be an integer');
    expect(() =>
      normalizeLinearCreateIssueInput({ title: "Ship", team: "GOAT", deleteAll: true }),
    ).toThrow("Unknown parameter");
  });

  it("allows issue descriptions up to Linear's documented message body cap", () => {
    const description = "x".repeat(LINEAR_MAX_MARKDOWN_BODY_CHARS);
    expect(normalizeLinearCreateIssueInput({ title: "Ship", team: "GOAT", description })).toEqual({
      title: "Ship",
      team: "GOAT",
      description,
    });

    expect(() =>
      normalizeLinearCreateIssueInput({
        title: "Ship",
        team: "GOAT",
        description: `${description}x`,
      }),
    ).toThrow('"description" exceeds 249999 characters');
  });
});

describe("normalizeLinearUpdateIssueInput", () => {
  it("normalizes requested changes, supports cancellation, and preserves explicit clears", () => {
    expect(
      normalizeLinearUpdateIssueInput({
        id: " GOAT-123 ",
        title: " Ship Linear updates ",
        description: "  ",
        assignee: null,
        state: " Canceled ",
        project: null,
        priority: 0,
        labels: [],
      }),
    ).toEqual({
      id: "GOAT-123",
      title: "Ship Linear updates",
      description: "",
      assignee: null,
      state: "Canceled",
      project: null,
      priority: 0,
      labels: [],
    });
  });

  it("requires an identifier and at least one known field to update", () => {
    expect(() => normalizeLinearUpdateIssueInput({ state: "Done" })).toThrow('"id" is required');
    expect(() => normalizeLinearUpdateIssueInput({ id: "GOAT-123" })).toThrow(
      "at least one issue field",
    );
    expect(() => normalizeLinearUpdateIssueInput({ id: "GOAT-123", delete: true })).toThrow(
      "Unknown parameter",
    );
    expect(() => normalizeLinearUpdateIssueInput({ id: "GOAT-123", project: "" })).toThrow(
      '"project" must be a non-empty string',
    );
  });

  it("allows replacement descriptions up to Linear's documented message body cap", () => {
    const description = "x".repeat(LINEAR_MAX_MARKDOWN_BODY_CHARS);
    expect(normalizeLinearUpdateIssueInput({ id: "GOAT-123", description })).toEqual({
      id: "GOAT-123",
      description,
    });

    expect(() =>
      normalizeLinearUpdateIssueInput({ id: "GOAT-123", description: `${description}x` }),
    ).toThrow('"description" exceeds 249999 characters');
  });
});

describe("normalizeLinearCreateCommentInput", () => {
  it("normalizes the issue identifier and Markdown body", () => {
    expect(
      normalizeLinearCreateCommentInput({
        issueId: " GOAT-123 ",
        body: "  Shipped in #456.  ",
      }),
    ).toEqual({
      issueId: "GOAT-123",
      body: "Shipped in #456.",
    });
  });

  it("requires both fields and rejects unknown parameters", () => {
    expect(() => normalizeLinearCreateCommentInput({ issueId: "GOAT-123" })).toThrow(
      '"body" is required',
    );
    expect(() =>
      normalizeLinearCreateCommentInput({
        issueId: "GOAT-123",
        body: "Done",
        notifyAll: true,
      }),
    ).toThrow("Unknown parameter");
  });

  it("allows comments up to Linear's documented message body cap", () => {
    const body = "x".repeat(LINEAR_MAX_MARKDOWN_BODY_CHARS);
    expect(normalizeLinearCreateCommentInput({ issueId: "GOAT-123", body })).toEqual({
      issueId: "GOAT-123",
      body,
    });

    expect(() =>
      normalizeLinearCreateCommentInput({ issueId: "GOAT-123", body: `${body}x` }),
    ).toThrow('"body" exceeds 249999 characters');
  });
});

describe("resolveLinearActions", () => {
  it("is absent when Linear is not connected", async () => {
    mocks.getGoatLinearIntegrationState.mockResolvedValueOnce({
      ...connectedLinearState(),
      connected: false,
      status: "not_connected",
      integrationId: null,
    });
    expect(await resolveLinearActions("user_1")).toBeNull();
  });

  it("exposes read and ask-before-write actions without touching the MCP server", async () => {
    mocks.createMCPClient.mockClear();
    const catalog = await resolveLinearActions("user_1");
    const ids = catalog?.actions.map((action) => action.id) ?? [];
    expect(ids).toContain("linear.list_issues");
    expect(ids).toContain("linear.get_issue");
    expect(ids).toContain("linear.list_teams");
    expect(ids).toContain("linear.create_issue");
    expect(ids).toContain("linear.update_issue");
    expect(ids).toContain("linear.create_comment");
    expect(catalog?.actions.find((action) => action.id === "linear.create_issue")).toMatchObject({
      capability: "write",
      permissionMode: "ask",
      permission: {
        provider: "linear",
        capabilityId: "write",
        label: "Manage issues",
        integrationIds: ["gint_linear_1"],
      },
      params: {
        required: ["title", "team"],
        properties: {
          description: {
            maxLength: LINEAR_MAX_MARKDOWN_BODY_CHARS,
          },
        },
      },
    });
    expect(catalog?.actions.find((action) => action.id === "linear.update_issue")).toMatchObject({
      params: {
        properties: {
          description: {
            maxLength: LINEAR_MAX_MARKDOWN_BODY_CHARS,
          },
          project: {
            type: ["string", "null"],
          },
        },
      },
    });
    expect(catalog?.actions.find((action) => action.id === "linear.create_comment")).toMatchObject({
      params: {
        properties: {
          body: {
            maxLength: LINEAR_MAX_MARKDOWN_BODY_CHARS,
          },
        },
      },
    });
    expect(mocks.createMCPClient).not.toHaveBeenCalled();
  });

  it("honors read and write permission modes", async () => {
    mocks.getGoatLinearIntegrationState.mockResolvedValueOnce(
      connectedLinearState({ write: "on" }),
    );
    let catalog = await resolveLinearActions("user_1");
    expect(catalog?.actions.find((action) => action.id === "linear.create_issue")).toMatchObject({
      permissionMode: "on",
    });

    mocks.getGoatLinearIntegrationState.mockResolvedValueOnce(
      connectedLinearState({ write: "off" }),
    );
    catalog = await resolveLinearActions("user_1");
    expect(catalog?.actions.some((action) => action.capability === "write")).toBe(false);

    mocks.getGoatLinearIntegrationState.mockResolvedValueOnce(
      connectedLinearState({ read: "off" }),
    );
    catalog = await resolveLinearActions("user_1");
    expect(catalog?.actions.map((action) => action.id)).toEqual([
      "linear.create_issue",
      "linear.update_issue",
      "linear.create_comment",
    ]);

    mocks.getGoatLinearIntegrationState.mockResolvedValueOnce(
      connectedLinearState({ read: "off", write: "off" }),
    );
    expect(await resolveLinearActions("user_1")).toBeNull();
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

  it("creates an issue with selected fields and returns canonical source metadata", async () => {
    mocks.loadGoatLinearMcpWorkerConnection.mockResolvedValue({
      ok: true,
      integrationId: "gint_linear_1",
      authProvider: {},
    });
    const remoteExecute = vi.fn(async () => ({
      content: [
        {
          type: "text",
          text: '{"id":"issue_1","identifier":"GOAT-123","url":"https://linear.app/acme/issue/GOAT-123"}',
        },
      ],
    }));
    const { close } = mockClient({ save_issue: { execute: remoteExecute } });

    const catalog = await resolveLinearActions("user_1");
    const createIssue = catalog?.actions.find((action) => action.id === "linear.create_issue");
    const result = await createIssue?.execute(
      {
        title: " Add ticket creation ",
        team: " GOAT ",
        assignee: "me",
        priority: 2,
        labels: ["Feature"],
      },
      CONTEXT,
    );

    expect(remoteExecute).toHaveBeenCalledWith(
      {
        title: "Add ticket creation",
        team: "GOAT",
        assignee: "me",
        priority: 2,
        labels: ["Feature"],
      },
      expect.anything(),
    );
    expect(result).toEqual({
      id: "issue_1",
      identifier: "GOAT-123",
      url: "https://linear.app/acme/issue/GOAT-123",
      sourceRef: "linear:issue:GOAT-123",
      integrationId: "gint_linear_1",
    });
    expect(close).toHaveBeenCalled();
  });

  it("updates an issue through save_issue and returns canonical source metadata", async () => {
    mocks.loadGoatLinearMcpWorkerConnection.mockResolvedValue({
      ok: true,
      integrationId: "gint_linear_1",
      authProvider: {},
    });
    const remoteExecute = vi.fn(async () => ({
      content: [
        {
          type: "text",
          text: '{"id":"issue_1","identifier":"GOAT-123","state":{"name":"Canceled"}}',
        },
      ],
    }));
    const { close } = mockClient({ save_issue: { execute: remoteExecute } });

    const catalog = await resolveLinearActions("user_1");
    const updateIssue = catalog?.actions.find((action) => action.id === "linear.update_issue");
    const result = await updateIssue?.execute(
      {
        id: " GOAT-123 ",
        state: " Canceled ",
        description: " No longer planned. ",
      },
      CONTEXT,
    );

    expect(remoteExecute).toHaveBeenCalledWith(
      {
        id: "GOAT-123",
        state: "Canceled",
        description: "No longer planned.",
      },
      expect.anything(),
    );
    expect(result).toEqual({
      id: "issue_1",
      identifier: "GOAT-123",
      state: { name: "Canceled" },
      sourceRef: "linear:issue:GOAT-123",
      integrationId: "gint_linear_1",
    });
    expect(close).toHaveBeenCalled();
  });

  it("removes an issue's project through save_issue", async () => {
    mocks.loadGoatLinearMcpWorkerConnection.mockResolvedValue({
      ok: true,
      integrationId: "gint_linear_1",
      authProvider: {},
    });
    const remoteExecute = vi.fn(async () => ({
      content: [
        {
          type: "text",
          text: '{"id":"issue_1","identifier":"GOAT-123","project":null}',
        },
      ],
    }));
    const { close } = mockClient({ save_issue: { execute: remoteExecute } });

    const catalog = await resolveLinearActions("user_1");
    const updateIssue = catalog?.actions.find((action) => action.id === "linear.update_issue");
    const result = await updateIssue?.execute({ id: " GOAT-123 ", project: null }, CONTEXT);

    expect(remoteExecute).toHaveBeenCalledWith(
      {
        id: "GOAT-123",
        project: null,
      },
      expect.anything(),
    );
    expect(result).toEqual({
      id: "issue_1",
      identifier: "GOAT-123",
      project: null,
      sourceRef: "linear:issue:GOAT-123",
      integrationId: "gint_linear_1",
    });
    expect(close).toHaveBeenCalled();
  });

  it("adds a comment through save_comment", async () => {
    mocks.loadGoatLinearMcpWorkerConnection.mockResolvedValue({
      ok: true,
      integrationId: "gint_linear_1",
      authProvider: {},
    });
    const remoteExecute = vi.fn(async () => ({
      content: [{ type: "text", text: '{"id":"comment_1","body":"Shipped."}' }],
    }));
    const { close } = mockClient({ save_comment: { execute: remoteExecute } });

    const catalog = await resolveLinearActions("user_1");
    const createComment = catalog?.actions.find((action) => action.id === "linear.create_comment");
    const result = await createComment?.execute(
      { issueId: " GOAT-123 ", body: " Shipped. " },
      CONTEXT,
    );

    expect(remoteExecute).toHaveBeenCalledWith(
      { issueId: "GOAT-123", body: "Shipped." },
      expect.anything(),
    );
    expect(result).toEqual({ id: "comment_1", body: "Shipped." });
    expect(close).toHaveBeenCalled();
  });

  it("blocks a stale write when Linear writes were turned off after catalog resolution", async () => {
    const catalog = await resolveLinearActions("user_1");
    mocks.getGoatLinearIntegrationState.mockResolvedValueOnce(
      connectedLinearState({ write: "off" }),
    );
    const createIssue = catalog?.actions.find((action) => action.id === "linear.create_issue");

    await expect(
      createIssue?.execute({ title: "Should not happen", team: "GOAT" }, CONTEXT),
    ).rejects.toBeInstanceOf(GoatActionPermissionError);
    expect(mocks.createMCPClient).not.toHaveBeenCalled();
  });
});
